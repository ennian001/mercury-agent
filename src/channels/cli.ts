import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import type { ChannelMessage } from '../types/channel.js';
import { BaseChannel } from './base.js';
import { logger } from '../utils/logger.js';
import { renderMarkdown } from '../utils/markdown.js';
import { formatToolStep } from '../utils/tool-label.js';
import {
  ArrowSelectCancelledError,
  selectWithArrowKeys,
  type ArrowSelectOption,
} from '../utils/arrow-select.js';

export class CLIChannel extends BaseChannel {
  readonly type = 'cli' as const;
  private rl: readline.Interface | null = null;
  private agentName: string;
  private menuDepth = 0;
  private menuAbortController: AbortController | null = null;
  private outputInProgress = 0;
  private streamActive = false;
  private spinnerInterval: NodeJS.Timeout | null = null;
  private spinnerFrame = 0;
  private static readonly SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

  constructor(agentName: string = 'Mercury') {
    super();
    this.agentName = agentName;
  }

  setAgentName(name: string): void {
    this.agentName = name;
  }

  async start(): Promise<void> {
    this.createInterface();
    this.ready = true;
    logger.info('CLI channel started');
  }

  private createInterface(): void {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    this.rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        this.showPrompt();
        return;
      }

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
  }

  async stop(): Promise<void> {
    this.rl?.close();
    this.rl = null;
    this.ready = false;
  }

  async send(content: string, _targetId?: string, elapsedMs?: number): Promise<void> {
    this.closeActiveMenu();
    this.beginOutput();
    const timeStr = elapsedMs != null ? chalk.dim(` (${(elapsedMs / 1000).toFixed(1)}s)`) : '';
    const rendered = renderMarkdown(content);
    const indented = rendered
      .split('\n')
      .map((line: string) => `  ${line}`)
      .join('\n');
    console.log('');
    console.log(chalk.cyan(`  ${this.agentName}:`) + timeStr);
    console.log(indented);
    console.log('');
    this.endOutput();
  }

  async sendFile(filePath: string, _targetId?: string): Promise<void> {
    this.closeActiveMenu();
    this.beginOutput();
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      console.log(chalk.red(`  File not found: ${filePath}`));
      this.endOutput();
      return;
    }
    const stat = fs.statSync(resolved);
    const sizeStr = stat.size > 1024 * 1024
      ? `${(stat.size / (1024 * 1024)).toFixed(1)}MB`
      : stat.size > 1024
        ? `${(stat.size / 1024).toFixed(1)}KB`
        : `${stat.size}B`;
    console.log('');
    console.log(chalk.cyan(`  ${this.agentName}:`) + chalk.dim(' (file)'));
    console.log(chalk.dim(`  path: ${resolved}`));
    console.log(chalk.dim(`  size: ${sizeStr}`));
    console.log('');
    this.endOutput();
  }

  startSpinner(): void {
    if (this.spinnerInterval) return;
    this.spinnerFrame = 0;
    this.spinnerInterval = setInterval(() => {
      const frame = CLIChannel.SPINNER_FRAMES[this.spinnerFrame % CLIChannel.SPINNER_FRAMES.length];
      process.stdout.write(`\r${chalk.cyan(`  ${this.agentName}:`)} ${chalk.dim(frame)}`);
      this.spinnerFrame++;
    }, 80);
  }

  stopSpinner(): void {
    if (this.spinnerInterval) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = null;
    }
    process.stdout.write('\r\x1b[2K');
  }

  async sendToolFeedback(toolName: string, args: Record<string, any>): Promise<void> {
    const label = formatToolStep(toolName, args);
    if (this.spinnerInterval) {
      process.stdout.write(`\r\x1b[2K${chalk.dim(`  ${label}`)}\n`);
      this.startSpinner();
    } else {
      console.log(chalk.dim(`  ${label}`));
    }
  }

  async stream(content: AsyncIterable<string>, _targetId?: string): Promise<string> {
    this.closeActiveMenu();
    this.beginOutput();
    this.streamActive = true;

    if (!process.stdout.isTTY) {
      process.stdout.write(chalk.cyan(`  ${this.agentName}: `));
      let full = '';
      for await (const chunk of content) {
        process.stdout.write(chunk);
        full += chunk;
      }
      this.streamActive = false;
      console.log('\n');
      this.endOutput();
      return full;
    }

    this.startSpinner();

    let full = '';
    for await (const chunk of content) {
      full += chunk;
    }

    this.stopSpinner();
    this.streamActive = false;

    if (full.trim()) {
      const rendered = renderMarkdown(full);
      const indented = rendered
        .split('\n')
        .map((line: string) => `  ${line}`)
        .join('\n');
      console.log(chalk.cyan(`  ${this.agentName}:`));
      console.log(indented);
      console.log('');
    } else {
      console.log(chalk.cyan(`  ${this.agentName}:`) + chalk.dim(' (no response)'));
      console.log('');
    }

    this.endOutput();
    return full;
  }

  async typing(_targetId?: string): Promise<void> {
    if (!this.streamActive) {
      this.startSpinner();
    }
  }

  showPrompt(): void {
    if (this.rl) {
      this.stopSpinner();
      process.stdout.write(chalk.yellow('  You: '));
    }
  }

  async withMenu<T>(runner: (select: (title: string, options: ArrowSelectOption[]) => Promise<string>) => Promise<T>): Promise<T | undefined> {
    this.menuDepth += 1;
    this.menuAbortController = new AbortController();
    this.suspendPrompt();

    try {
      return await runner((title, options) => selectWithArrowKeys(title, options, {
        signal: this.menuAbortController?.signal,
      }));
    } catch (error) {
      if (error instanceof ArrowSelectCancelledError) {
        return undefined;
      }
      throw error;
    } finally {
      this.menuDepth = Math.max(0, this.menuDepth - 1);
      if (this.menuDepth === 0) {
        this.menuAbortController = null;
      }
      if (this.menuDepth === 0) {
        this.resumePrompt();
        if (this.outputInProgress === 0) {
          this.showPrompt();
        }
      }
    }
  }

  private closeActiveMenu(): void {
    if (!this.menuAbortController?.signal.aborted) {
      this.menuAbortController?.abort();
    }
  }

  private beginOutput(): void {
    this.outputInProgress += 1;
  }

  private endOutput(): void {
    this.outputInProgress = Math.max(0, this.outputInProgress - 1);
    if (this.menuDepth === 0 && this.outputInProgress === 0) {
      this.showPrompt();
    }
  }

  private suspendPrompt(): void {
    if (!this.rl) return;
    process.stdout.write('\n');
    this.rl.close();
    this.rl = null;
  }

  private resumePrompt(): void {
    if (!this.ready || this.rl) return;
    this.createInterface();
  }

  async prompt(question: string): Promise<string> {
    return new Promise((resolve) => {
      this.rl?.question(question, (answer) => resolve(answer.trim()));
    });
  }

  async askPermission(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      console.log('');
      console.log(chalk.yellow(`  ⚠ ${prompt}`));
      this.rl?.question(chalk.yellow('  > '), (answer) => {
        resolve(answer.trim());
      });
    });
  }
}