import fs from 'node:fs';
import path from 'node:path';
import { Bot, InputFile, InlineKeyboard } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import type { ChannelMessage } from '../types/channel.js';
import { BaseChannel } from './base.js';
import type { MercuryConfig } from '../utils/config.js';
import { saveConfig, clearTelegramPairing, setTelegramPairing } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { mdToTelegram } from '../utils/markdown.js';

const MAX_MESSAGE_LENGTH = 4096;

type ApprovalResolver = (response: 'yes' | 'always' | 'no') => void;

export class TelegramChannel extends BaseChannel {
  readonly type = 'telegram' as const;
  private bot: Bot | null = null;
  private ownerChatId: number | null = null;
  private typingInterval: NodeJS.Timeout | null = null;
  private chatCommandContext?: import('../capabilities/registry.js').ChatCommandContext;
  private pendingApprovals: Map<string, ApprovalResolver> = new Map();

  constructor(private config: MercuryConfig) {
    super();
    this.ownerChatId = config.channels.telegram.pairedChatId ?? null;
  }

  setChatCommandContext(ctx: import('../capabilities/registry.js').ChatCommandContext): void {
    this.chatCommandContext = ctx;
  }

  async start(): Promise<void> {
    const token = this.config.channels.telegram.botToken;
    if (!token) {
      logger.warn('Telegram bot token not set — skipping');
      return;
    }

    const bot = new Bot(token);
    bot.api.config.use(autoRetry());

    bot.on('message:text', async (ctx) => {
      const chatId = ctx.chat.id;
      const userId = ctx.from?.id;
      const text = ctx.message.text?.trim() || '';

      if (!userId) return;

      if (ctx.chat.type !== 'private') {
        await this.sendDirectMessage(chatId, 'This bot is only available in private one-to-one chats.');
        return;
      }

      if (!this.isPaired()) {
        await this.handleUnpairedMessage(userId, chatId, text, ctx.from?.username);
        return;
      }

      if (!this.isAuthorizedUser(userId)) {
        await this.sendDirectMessage(chatId, 'This bot is not available to you.');
        return;
      }

      this.ownerChatId = chatId;
      logger.info({ chatId, text: ctx.message.text?.slice(0, 50) }, 'Telegram message received');

      const command = text.toLowerCase();
      if (command === '/start' || command === '/pair') {
        await this.sendDirectMessage(chatId, this.getPairingStatusMessage());
        return;
      }

      if (command === '/unpair') {
        this.unpair();
        await this.sendDirectMessage(chatId, 'Telegram pairing removed. Send /start to pair this Mercury instance again.');
        return;
      }

      const msg: ChannelMessage = {
        id: ctx.message.message_id.toString(),
        channelId: `telegram:${chatId}`,
        channelType: 'telegram',
        senderId: ctx.from?.id.toString() ?? 'unknown',
        senderName: ctx.from?.first_name,
        content: ctx.message.text,
        timestamp: ctx.message.date * 1000,
        metadata: { chatId, messageId: ctx.message.message_id },
      };
      this.emit(msg);
    });

    bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;
      const resolver = this.pendingApprovals.get(data);
      if (!resolver) {
        await ctx.answerCallbackQuery({ text: 'Expired' });
        return;
      }

      this.pendingApprovals.delete(data);

      const action = data.split(':')[1] as 'yes' | 'always' | 'no';
      resolver(action);
      await ctx.answerCallbackQuery({ text: action === 'no' ? 'Denied' : 'Approved' });
    });

    bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    this.bot = bot;

    await bot.start({
      onStart: async (info) => {
        logger.info({ bot: info.username }, 'Telegram bot started — long polling active');
        this.ready = true;
        await this.registerCommands();
      },
    });
  }

  private async registerCommands(): Promise<void> {
    if (!this.bot) return;

    const commands = [
      { command: 'start', description: 'Pair this Telegram account to Mercury' },
      { command: 'pair', description: 'Pair this Telegram account to Mercury' },
      { command: 'help', description: 'Show capabilities and commands manual' },
      { command: 'status', description: 'Show agent config, budget, and uptime' },
      { command: 'tools', description: 'List all loaded tools' },
      { command: 'skills', description: 'List installed skills' },
      { command: 'budget', description: 'Show token budget status' },
      { command: 'budget_override', description: 'Override budget for one request' },
      { command: 'budget_reset', description: 'Reset token usage to zero' },
      { command: 'budget_set', description: 'Set new daily token budget' },
      { command: 'stream', description: 'Toggle text streaming on/off' },
      { command: 'unpair', description: 'Remove Telegram pairing for this Mercury instance' },
    ];

    try {
      await this.bot.api.setMyCommands(commands);
      logger.info({ count: commands.length }, 'Telegram bot commands registered');
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Failed to register Telegram commands (non-critical)');
    }
  }

  async stop(): Promise<void> {
    this.bot?.stop();
    this.ready = false;
    this.stopTypingLoop();
  }

  async send(content: string, targetId?: string, elapsedMs?: number): Promise<void> {
    const chatId = this.parseChatId(targetId);
    if (!chatId || !this.bot) {
      logger.warn({ targetId, chatId }, 'Telegram send: no valid chat ID');
      return;
    }
    const timeSuffix = elapsedMs != null ? `\n⏱ ${(elapsedMs / 1000).toFixed(1)}s` : '';
    const fullContent = content + timeSuffix;
    const html = mdToTelegram(fullContent);
    const chunks = this.splitMessage(html, MAX_MESSAGE_LENGTH);

    for (const chunk of chunks) {
      try {
        await this.bot.api.sendMessage(chatId, chunk, { parse_mode: 'HTML' });
      } catch (err: any) {
        logger.warn({ err: err.message }, 'HTML parse failed, sending as plain text');
        try {
          await this.bot.api.sendMessage(chatId, this.stripHtml(chunk));
        } catch (err2: any) {
          logger.error({ err: err2.message }, 'Telegram send failed');
        }
      }
    }
  }

  async sendFile(filePath: string, targetId?: string): Promise<void> {
    const chatId = this.parseChatId(targetId);
    if (!chatId || !this.bot) {
      logger.warn({ targetId, chatId }, 'Telegram sendFile: no valid chat ID');
      return;
    }
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      await this.bot.api.sendMessage(chatId, `File not found: ${filePath}`);
      return;
    }

    const inputFile = new InputFile(resolved);
    const filename = path.basename(resolved);
    const ext = path.extname(resolved).toLowerCase();

    try {
      if (this.isImageFile(ext)) {
        await this.bot.api.sendPhoto(chatId, inputFile, { caption: filename });
      } else if (this.isAudioFile(ext)) {
        await this.bot.api.sendAudio(chatId, inputFile, { title: filename });
      } else if (this.isVideoFile(ext)) {
        await this.bot.api.sendVideo(chatId, inputFile, { caption: filename });
      } else {
        await this.bot.api.sendDocument(chatId, inputFile, { caption: filename });
      }
      logger.info({ file: resolved, chatId }, 'File sent via Telegram');
    } catch (err: any) {
      logger.error({ err: err.message, file: resolved }, 'Telegram sendFile failed');
      await this.bot.api.sendMessage(chatId, `Failed to send file: ${err.message}`).catch(() => {});
    }
  }

  async stream(content: AsyncIterable<string>, targetId?: string): Promise<string> {
    const chatId = this.parseChatId(targetId);
    if (!chatId || !this.bot) return '';

    let full = '';
    for await (const chunk of content) {
      full += chunk;
    }
    const html = mdToTelegram(full);
    try {
      await this.bot.api.sendMessage(chatId, html, { parse_mode: 'HTML' });
    } catch (err: any) {
      await this.bot.api.sendMessage(chatId, this.stripHtml(html));
    }
    return full;
  }

  async typing(targetId?: string): Promise<void> {
    const chatId = this.parseChatId(targetId);
    if (!chatId || !this.bot) return;
    await this.bot.api.sendChatAction(chatId, 'typing');
  }

  startTypingLoop(chatId: number): void {
    this.stopTypingLoop();
    this.bot?.api.sendChatAction(chatId, 'typing').catch(() => {});
    this.typingInterval = setInterval(() => {
      this.bot?.api.sendChatAction(chatId, 'typing').catch(() => {});
    }, 4000);
  }

  stopTypingLoop(): void {
    if (this.typingInterval) {
      clearInterval(this.typingInterval);
      this.typingInterval = null;
    }
  }

  async sendStreamToChat(chatId: number, textStream: AsyncIterable<string>): Promise<string> {
    if (!this.bot) return '';

    const STREAM_EDIT_INTERVAL = 1500;
    const STREAM_MIN_LENGTH = 20;

    this.startTypingLoop(chatId);

    try {
      let full = '';
      let messageId: number | null = null;
      let lastEditTime = 0;
      let lastEditLength = 0;

      for await (const chunk of textStream) {
        full += chunk;

        const now = Date.now();
        const timeSinceLastEdit = now - lastEditTime;
        const charsSinceLastEdit = full.length - lastEditLength;

        if (messageId === null && full.length >= STREAM_MIN_LENGTH) {
          try {
            const msg = await this.bot.api.sendMessage(chatId, this.escapeHtml(full) + ' ▌', { parse_mode: 'HTML' });
            messageId = msg.message_id;
            lastEditTime = now;
            lastEditLength = full.length;
          } catch {
            messageId = null;
          }
        } else if (messageId !== null && timeSinceLastEdit >= STREAM_EDIT_INTERVAL && charsSinceLastEdit >= 20) {
          try {
            await this.bot.api.editMessageText(chatId, messageId, this.escapeHtml(full) + ' ▌', { parse_mode: 'HTML' });
            lastEditTime = now;
            lastEditLength = full.length;
          } catch {
            // edit failed — rate limited or message unchanged, skip
          }
        }
      }

      if (messageId !== null) {
        const html = mdToTelegram(full);
        try {
          await this.bot.api.editMessageText(chatId, messageId, html, { parse_mode: 'HTML' });
        } catch {
          try {
            await this.bot.api.editMessageText(chatId, messageId, this.stripHtml(html));
          } catch {
            // final edit failed
          }
        }
      } else {
        const html = mdToTelegram(full);
        try {
          await this.bot.api.sendMessage(chatId, html, { parse_mode: 'HTML' });
        } catch {
          await this.bot.api.sendMessage(chatId, this.stripHtml(html));
        }
      }

      return full;
    } finally {
      this.stopTypingLoop();
    }
  }

  async askPermission(prompt: string, targetId?: string): Promise<string> {
    const chatId = this.parseChatId(targetId);
    if (!chatId || !this.bot) return 'no';

    const id = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const keyboard = new InlineKeyboard()
      .text('Allow', `${id}:yes`)
      .text('Always', `${id}:always`)
      .text('Deny', `${id}:no`);

    const html = mdToTelegram(prompt);

    try {
      await this.bot.api.sendMessage(chatId, html, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    } catch {
      await this.bot.api.sendMessage(chatId, this.stripHtml(html), {
        reply_markup: keyboard,
      });
    }

    return new Promise((resolve) => {
      this.pendingApprovals.set(`${id}:yes`, () => resolve('yes'));
      this.pendingApprovals.set(`${id}:always`, () => resolve('always'));
      this.pendingApprovals.set(`${id}:no`, () => resolve('no'));

      setTimeout(() => {
        this.pendingApprovals.delete(`${id}:yes`);
        this.pendingApprovals.delete(`${id}:always`);
        this.pendingApprovals.delete(`${id}:no`);
        resolve('no');
      }, 120_000);
    });
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  private splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      let splitAt = maxLen;
      if (remaining.length > maxLen) {
        const lastNewline = remaining.lastIndexOf('\n', maxLen);
        if (lastNewline > maxLen * 0.5) {
          splitAt = lastNewline + 1;
        }
      }
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt);
    }
    return chunks;
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<\/?(b|i|s|u|code|pre|a|blockquote|strong|em)[^>]*>/gi, '')
      .replace(/<pre><code[^>]*>/gi, '')
      .replace(/<\/code><\/pre>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  private isImageFile(ext: string): boolean {
    return ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'].includes(ext);
  }

  private isAudioFile(ext: string): boolean {
    return ['.mp3', '.ogg', '.wav', '.flac', '.m4a'].includes(ext);
  }

  private isVideoFile(ext: string): boolean {
    return ['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(ext);
  }

  private parseChatId(targetId?: string): number | null {
    if (!targetId) return this.ownerChatId ?? this.config.channels.telegram.pairedChatId ?? null;
    if (targetId.startsWith('telegram:')) {
      const raw = Number(targetId.split(':')[1]);
      return isNaN(raw) ? this.ownerChatId ?? this.config.channels.telegram.pairedChatId ?? null : raw;
    }
    if (targetId === 'notification') return this.ownerChatId ?? this.config.channels.telegram.pairedChatId ?? null;
    const num = Number(targetId);
    return isNaN(num) ? this.ownerChatId ?? this.config.channels.telegram.pairedChatId ?? null : num;
  }

  private isPaired(): boolean {
    return typeof this.config.channels.telegram.pairedUserId === 'number';
  }

  private isAuthorizedUser(userId: number): boolean {
    return this.config.channels.telegram.pairedUserId === userId;
  }

  private async handleUnpairedMessage(userId: number, chatId: number, text: string, username?: string): Promise<void> {
    const command = text.toLowerCase();
    if (command === '/start' || command === '/pair') {
      setTelegramPairing(this.config, userId, chatId, username);
      saveConfig(this.config);
      this.ownerChatId = chatId;
      logger.info({ chatId, userId, username }, 'Telegram paired to owner');
      await this.sendDirectMessage(chatId, this.getPairingStatusMessage(true));
      return;
    }

    await this.sendDirectMessage(
      chatId,
      'This Mercury instance is not paired yet. Send /start to pair this bot to your Telegram account.',
    );
  }

  private getPairingStatusMessage(newlyPaired: boolean = false): string {
    const username = this.config.channels.telegram.pairedUsername
      ? ` (@${this.config.channels.telegram.pairedUsername})`
      : '';
    const prefix = newlyPaired ? 'Telegram paired successfully.' : 'This Telegram account is already paired.';
    return `${prefix}\n\nOwner user ID: ${this.config.channels.telegram.pairedUserId}${username}`;
  }

  private unpair(): void {
    clearTelegramPairing(this.config);
    saveConfig(this.config);
    this.ownerChatId = null;
    logger.info('Telegram pairing cleared');
  }

  private async sendDirectMessage(chatId: number, content: string): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.api.sendMessage(chatId, mdToTelegram(content), { parse_mode: 'HTML' });
    } catch {
      await this.bot.api.sendMessage(chatId, content).catch(() => {});
    }
  }
}
