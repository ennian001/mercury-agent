import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import type { ChannelMessage } from '../types/channel.js';
import { BaseChannel } from './base.js';
import { logger } from '../utils/logger.js';
import { renderMarkdown } from '../utils/markdown.js';
import { formatToolStep, formatToolResult } from '../utils/tool-label.js';
import {
  ArrowSelectCancelledError,
  selectWithArrowKeys,
  type ArrowSelectOption,
} from '../utils/arrow-select.js';

const USER_PROMPT = '  You: ';
const SPINNER_FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];

function agentName(name: string, suffix?: string): string {
  return chalk.cyan(`  ${name}:`) + (suffix ?? '');
}

export class CLIChannel extends BaseChannel {
  readonly type = 'cli' as const;
  private rl: readline.Interface | null = null;
  private agentName: string;
  private menuDepth = 0;
  private menuAbortController: AbortController | null = null;
  private outputInProgress = 0;
  private streamActive = false;
  private turnHeaderPrinted = false;
  private stepCount = 0;
  private stepStartTime = 0;
  private spinnerFrame = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private spinnerLine = '';

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
    this.rl.setPrompt(USER_PROMPT);

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
    this.turnHeaderPrinted = false;
    const timeStr = elapsedMs != null ? chalk.dim(` (${(elapsedMs / 1000).toFixed(1)}s)`) : '';

    const block = this.formatBlock(this.agentName, timeStr, content);
    for (const line of block) {
      console.log(line);
    }

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

    const block = this.formatBlock(this.agentName, chalk.dim(' (file)'), [
      chalk.dim(`path: ${resolved}`),
      chalk.dim(`size: ${sizeStr}`),
    ].join('\n'));
    for (const line of block) {
      console.log(line);
    }

    this.endOutput();
  }

  async sendToolFeedback(toolName: string, args: Record<string, any>): Promise<void> {
    this.stopSpinner();
    if (!this.turnHeaderPrinted) {
      this.turnHeaderPrinted = true;
      console.log('');
      console.log(agentName(this.agentName, ''));
      console.log('');
    }
    this.stepCount += 1;
    this.stepStartTime = Date.now();

    const label = formatToolStep(toolName, args);
    const stepPrefix = chalk.dim(`  ${this.stepCount}.`);

    console.log(`${stepPrefix} ${chalk.dim(label)}`);
    this.startSpinner();
  }

  sendStepDone(toolName: string, result: unknown): void {
    this.stopSpinner();
    const elapsed = ((Date.now() - this.stepStartTime) / 1000).toFixed(1);
    const summary = formatToolResult(toolName, result);
    if (summary) {
      console.log(chalk.dim(`     ${summary} (${elapsed}s)`));
    } else {
      process.stdout.write(chalk.dim(`     ${elapsed}s\n`));
    }
  }

  private startSpinner(): void {
    if (!process.stdout.isTTY) return;
    this.spinnerFrame = 0;
    this.spinnerLine = '';
    this.spinnerTimer = setInterval(() => {
      const frame = SPINNER_FRAMES[this.spinnerFrame % SPINNER_FRAMES.length];
      const elapsed = ((Date.now() - this.stepStartTime) / 1000).toFixed(0);
      this.spinnerLine = chalk.dim(`     ${frame} Step ${this.stepCount} · ${elapsed}s`);
      process.stdout.write(`\x1b[2K\r${this.spinnerLine}`);
      this.spinnerFrame++;
    }, 80);
  }

  private stopSpinner(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
    if (this.spinnerLine) {
      process.stdout.write('\x1b[2K\r');
      this.spinnerLine = '';
    }
  }

  async stream(content: AsyncIterable<string>, _targetId?: string): Promise<string> {
    this.closeActiveMenu();
    this.beginOutput();
    this.stepCount = 0;
    this.turnHeaderPrinted = false;

    if (!process.stdout.isTTY) {
      process.stdout.write(chalk.cyan(`  ${this.agentName}: `));
      let full = '';
      for await (const chunk of content) {
        process.stdout.write(chunk);
        full += chunk;
      }
      console.log('\n');
      this.endOutput();
      return full;
    }

    this.streamActive = true;
    let full = '';
    for await (const chunk of content) {
      this.stopSpinner();
      if (!this.turnHeaderPrinted) {
        this.turnHeaderPrinted = true;
        console.log('');
        console.log(agentName(this.agentName, ''));
        console.log('');
      }
      process.stdout.write(chunk);
      full += chunk;
    }
    this.streamActive = false;

    if (!full.trim()) {
      console.log('');
      this.endOutput();
      return full;
    }

    console.log('');
    console.log('');

    this.endOutput();
    return full;
  }

  async typing(_targetId?: string): Promise<void> {
    this.stopSpinner();
    if (process.stdout.isTTY) {
      process.stdout.write(chalk.dim(`  ${this.agentName} is thinking...\r`));
    }
  }

  showPrompt(): void {
    if (this.rl) {
      process.stdout.write('\x1b[2K\r');
      process.stdout.write(chalk.yellow(USER_PROMPT));
    }
  }

  private formatBlock(name: string, suffix: string, content: string): string[] {
    const header = agentName(name, suffix);
    const body = renderMarkdown(content)
      .split('\n')
      .map((line: string) => `  ${line}`)
      .join('\n');
    return ['', header, '', body, ''];
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

  async askToContinue(question: string, _targetId?: string): Promise<boolean> {
    return new Promise((resolve) => {
      console.log('');
      console.log(chalk.yellow(`  ⚠ ${question}`));
      this.rl?.question(chalk.yellow('  Continue? [y/N] '), (answer) => {
        const val = answer.trim().toLowerCase();
        resolve(val === 'y' || val === 'yes');
      });
    });
  }
}