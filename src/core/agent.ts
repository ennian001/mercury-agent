import { generateText, streamText } from 'ai';
import type { ChannelMessage, ChannelType } from '../types/channel.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { Identity } from '../soul/identity.js';
import type { ShortTermMemory, LongTermMemory, EpisodicMemory } from '../memory/store.js';
import type { ChannelRegistry } from '../channels/registry.js';
import type { MercuryConfig } from '../utils/config.js';
import type { TokenBudget } from '../utils/tokens.js';
import type { CapabilityRegistry } from '../capabilities/registry.js';
import type { ScheduledTaskManifest } from './scheduler.js';
import { Lifecycle } from './lifecycle.js';
import { Scheduler } from './scheduler.js';
import { logger } from '../utils/logger.js';
import { CLIChannel } from '../channels/cli.js';
import type { ArrowSelectOption } from '../utils/arrow-select.js';
import {
  approveTelegramPendingRequest,
  approveTelegramPendingRequestByPairingCode,
  clearTelegramAccess,
  demoteTelegramAdmin,
  getTelegramAccessSummary,
  getTelegramApprovedUsers,
  getTelegramPendingRequests,
  promoteTelegramUserToAdmin,
  rejectTelegramPendingRequest,
  removeTelegramUser,
  saveConfig,
} from '../utils/config.js';

class ToolCallLoopDetector {
  private recentCalls: Array<{ tool: string; params: string }> = [];
  private maxEntries = 16;
  private aborted = false;

  private static readonly HIGH_TOLERANCE_TOOLS = new Set([
    'fetch_url',
    'read_file',
    'list_dir',
    'web_search',
    'github_api',
  ]);

  private static getSameToolThreshold(toolName: string): number {
    return ToolCallLoopDetector.HIGH_TOLERANCE_TOOLS.has(toolName) ? 6 : 3;
  }

  record(toolName: string, params: Record<string, any>): void {
    const paramsKey = JSON.stringify(params).slice(0, 100);
    this.recentCalls.push({ tool: toolName, params: paramsKey });
    if (this.recentCalls.length > this.maxEntries) {
      this.recentCalls.shift();
    }
  }

  detect(): { tool: string; count: number; message: string } | null {
    if (this.recentCalls.length < 3) return null;

    const last = this.recentCalls[this.recentCalls.length - 1];

    let identicalCount = 0;
    for (let i = this.recentCalls.length - 1; i >= 0; i--) {
      if (this.recentCalls[i].tool === last.tool && this.recentCalls[i].params === last.params) {
        identicalCount++;
      } else {
        break;
      }
    }

    if (identicalCount >= 3) {
      this.aborted = true;
      return {
        tool: last.tool,
        count: identicalCount,
        message: `You called "${last.tool}" ${identicalCount} times with the same parameters and got the same result. This is a loop — stop repeating this call entirely.`,
      };
    }

    const lastTool = last.tool;
    let sameToolCount = 0;
    for (let i = this.recentCalls.length - 1; i >= 0; i--) {
      if (this.recentCalls[i].tool === lastTool) {
        sameToolCount++;
      } else {
        break;
      }
    }

    const threshold = ToolCallLoopDetector.getSameToolThreshold(lastTool);
    if (sameToolCount >= threshold) {
      this.aborted = true;
      return {
        tool: lastTool,
        count: sameToolCount,
        message: `You called "${lastTool}" ${sameToolCount} times in a row with different parameters and it isn't producing useful progress. Stop — the approach is wrong. Step back, tell the user what you tried, what failed, and suggest alternatives.`,
      };
    }

    return null;
  }

  isAborted(): boolean {
    return this.aborted;
  }

  reset(): void {
    this.recentCalls = [];
    this.aborted = false;
  }
}

const MAX_STEPS = 10;

export class Agent {
  readonly lifecycle: Lifecycle;
  readonly scheduler: Scheduler;
  readonly capabilities: CapabilityRegistry;
  private running = false;
  private messageQueue: ChannelMessage[] = [];
  private processing = false;
  private telegramStreaming: boolean;

  constructor(
    private config: MercuryConfig,
    private providers: ProviderRegistry,
    private identity: Identity,
    private shortTerm: ShortTermMemory,
    private longTerm: LongTermMemory,
    private episodic: EpisodicMemory,
    private channels: ChannelRegistry,
    private tokenBudget: TokenBudget,
    capabilities: CapabilityRegistry,
    scheduler: Scheduler,
  ) {
    this.lifecycle = new Lifecycle();
    this.scheduler = scheduler;
    this.capabilities = capabilities;
    this.telegramStreaming = config.channels.telegram.streaming ?? true;

    this.scheduler.setOnScheduledTask(async (manifest) => this.handleScheduledTask(manifest));

    this.channels.onIncomingMessage((msg) => this.enqueueMessage(msg));

    this.scheduler.onHeartbeat(async () => {
      await this.heartbeat();
    });
  }

  private enqueueMessage(msg: ChannelMessage): void {
    logger.info({ from: msg.channelType, content: msg.content.slice(0, 50) }, 'Message enqueued');
    this.messageQueue.push(msg);
    this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    if (this.messageQueue.length === 0) return;
    if (!this.lifecycle.is('idle')) return;

    this.processing = true;

    while (this.messageQueue.length > 0) {
      const msg = this.messageQueue.shift()!;
      try {
        await this.handleMessage(msg);
      } catch (err) {
        logger.error({ err, msg: msg.content.slice(0, 50) }, 'Failed to handle message');
      }
    }

    this.processing = false;
  }

  async birth(): Promise<void> {
    this.lifecycle.transition('birthing');
    logger.info({ name: this.config.identity.name }, 'Mercury is being born...');
    this.lifecycle.transition('onboarding');
  }

  async wake(): Promise<void> {
    this.lifecycle.transition('onboarding');
    this.lifecycle.transition('idle');
    this.scheduler.restorePersistedTasks();
    this.scheduler.startHeartbeat();
    await this.channels.startAll();
    this.running = true;

    const activeChannels = this.channels.getActiveChannels();
    const toolNames = this.capabilities.getToolNames();
    logger.info({ channels: activeChannels, tools: toolNames }, 'Mercury is awake');
  }

  async sleep(): Promise<void> {
    this.running = false;
    this.scheduler.stopAll();
    await this.channels.stopAll();
    this.lifecycle.transition('sleeping');
    logger.info('Mercury is sleeping');
  }

  private async handleMessage(msg: ChannelMessage): Promise<void> {
    this.lifecycle.transition('thinking');
    const startTime = Date.now();

      const isInternal = msg.channelType === 'internal';
      const isScheduled = msg.senderId === 'system' && msg.channelType !== 'internal';
      if (isInternal || isScheduled) {
        this.capabilities.permissions.setAutoApproveAll(true);
      }

    try {
      const trimmed = msg.content.trim();
      if (trimmed.startsWith('/budget')) {
        const subcommand = trimmed.slice('/budget'.length).trim();
        await this.handleBudgetCommand(subcommand || 'status', msg.channelType, msg.channelId);
        this.lifecycle.transition('idle');
        return;
      }

      if (trimmed === '/budget_override') {
        await this.handleBudgetCommand('override', msg.channelType, msg.channelId);
        this.lifecycle.transition('idle');
        return;
      }
      if (trimmed === '/budget_reset') {
        await this.handleBudgetCommand('reset', msg.channelType, msg.channelId);
        this.lifecycle.transition('idle');
        return;
      }
      if (trimmed.startsWith('/budget_set')) {
        const args = trimmed.slice('/budget_set'.length).trim();
        await this.handleBudgetCommand('set ' + args, msg.channelType, msg.channelId);
        this.lifecycle.transition('idle');
        return;
      }
      if (trimmed.startsWith('/stream')) {
        const sub = trimmed.slice('/stream'.length).trim().toLowerCase();
        if (sub === 'off') {
          this.telegramStreaming = false;
        } else if (sub === 'on') {
          this.telegramStreaming = true;
        } else {
          this.telegramStreaming = !this.telegramStreaming;
        }
        const ch = this.channels.get(msg.channelType as any);
        if (ch) await ch.send(
          this.telegramStreaming
            ? 'Telegram streaming enabled. Responses will appear progressively.'
            : 'Telegram streaming disabled. Responses will arrive as a single message.',
          msg.channelId,
        );
        this.lifecycle.transition('idle');
        return;
      }

      if (await this.handleChatCommand(trimmed, msg.channelType, msg.channelId)) {
        this.lifecycle.transition('idle');
        return;
      }

      if (this.tokenBudget.isOverBudget()) {
        const channel = this.channels.getChannelForMessage(msg);
        if (channel && msg.channelType !== 'internal') {
          if (msg.channelType === 'cli') {
            if (['1', '2', '3', '4'].includes(trimmed)) {
              await this.handleBudgetCommand(trimmed, msg.channelType, msg.channelId);
              this.lifecycle.transition('idle');
              return;
            }
            await this.handleBudgetOverrideCLI(channel, msg);
          } else {
            await channel.send(
              `I've exceeded my daily token budget (${this.tokenBudget.getStatusText()}).\n\nYou can override this:\n• /budget override — allow one more request\n• /budget reset — reset usage to zero\n• /budget set <number> — change daily budget`,
              msg.channelId,
            );
          }
        }
        this.lifecycle.transition('idle');
        return;
      }

      const systemPrompt = this.buildSystemPrompt();
      const recentMemory = this.shortTerm.getRecent(msg.channelId, 10);
      const relevantFacts = this.longTerm.search(msg.content, 3);

      const messages: any[] = [];

      const recentSteps = this.shortTerm.getRecent(msg.channelId, 4);
      let loopWarning: string | null = null;
      if (recentSteps.length >= 3) {
        const toolCallPattern = /\[Using: (.+?)\]/g;
        const toolCalls: string[] = [];
        for (const m of recentSteps) {
          if (m.role === 'assistant') {
            let match;
            while ((match = toolCallPattern.exec(m.content)) !== null) {
              toolCalls.push(match[1]);
            }
          }
        }
        if (toolCalls.length >= 3) {
          const last3 = toolCalls.slice(-3);
          if (last3[0] === last3[1] && last3[1] === last3[2]) {
            loopWarning = `[SYSTEM WARNING] In previous turns you called ${last3[0]} repeatedly. Do NOT call it again. If something failed, explain the failure to the user and suggest alternatives.`;
          }
        }
      }

      if (loopWarning) {
        messages.push({ role: 'user', content: loopWarning });
        messages.push({ role: 'assistant', content: 'Understood. I will try a different approach.' });
      }

      if (relevantFacts.length > 0) {
        messages.push({
          role: 'user',
          content: 'Relevant facts from memory:\n' + relevantFacts.map(f => `- ${f.fact}`).join('\n'),
        });
        messages.push({ role: 'assistant', content: 'Noted. I\'ll use these facts.' });
      }

      if (recentMemory.length > 0) {
        for (const m of recentMemory) {
          messages.push({
            role: m.role === 'user' ? 'user' : 'assistant',
            content: m.content,
          });
        }
      }

      messages.push({ role: 'user', content: msg.content });

      this.lifecycle.transition('responding');

      const channel = this.channels.getChannelForMessage(msg);
      if (channel) {
        await channel.typing(msg.channelId).catch(() => {});
      }

      this.capabilities.setChannelContext(msg.channelId, msg.channelType);
      this.capabilities.permissions.setCurrentChannelType(msg.channelType);

      const fallbackIterator = this.providers.getFallbackIterator();
      let result: any = null;
      let usedProvider: { name: string; model: string } | null = null;
      let lastError: any = null;
      let streamedText = '';
      const loopDetector = new ToolCallLoopDetector();
      const loopAbortController = new AbortController();
      let loopWarningSent = false;

      const canStream = msg.channelType === 'cli' || (msg.channelType === 'telegram' && this.telegramStreaming);

      for (const provider of fallbackIterator) {
        try {
          logger.info({ provider: provider.name, model: provider.getModel(), steps: MAX_STEPS, stream: canStream }, 'Generating agentic response');

          if (canStream && channel) {
            const streamResult = streamText({
              model: provider.getModelInstance(),
              system: systemPrompt,
              messages,
              tools: this.capabilities.getTools(),
              maxSteps: MAX_STEPS,
              abortSignal: loopAbortController.signal,
              onStepFinish: async ({ toolCalls }) => {
                if (toolCalls && toolCalls.length > 0) {
                  const names = toolCalls.map((tc: any) => tc.toolName).join(', ');
                  logger.info({ tools: names }, 'Tool call step');
                  for (const tc of toolCalls) {
                    loopDetector.record(tc.toolName, tc.args as Record<string, any>);
                  }
                  const loop = loopDetector.detect();
                  if (loop) {
                    logger.warn({ tool: loop.tool, count: loop.count }, 'Tool call loop detected — aborting generation');
                    if (!loopWarningSent && channel && msg.channelType !== 'internal') {
                      loopWarningSent = true;
                      await channel.send(`⚠ Loop detected — ${loop.tool} called ${loop.count}x in a row. Stopping to save tokens.`, msg.channelId).catch(() => {});
                    }
                    loopAbortController.abort();
                  }
                  await channel.send(`  [Using: ${names}]`, msg.channelId).catch(() => {});
                }
              },
            });

            let fullText: string;

            if (msg.channelType === 'telegram') {
              const tgChannel = this.channels.get('telegram');
              if (tgChannel && 'sendStreamToChat' in tgChannel) {
                const chatId = msg.channelId.startsWith('telegram:')
                  ? Number(msg.channelId.split(':')[1])
                  : Number(msg.channelId);
                if (!isNaN(chatId)) {
                  fullText = await (tgChannel as any).sendStreamToChat(chatId, streamResult.textStream);
                } else {
                  fullText = await channel.stream(streamResult.textStream, msg.channelId);
                }
              } else {
                fullText = await channel.stream(streamResult.textStream, msg.channelId);
              }
            } else {
              fullText = await channel.stream(streamResult.textStream, msg.channelId);
            }

            const [usage] = await Promise.all([
              streamResult.usage,
            ]);

            result = { text: fullText, usage };
            streamedText = fullText;
          } else {
            result = await generateText({
              model: provider.getModelInstance(),
              system: systemPrompt,
              messages,
              tools: this.capabilities.getTools(),
              maxSteps: MAX_STEPS,
              abortSignal: loopAbortController.signal,
              onStepFinish: async ({ toolCalls, text }) => {
                if (toolCalls && toolCalls.length > 0) {
                  const names = toolCalls.map((tc: any) => tc.toolName).join(', ');
                  logger.info({ tools: names }, 'Tool call step');
                  for (const tc of toolCalls) {
                    loopDetector.record(tc.toolName, tc.args as Record<string, any>);
                  }
                  const loop = loopDetector.detect();
                  if (loop) {
                    logger.warn({ tool: loop.tool, count: loop.count }, 'Tool call loop detected — aborting generation');
                    if (!loopWarningSent && channel && msg.channelType !== 'internal') {
                      loopWarningSent = true;
                      await channel.send(`⚠ Loop detected — ${loop.tool} called ${loop.count}x in a row. Stopping to save tokens.`, msg.channelId).catch(() => {});
                    }
                    loopAbortController.abort();
                  }
                  if (channel && msg.channelType !== 'internal') {
                    await channel.send(`  [Using: ${names}]`, msg.channelId).catch(() => {});
                  }
                }
              },
            });
          }

          usedProvider = { name: provider.name, model: provider.getModel() };
          this.providers.markSuccess(provider.name);
          break;
        } catch (err: any) {
          if (loopDetector.isAborted()) {
            logger.info('Generation aborted due to loop detection — using partial response');
            if (!result && streamedText) {
              result = { text: streamedText, usage: undefined };
            }
            if (usedProvider) {
              this.providers.markSuccess(usedProvider.name);
            }
            break;
          }
          lastError = err;
          logger.warn({ provider: provider.name, err: err.message }, 'Provider failed, trying fallback');
          if (channel && msg.channelType !== 'internal') {
            await channel.send(`  [Provider ${provider.name} failed, trying fallback...]`, msg.channelId).catch(() => {});
          }
        }
      }

      if (!result) {
        const errMsg = `All LLM providers failed. Last error: ${lastError?.message || 'unknown'}`;
        logger.error({ err: lastError }, errMsg);
        if (channel && msg.channelType !== 'internal') {
          await channel.send(errMsg, msg.channelId);
        }
        this.lifecycle.transition('idle');
        return;
      }

      const finalText = streamedText || result.text;

      this.tokenBudget.recordUsage({
        provider: usedProvider!.name,
        model: usedProvider!.model,
        inputTokens: result.usage?.promptTokens ?? 0,
        outputTokens: result.usage?.completionTokens ?? 0,
        totalTokens: (result.usage?.promptTokens ?? 0) + (result.usage?.completionTokens ?? 0),
        channelType: msg.channelType,
      });

      this.shortTerm.add(msg.channelId, {
        id: msg.id,
        timestamp: msg.timestamp,
        role: 'user',
        content: msg.content,
      });

      this.shortTerm.add(msg.channelId, {
        id: Date.now().toString(36),
        timestamp: Date.now(),
        role: 'assistant',
        content: finalText,
        tokenCount: (result.usage?.promptTokens ?? 0) + (result.usage?.completionTokens ?? 0),
      });

      this.episodic.record({
        type: 'message',
        summary: `User: ${msg.content.slice(0, 100)} | Agent: ${finalText.slice(0, 100)}`,
        channelType: msg.channelType,
      });

      if (msg.channelType !== 'internal') {
        this.extractFacts(msg.content, finalText).catch(err => {
          logger.warn({ err }, 'Fact extraction failed');
        });
      }

      if (channel && msg.channelType !== 'internal') {
        const elapsed = Date.now() - startTime;
        if (streamedText) {
          logger.info({ channelType: msg.channelType, elapsed }, 'Streamed response completed');
        } else {
          logger.info({ channelType: msg.channelType, targetId: msg.channelId }, 'Sending response');
          await channel.send(finalText, msg.channelId, elapsed);
        }
      } else {
        logger.debug('Internal prompt processed, no channel response needed');
      }

      this.lifecycle.transition('idle');
    } catch (err) {
      logger.error({ err }, 'Error handling message');
      this.lifecycle.transition('idle');
    } finally {
      if (isInternal || isScheduled) {
        this.capabilities.permissions.setAutoApproveAll(false);
      }
      this.capabilities.permissions.clearElevation();
    }
  }

  private buildSystemPrompt(): string {
    let prompt = this.identity.getSystemPrompt(this.config.identity);
    const skillContext = this.capabilities.getSkillContext();
    if (skillContext) {
      prompt += '\n\n' + skillContext;
    }
    const budgetStatus = this.tokenBudget.getStatusText();
    prompt += '\n\n' + budgetStatus;
    if (this.tokenBudget.getUsagePercentage() > 70) {
      prompt += '\nBe concise to conserve tokens.';
    }

    prompt += `\n\nEnvironment:\n- Platform: ${process.platform}\n- Working directory: ${this.capabilities.getCwd()}`;

    const toolNames = this.capabilities.getToolNames();
    const githubTools = ['create_pr', 'review_pr', 'list_issues', 'create_issue', 'github_api'];
    const hasGitHub = githubTools.some(t => toolNames.includes(t));
    if (hasGitHub) {
      let githubHint = '\n\nGitHub companion is active.';
      const { defaultOwner, defaultRepo } = this.config.github;
      if (defaultOwner && defaultRepo) {
        githubHint += ` Default repo: ${defaultOwner}/${defaultRepo}. Use this when the user doesn't specify a repo.`;
      }

      githubHint += `

Available GitHub tools and when to use them:
- git_add, git_commit, git_push: LOCAL git operations (stage, commit, push to a remote you have SSH/auth access to). All commits include "Co-authored-by: Mercury <mercury@cosmicstack.org>".
- create_pr: Create a pull request on GitHub. The head branch must already exist on the remote.
- review_pr: Get PR details and optionally post a review comment.
- list_issues, create_issue: Browse and file issues.
- github_api: Raw GitHub API access. IMPORTANT USE CASES:
  - Push files directly to GitHub via PUT /repos/{owner}/{repo}/contents/{path} when git push fails due to auth. The body must include "message" and "content" (base64-encoded file content). This creates a commit on GitHub with Mercury as co-author.
  - Delete files via DELETE /repos/{owner}/{repo}/contents/{path} with a "message" and "sha" in the body.
  - Any other GitHub API operation not covered by the other tools.

When the user asks to "push to GitHub" or "upload files" and git push fails, use github_api with PUT /repos/{owner}/{repo}/contents/{path} to push content directly through the API. This bypasses local git entirely.

Always specify owner and repo parameters on GitHub tools. The user's GitHub username is ${this.config.github.username || 'not set'}.'`;

      prompt += githubHint;
    }
    return prompt;
  }

  async processInternalPrompt(prompt: string, channelId?: string, channelType?: string): Promise<void> {
    const syntheticMsg: ChannelMessage = {
      id: `internal-${Date.now().toString(36)}`,
      channelId: channelId || 'internal',
      channelType: (channelType || 'internal') as ChannelType,
      senderId: 'system',
      content: prompt,
      timestamp: Date.now(),
    };
    this.enqueueMessage(syntheticMsg);
  }

  private async handleScheduledTask(manifest: ScheduledTaskManifest): Promise<void> {
    logger.info({ task: manifest.id, channel: manifest.sourceChannelType }, 'Processing scheduled task');
    try {
      let prompt = manifest.prompt || '';
      if (manifest.skillName) {
        const skillHint = `Invoke the skill "${manifest.skillName}" using the use_skill tool and follow its instructions.`;
        prompt = prompt ? `${prompt} ${skillHint}` : `Scheduled task triggered. ${skillHint}`;
      }
      if (!prompt) {
        prompt = `Execute scheduled task: ${manifest.description}`;
      }
      await this.processInternalPrompt(prompt, manifest.sourceChannelId, manifest.sourceChannelType);
    } catch (err) {
      logger.error({ err, task: manifest.id }, 'Scheduled task execution failed');
    }
  }

  private async heartbeat(): Promise<void> {
    logger.debug('Heartbeat tick');

    const pruned = this.episodic.prune(7);
    if (pruned > 0) {
      logger.info({ pruned }, 'Episodic memory pruned');
    }

    const notifications: string[] = [];

    const usagePct = this.tokenBudget.getUsagePercentage();
    if (usagePct >= 80) {
      notifications.push(`Token budget at ${Math.round(usagePct)}% — ${this.tokenBudget.getRemaining().toLocaleString()} tokens remaining today.`);
    }

    const pendingSchedules = this.scheduler.getManifests();
    const now = Date.now();
    for (const task of pendingSchedules) {
      if (task.delaySeconds && task.executeAt) {
        const executeAt = new Date(task.executeAt).getTime();
        const diffMin = Math.round((executeAt - now) / 60000);
        if (diffMin > 0 && diffMin <= 5) {
          notifications.push(`Task "${task.description}" fires in ${diffMin} minute${diffMin !== 1 ? 's' : ''}.`);
        }
      }
    }

    if (notifications.length > 0) {
      const channel = this.channels.getNotificationChannel();
      if (channel) {
        const msg = notifications.join('\n');
        try {
          await channel.send(msg, 'notification');
        } catch (err) {
          logger.warn({ err }, 'Failed to send heartbeat notification');
        }
      }
    }
  }

  private async extractFacts(userMessage: string, agentResponse: string): Promise<void> {
    const trivial = /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|bye|goodbye|good morning|good evening)\b/i;
    if (trivial.test(userMessage.trim())) return;

    if (!this.tokenBudget.canAfford(500)) return;

    try {
      const provider = this.providers.getDefault();
      const result = await generateText({
        model: provider.getModelInstance(),
        system: 'You are a fact extractor. Read the conversation below and extract 1-3 important facts worth remembering long-term. Output each fact on a separate line, prefixed with "- ". Only extract facts that are specific, factual, and not obvious. If nothing is worth remembering, output nothing.',
        messages: [
          { role: 'user', content: `User: ${userMessage}\nAssistant: ${agentResponse}` },
        ],
        maxTokens: 200,
      });

      const text = result.text.trim();
      if (!text) return;

      const facts = text
        .split('\n')
        .map(l => l.replace(/^-\s*/, '').trim())
        .filter(f => f.length > 10 && f.length < 200);

      const existing = this.longTerm.getAll();
      for (const fact of facts.slice(0, 3)) {
        const isDupe = existing.some(e =>
          e.fact.toLowerCase().includes(fact.toLowerCase().slice(0, 30))
        );
        if (!isDupe) {
          this.longTerm.add({
            topic: 'extracted',
            fact,
            source: 'conversation',
          });
          logger.info({ fact: fact.slice(0, 60) }, 'Fact extracted to long-term memory');
        }
      }

      this.tokenBudget.recordUsage({
        provider: provider.name,
        model: provider.getModel(),
        inputTokens: result.usage?.promptTokens ?? 0,
        outputTokens: result.usage?.completionTokens ?? 0,
        totalTokens: (result.usage?.promptTokens ?? 0) + (result.usage?.completionTokens ?? 0),
        channelType: 'internal',
      });
    } catch (err) {
      logger.warn({ err }, 'Fact extraction error');
    }
  }

  async shutdown(): Promise<void> {
    await this.sleep();
    logger.info('Mercury has shut down');
  }

  private async handleBudgetOverrideCLI(channel: import('../channels/base.js').Channel, msg: ChannelMessage): Promise<void> {
    const status = this.tokenBudget.getStatusText();
    await channel.send(
      `Token budget exceeded! ${status}\n\nChoose an option:\n  1 — Override (allow this one request)\n  2 — Reset usage to zero\n  3 — Set a new daily budget (current: ${this.tokenBudget.getBudget().toLocaleString()})\n  4 — Cancel\n\nOr use /budget override, /budget reset, /budget set <number> anytime.`,
      msg.channelId,
    );
  }

  async handleBudgetCommand(subcommand: string, channelType: string, channelId: string): Promise<void> {
    const channel = this.channels.get(channelType as any);
    if (!channel) return;

    const parts = subcommand.trim().split(/\s+/);
    const action = parts[0]?.toLowerCase();

    if (action === 'override' || action === '1') {
      this.tokenBudget.forceAllowNext();
      await channel.send('Budget override applied — your next request will proceed.', channelId);
    } else if (action === 'reset' || action === '2') {
      this.tokenBudget.resetUsage();
      await channel.send(`Usage reset to zero. ${this.tokenBudget.getStatusText()}`, channelId);
    } else if (action === 'set' || action === '3') {
      const newBudget = parseInt(parts[1], 10);
      if (isNaN(newBudget) || newBudget <= 0) {
        await channel.send('Please specify the new budget. Usage: `/budget set 100000` or type e.g. `3 100000`', channelId);
        return;
      }
      this.tokenBudget.setBudget(newBudget);
      await channel.send(`Daily budget updated to ${newBudget.toLocaleString()} tokens. ${this.tokenBudget.getStatusText()}`, channelId);
    } else if (action === 'cancel' || action === '4') {
      await channel.send(`Cancelled. ${this.tokenBudget.getStatusText()}`, channelId);
    } else if (!action || action === 'status') {
      await channel.send(this.tokenBudget.getStatusText(), channelId);
    } else {
      await channel.send(`Unknown budget command "${action}". Available: /budget, /budget override, /budget reset, /budget set <number>, /budget status`, channelId);
    }
  }

  private async handleChatCommand(content: string, channelType: string, channelId: string): Promise<boolean> {
    const trimmed = content.trim();
    const cmd = trimmed.toLowerCase();
    const channel = this.channels.get(channelType as any);
    if (!channel) return false;

    const ctx = this.capabilities.getChatCommandContext();
    if (!ctx) return false;

    if (cmd === '/help') {
      await channel.send(ctx.manual(), channelId);
      return true;
    }

    if (cmd === '/status') {
      const config = ctx.config();
      const budget = ctx.tokenBudget();
      const lines = [
        `**${config.identity.name}** — Status`,
        `Owner: ${config.identity.owner || '(not set)'}`,
        `Provider: ${config.providers.default}`,
        `Telegram: ${config.channels.telegram.enabled ? 'enabled' : 'disabled'}`,
        `Telegram access: ${getTelegramAccessSummary(config)}`,
        `Budget: ${budget.getStatusText()}`,
        `Skills: ${ctx.skillNames().length > 0 ? ctx.skillNames().join(', ') : 'none'}`,
      ];
      await channel.send(lines.join('\n'), channelId);
      return true;
    }

    if (cmd.startsWith('/telegram')) {
      if (channelType !== 'cli') {
        await channel.send('`/telegram` is only available from the Mercury CLI chat.', channelId);
        return true;
      }

      const config = ctx.config();
      const rawSubcommand = trimmed.slice('/telegram'.length).trim();
      if (!rawSubcommand && channel instanceof CLIChannel) {
        await channel.withMenu(async (select) => {
          await this.openCliTelegramMenu(channel, channelId, select);
        });
        return true;
      }

      const parts = rawSubcommand.split(/\s+/).filter(Boolean);
      const action = parts[0]?.toLowerCase() || 'help';
      const formatTelegramUser = (user: {
        userId: number;
        username?: string;
        firstName?: string;
        pairingCode?: string;
      }) => {
        const username = user.username ? ` (@${user.username})` : '';
        const firstName = user.firstName ? ` ${user.firstName}` : '';
        const pairingCode = user.pairingCode ? ` [code: ${user.pairingCode}]` : '';
        return `${user.userId}${username}${firstName}${pairingCode}`;
      };

      const sendTelegramOverview = async () => {
        const lines = [
          '**Telegram Management**',
          '',
          `Access: ${getTelegramAccessSummary(config)}`,
          `Admins: ${config.channels.telegram.admins.length > 0 ? config.channels.telegram.admins.map(formatTelegramUser).join(', ') : 'none'}`,
          `Members: ${config.channels.telegram.members.length > 0 ? config.channels.telegram.members.map(formatTelegramUser).join(', ') : 'none'}`,
          `Pending: ${config.channels.telegram.pending.length > 0 ? config.channels.telegram.pending.map(formatTelegramUser).join(', ') : 'none'}`,
          '',
          'Commands:',
          '• `/telegram pending`',
          '• `/telegram users`',
          '• `/telegram approve <pairing-code|user-id>`',
          '• `/telegram reject <user-id>`',
          '• `/telegram remove <user-id>`',
          '• `/telegram promote <user-id>`',
          '• `/telegram demote <user-id>`',
          '• `/telegram reset`',
        ];
        await channel.send(lines.join('\n'), channelId);
      };

      if (action === 'help' || action === 'status') {
        await sendTelegramOverview();
        return true;
      }

      if (action === 'pending') {
        const pending = getTelegramPendingRequests(config);
        const lines = [
          '**Telegram Pending Requests**',
          '',
          pending.length > 0 ? pending.map(formatTelegramUser).join('\n') : 'No pending Telegram requests.',
        ];
        await channel.send(lines.join('\n'), channelId);
        return true;
      }

      if (action === 'users') {
        const approved = getTelegramApprovedUsers(config);
        const lines = [
          '**Telegram Approved Users**',
          '',
          `Admins: ${config.channels.telegram.admins.length > 0 ? config.channels.telegram.admins.map(formatTelegramUser).join(', ') : 'none'}`,
          `Members: ${config.channels.telegram.members.length > 0 ? config.channels.telegram.members.map(formatTelegramUser).join(', ') : 'none'}`,
          '',
          `Total approved: ${approved.length}`,
        ];
        await channel.send(lines.join('\n'), channelId);
        return true;
      }

      if (action === 'approve') {
        const value = parts[1];
        if (!value) {
          await channel.send('Usage: `/telegram approve <pairing-code|user-id>`', channelId);
          return true;
        }

        let approved = approveTelegramPendingRequestByPairingCode(config, value);
        let resultLabel = value;

        if (!approved) {
          const userId = Number(value);
          if (!isNaN(userId)) {
            approved = approveTelegramPendingRequest(config, userId, 'member');
            resultLabel = userId.toString();
          }
        }

        if (!approved) {
          await channel.send(`No pending Telegram request found for \`${resultLabel}\`.`, channelId);
          return true;
        }

        saveConfig(config);
        await channel.send(`Approved Telegram user ${formatTelegramUser(approved)}.`, channelId);
        return true;
      }

      if (action === 'reject') {
        const value = Number(parts[1]);
        if (isNaN(value)) {
          await channel.send('Usage: `/telegram reject <user-id>`', channelId);
          return true;
        }

        const rejected = rejectTelegramPendingRequest(config, value);
        if (!rejected) {
          await channel.send(`No pending Telegram request found for \`${value}\`.`, channelId);
          return true;
        }

        saveConfig(config);
        await channel.send(`Rejected Telegram request for ${formatTelegramUser(rejected)}.`, channelId);
        return true;
      }

      if (action === 'remove') {
        const value = Number(parts[1]);
        if (isNaN(value)) {
          await channel.send('Usage: `/telegram remove <user-id>`', channelId);
          return true;
        }

        const removed = removeTelegramUser(config, value);
        if (!removed) {
          await channel.send(`No approved Telegram user found for \`${value}\`.`, channelId);
          return true;
        }

        saveConfig(config);
        await channel.send(`Removed Telegram access for ${formatTelegramUser(removed)}.`, channelId);
        return true;
      }

      if (action === 'promote') {
        const value = Number(parts[1]);
        if (isNaN(value)) {
          await channel.send('Usage: `/telegram promote <user-id>`', channelId);
          return true;
        }

        const promoted = promoteTelegramUserToAdmin(config, value);
        if (!promoted) {
          await channel.send(`No Telegram member found for \`${value}\`.`, channelId);
          return true;
        }

        saveConfig(config);
        await channel.send(`Promoted ${formatTelegramUser(promoted)} to Telegram admin.`, channelId);
        return true;
      }

      if (action === 'demote') {
        const value = Number(parts[1]);
        if (isNaN(value)) {
          await channel.send('Usage: `/telegram demote <user-id>`', channelId);
          return true;
        }

        const demoted = demoteTelegramAdmin(config, value);
        if (!demoted) {
          await channel.send('Could not demote that Telegram admin. Mercury must keep at least one admin.', channelId);
          return true;
        }

        saveConfig(config);
        await channel.send(`Demoted ${formatTelegramUser(demoted)} to Telegram member.`, channelId);
        return true;
      }

      if (action === 'reset' || action === 'unpair') {
        config.channels.telegram.admins = [];
        config.channels.telegram.members = [];
        config.channels.telegram.pending = [];
        saveConfig(config);
        await channel.send('Telegram access reset. New users can send /start to begin pairing again.', channelId);
        return true;
      }

      await channel.send(
      `Unknown Telegram command "${action}". Try \`/telegram\`, \`/telegram pending\`, or \`/telegram users\`.`,
        channelId,
      );
      return true;
    }

    if ((cmd === '/' || cmd === '/menu') && channelType === 'cli' && channel instanceof CLIChannel) {
      await this.openCliCommandMenu(channel, channelId);
      return true;
    }

    if (cmd === '/tools') {
      const tools = ctx.toolNames();
      const grouped = [
        `**${tools.length} tools loaded:**`,
        '',
        ...tools.sort().map(t => `• \`${t}\``),
      ];
      await channel.send(grouped.join('\n'), channelId);
      return true;
    }

    if (cmd === '/skills') {
      const names = ctx.skillNames();
      if (names.length === 0) {
        await channel.send('No skills installed. Ask me to "install skill from <url>" to add one.', channelId);
      } else {
        const lines = [
          `**${names.length} skill${names.length > 1 ? 's' : ''} installed:**`,
          '',
          ...names.map(n => `• ${n}`),
        ];
        await channel.send(lines.join('\n'), channelId);
      }
      return true;
    }

    if (cmd === '/stream on') {
      this.telegramStreaming = true;
      await channel.send('Telegram streaming enabled. Responses will appear progressively.', channelId);
      return true;
    }

    if (cmd === '/stream off') {
      this.telegramStreaming = false;
      await channel.send('Telegram streaming disabled. Responses will arrive as a single message.', channelId);
      return true;
    }

    if (cmd === '/stream') {
      this.telegramStreaming = !this.telegramStreaming;
      await channel.send(
        this.telegramStreaming
          ? 'Telegram streaming enabled. Responses will appear progressively.'
          : 'Telegram streaming disabled. Responses will arrive as a single message.',
        channelId,
      );
      return true;
    }
    if (cmd === '/stream off') {
      this.telegramStreaming = false;
      await channel.send('Telegram streaming disabled. Responses will arrive as a single message.', channelId);
      return true;
    }

    return false;
  }

  private async openCliCommandMenu(channel: CLIChannel, channelId: string): Promise<void> {
    const ctx = this.capabilities.getChatCommandContext();
    if (!ctx) return;

    await channel.withMenu(async (select) => {
      while (true) {
        const streamLabel = this.telegramStreaming ? 'Disable Telegram Streaming' : 'Enable Telegram Streaming';
        const action = await select('Mercury Commands', [
          { value: 'status', label: 'Status' },
          { value: 'telegram', label: 'Telegram' },
          { value: 'tools', label: 'Tools' },
          { value: 'skills', label: 'Skills' },
          { value: 'stream', label: streamLabel },
          { value: 'help', label: 'Help' },
          { value: 'exit', label: 'Exit' },
        ]);

        if (action === 'exit') {
          return;
        }

        if (action === 'status') {
          await this.handleChatCommand('/status', 'cli', channelId);
          continue;
        }

        if (action === 'telegram') {
          await this.openCliTelegramMenu(channel, channelId, select);
          continue;
        }

        if (action === 'tools') {
          await this.handleChatCommand('/tools', 'cli', channelId);
          continue;
        }

        if (action === 'skills') {
          await this.handleChatCommand('/skills', 'cli', channelId);
          continue;
        }

        if (action === 'stream') {
          await this.handleChatCommand('/stream', 'cli', channelId);
          continue;
        }

        if (action === 'help') {
          await channel.send(ctx.manual(), channelId);
        }
      }
    });
  }

  private async openCliTelegramMenu(
    channel: CLIChannel,
    channelId: string,
    select: (title: string, options: ArrowSelectOption[]) => Promise<string>,
  ): Promise<void> {
    const ctx = this.capabilities.getChatCommandContext();
    if (!ctx) return;
    const formatTelegramUser = (user: {
      userId: number;
      username?: string;
      firstName?: string;
      pairingCode?: string;
    }) => {
      const username = user.username ? ` (@${user.username})` : '';
      const firstName = user.firstName ? ` ${user.firstName}` : '';
      const pairingCode = user.pairingCode ? ` [code: ${user.pairingCode}]` : '';
      return `${user.userId}${username}${firstName}${pairingCode}`;
    };

    const selectFromUsers = async (
      title: string,
      users: Array<{ userId: number; username?: string; firstName?: string; pairingCode?: string }>,
      emptyMessage: string,
      backValue: string = 'back',
    ): Promise<string> => {
      if (users.length === 0) {
        await channel.send(emptyMessage, channelId);
        return backValue;
      }

      return select(title, [
        ...users.map((user) => ({
          value: user.pairingCode || user.userId.toString(),
          label: formatTelegramUser(user),
        })),
        { value: backValue, label: 'Back' },
      ]);
    };

    while (true) {
      const config = ctx.config();
      const action = await select('Telegram Commands', [
        { value: 'overview', label: 'Overview' },
        { value: 'pending', label: `Pending Requests (${config.channels.telegram.pending.length})` },
        { value: 'users', label: `Approved Users (${getTelegramApprovedUsers(config).length})` },
        { value: 'approve', label: 'Approve Request' },
        { value: 'reject', label: 'Reject Request' },
        { value: 'remove', label: 'Remove User' },
        { value: 'promote', label: 'Promote to Admin' },
        { value: 'demote', label: 'Demote Admin' },
        { value: 'reset', label: 'Reset Telegram Access' },
        { value: 'back', label: 'Back' },
        { value: 'exit', label: 'Exit' },
      ]);

      if (action === 'exit') {
        return;
      }

      if (action === 'back') {
        return;
      }

      if (action === 'overview') {
        await this.handleChatCommand('/telegram status', 'cli', channelId);
        continue;
      }

      if (action === 'pending') {
        await this.handleChatCommand('/telegram pending', 'cli', channelId);
        continue;
      }

      if (action === 'users') {
        await this.handleChatCommand('/telegram users', 'cli', channelId);
        continue;
      }

      if (action === 'approve') {
        const pending = getTelegramPendingRequests(config);
        const selected = await selectFromUsers(
          'Approve Telegram Request',
          pending,
          'There are no pending Telegram requests to approve.',
        );

        if (selected === 'back') {
          continue;
        }

        await this.handleChatCommand(`/telegram approve ${selected}`, 'cli', channelId);
        continue;
      }

      if (action === 'reject') {
        const pending = getTelegramPendingRequests(config);
        const selected = await selectFromUsers(
          'Reject Telegram Request',
          pending,
          'There are no pending Telegram requests to reject.',
        );

        if (selected === 'back') {
          continue;
        }

        const request = pending.find((entry) => (entry.pairingCode || entry.userId.toString()) === selected);
        if (!request) {
          await channel.send('That Telegram request is no longer pending.', channelId);
          continue;
        }

        await this.handleChatCommand(`/telegram reject ${request.userId}`, 'cli', channelId);
        continue;
      }

      if (action === 'remove') {
        const approved = getTelegramApprovedUsers(config);
        const selected = await selectFromUsers(
          'Remove Telegram User',
          approved,
          'There are no approved Telegram users to remove.',
        );

        if (selected === 'back') {
          continue;
        }

        const user = approved.find((entry) => entry.userId.toString() === selected);
        if (!user) {
          await channel.send('That Telegram user is no longer approved.', channelId);
          continue;
        }

        await this.handleChatCommand(`/telegram remove ${user.userId}`, 'cli', channelId);
        continue;
      }

      if (action === 'promote') {
        const members = config.channels.telegram.members;
        const selected = await selectFromUsers(
          'Promote Telegram Member',
          members,
          'There are no Telegram members available to promote.',
        );

        if (selected === 'back') {
          continue;
        }

        const member = members.find((entry) => entry.userId.toString() === selected);
        if (!member) {
          await channel.send('That Telegram member is no longer available.', channelId);
          continue;
        }

        await this.handleChatCommand(`/telegram promote ${member.userId}`, 'cli', channelId);
        continue;
      }

      if (action === 'demote') {
        const admins = config.channels.telegram.admins;
        const selected = await selectFromUsers(
          'Demote Telegram Admin',
          admins,
          'There are no Telegram admins available to demote.',
        );

        if (selected === 'back') {
          continue;
        }

        const admin = admins.find((entry) => entry.userId.toString() === selected);
        if (!admin) {
          await channel.send('That Telegram admin is no longer available.', channelId);
          continue;
        }

        await this.handleChatCommand(`/telegram demote ${admin.userId}`, 'cli', channelId);
        continue;
      }

      if (action === 'reset') {
        const confirmation = await select('Reset Telegram Access?', [
          { value: 'cancel', label: 'Cancel' },
          { value: 'confirm', label: 'Reset all Telegram access' },
          { value: 'back', label: 'Back' },
        ]);

        if (confirmation === 'confirm') {
          clearTelegramAccess(config);
          saveConfig(config);
          await channel.send('Telegram access reset. New users can send /start to begin pairing again.', channelId);
        }

        continue;
      }
    }
  }
}
