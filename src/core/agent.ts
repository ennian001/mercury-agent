import type { ChannelMessage } from '../types/channel.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { Identity } from '../soul/identity.js';
import type { ShortTermMemory, LongTermMemory, EpisodicMemory } from '../memory/store.js';
import type { ChannelRegistry } from '../channels/registry.js';
import type { MercuryConfig } from '../utils/config.js';
import type { TokenBudget } from '../utils/tokens.js';
import { Lifecycle } from './lifecycle.js';
import { Scheduler } from './scheduler.js';
import { logger } from '../utils/logger.js';

export class Agent {
  readonly lifecycle: Lifecycle;
  readonly scheduler: Scheduler;
  private running = false;
  private messageQueue: ChannelMessage[] = [];
  private processing = false;

  constructor(
    private config: MercuryConfig,
    private providers: ProviderRegistry,
    private identity: Identity,
    private shortTerm: ShortTermMemory,
    private longTerm: LongTermMemory,
    private episodic: EpisodicMemory,
    private channels: ChannelRegistry,
    private tokenBudget: TokenBudget,
  ) {
    this.lifecycle = new Lifecycle();
    this.scheduler = new Scheduler(config);

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
    this.scheduler.startHeartbeat();
    await this.channels.startAll();
    this.running = true;

    const activeChannels = this.channels.getActiveChannels();
    logger.info({ channels: activeChannels }, 'Mercury is awake');
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

    try {
      const provider = this.providers.getDefault();
      const systemPrompt = this.identity.getSystemPrompt(this.config.identity);
      const recentMemory = this.shortTerm.getRecent(msg.channelId, 10);
      const relevantFacts = this.longTerm.search(msg.content, 3);

      let contextPrompt = '';
      if (relevantFacts.length > 0) {
        contextPrompt += '\nRelevant facts:\n' + relevantFacts.map(f => `- ${f.fact}`).join('\n');
      }
      if (recentMemory.length > 0) {
        contextPrompt += '\nRecent conversation:\n' + recentMemory
          .map(m => `${m.role}: ${m.content}`)
          .join('\n');
      }

      const fullPrompt = contextPrompt + '\n\nUser: ' + msg.content;

      this.lifecycle.transition('responding');

      const channel = this.channels.getChannelForMessage(msg);
      if (channel) {
        await channel.typing(msg.channelId).catch(() => {});
      }

      logger.info({ provider: provider.name, model: provider.getModel() }, 'Generating response');
      const response = await provider.generateText(fullPrompt, systemPrompt);
      logger.info({ tokens: response.totalTokens }, 'Response generated');

      this.tokenBudget.recordUsage({
        provider: response.provider,
        model: response.model,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        totalTokens: response.totalTokens,
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
        content: response.text,
        tokenCount: response.totalTokens,
      });

      this.episodic.record({
        type: 'message',
        summary: `User: ${msg.content.slice(0, 100)} | Agent: ${response.text.slice(0, 100)}`,
        channelType: msg.channelType,
      });

      if (channel) {
        logger.info({ channelType: msg.channelType, targetId: msg.channelId }, 'Sending response');
        await channel.send(response.text, msg.channelId);
      } else {
        logger.warn({ channelType: msg.channelType }, 'No channel found for response');
      }

      this.lifecycle.transition('idle');
    } catch (err) {
      logger.error({ err }, 'Error handling message');
      this.lifecycle.transition('idle');
    }
  }

  private async heartbeat(): Promise<void> {
    logger.debug('Heartbeat tick');

    const pruned = this.episodic.prune(7);
    if (pruned > 0) {
      logger.info({ pruned }, 'Episodic memory pruned');
    }
  }

  async shutdown(): Promise<void> {
    await this.sleep();
    logger.info('Mercury has shut down');
  }
}