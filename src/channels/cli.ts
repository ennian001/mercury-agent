import readline from 'node:readline';
import chalk from 'chalk';
import type { ChannelMessage } from '../types/channel.js';
import { BaseChannel } from './base.js';
import { logger } from '../utils/logger.js';

export class CLIChannel extends BaseChannel {
  readonly type = 'cli' as const;
  private rl: readline.Interface | null = null;
  private agentName: string;

  constructor(agentName: string = 'Mercury') {
    super();
    this.agentName = agentName;
  }

  setAgentName(name: string): void {
    this.agentName = name;
  }

  async start(): Promise<void> {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '',
    });

    this.rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      const msg: ChannelMessage = {
        id: Date.now().toString(36),
        channelId: 'cli',
        channelType: 'cli',
        senderId: 'owner',
        content: trimmed,
        timestamp: Date.now(),
      };
      this.emit(msg);
    });

    this.ready = true;
    logger.info('CLI channel started');
  }

  async stop(): Promise<void> {
    this.rl?.close();
    this.rl = null;
    this.ready = false;
  }

  async send(content: string, _targetId?: string): Promise<void> {
    console.log('');
    console.log(chalk.cyan(`  ${this.agentName}: `) + content);
    console.log('');
    this.showPrompt();
  }

  async stream(content: AsyncIterable<string>, _targetId?: string): Promise<void> {
    process.stdout.write(chalk.cyan(`  ${this.agentName}: `));
    for await (const chunk of content) {
      process.stdout.write(chunk);
    }
    process.stdout.write('\n\n');
    this.showPrompt();
  }

  async typing(_targetId?: string): Promise<void> {
    process.stdout.write(chalk.dim(`  ${this.agentName} is thinking...\r`));
  }

  showPrompt(): void {
    process.stdout.write('  You: ');
  }

  async prompt(question: string): Promise<string> {
    return new Promise((resolve) => {
      this.rl?.question(question, (answer) => resolve(answer.trim()));
    });
  }
}