import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import readline from 'node:readline';
import chalk from 'chalk';
import figlet from 'figlet';
import { loadConfig, saveConfig, isSetupComplete, getMercuryHome, ensureCreatorField, clearTelegramPairing, isProviderConfigured } from './utils/config.js';
import type { MercuryConfig } from './utils/config.js';
import type { ProviderName } from './utils/config.js';
import { logger } from './utils/logger.js';
import { Identity } from './soul/identity.js';
import { ShortTermMemory, LongTermMemory, EpisodicMemory } from './memory/store.js';
import { ProviderRegistry } from './providers/registry.js';
import { Agent } from './core/agent.js';
import { Scheduler } from './core/scheduler.js';
import { ChannelRegistry } from './channels/registry.js';
import { CLIChannel } from './channels/cli.js';
import { TelegramChannel } from './channels/telegram.js';
import { TokenBudget } from './utils/tokens.js';
import { CapabilityRegistry } from './capabilities/registry.js';
import { SkillLoader } from './skills/loader.js';
import { getManual } from './utils/manual.js';
import { startBackground, stopDaemon, showLogs, getDaemonStatus, restartDaemon, tryAutoDaemonize } from './cli/daemon.js';
import { installService, uninstallService, showServiceStatus, isServiceInstalled } from './cli/service.js';
import { runWithWatchdog } from './cli/watchdog.js';
import { setGitHubToken } from './utils/github.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgVersion = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version;

function hr() {
  console.log(chalk.dim('─'.repeat(50)));
}

const MERCURY_ASCII = [
  '    __  _____________  ________  ________  __',
  '   /  |/  / ____/ __ \\/ ____/ / / / __ \\/ < /',
  '  / /|_/ / __/ / /_/ / /   / / / / /_/ /\\  / ',
  ' / /  / / /___/ _, _/ /___/ /_/ / _, _/ / /  ',
  '/_/  /_/_____/_/ |_|\\____/\\____/_/ |_| /_/   ',
].filter(l => l.trim());

function banner() {
  console.log('');
  for (const line of MERCURY_ASCII) {
    console.log(chalk.bold.cyan(`  ${line}`));
  }
  console.log('');
  console.log(chalk.white('  an AI agent for personal tasks'));
  console.log(chalk.dim(`  v${pkgVersion} · by Cosmic Stack · mercury.cosmicstack.org`));
  console.log('');
}

function splashScreen() {
  console.log('');
  for (const line of MERCURY_ASCII) {
    console.log(chalk.bold.cyan(`  ${line}`));
  }
  console.log('');
  console.log(chalk.dim('  an AI agent for personal tasks'));
  console.log(chalk.cyan('  by Cosmic Stack'));
  console.log(chalk.dim('  mercury.cosmicstack.org'));
  console.log('');
}

async function ask(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '••••••••';
  return key.slice(0, 4) + '••••' + key.slice(-4);
}

const PROVIDER_OPTIONS: Array<{ key: ProviderName; label: string }> = [
  { key: 'deepseek', label: 'DeepSeek' },
  { key: 'openai', label: 'OpenAI' },
  { key: 'anthropic', label: 'Anthropic' },
  { key: 'grok', label: 'Grok (xAI)' },
  { key: 'ollamaCloud', label: 'Ollama Cloud' },
  { key: 'ollamaLocal', label: 'Ollama Local' },
];

function getConfiguredProviderNames(config: MercuryConfig): ProviderName[] {
  return PROVIDER_OPTIONS
    .map((option) => option.key)
    .filter((key) => isProviderConfigured(config.providers[key]));
}

function getProviderLabel(name: ProviderName): string {
  return PROVIDER_OPTIONS.find((option) => option.key === name)?.label || name;
}

function parseProviderSelection(input: string): ProviderName[] | null {
  const values = input.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) return [];

  const selected: ProviderName[] = [];
  for (const value of values) {
    const index = parseInt(value, 10);
    if (isNaN(index) || index < 1 || index > PROVIDER_OPTIONS.length) {
      return null;
    }
    const provider = PROVIDER_OPTIONS[index - 1].key;
    if (!selected.includes(provider)) {
      selected.push(provider);
    }
  }
  return selected;
}

async function chooseProvidersToConfigure(config: MercuryConfig, isReconfig: boolean): Promise<ProviderName[]> {
  const configured = getConfiguredProviderNames(config);

  while (true) {
    for (let i = 0; i < PROVIDER_OPTIONS.length; i++) {
      const option = PROVIDER_OPTIONS[i];
      const status = configured.includes(option.key) ? ' (configured)' : '';
      console.log(chalk.white(`    ${i + 1}. ${option.label}${status}`));
    }
    console.log('');

    const prompt = isReconfig
      ? chalk.white('  Choose providers to configure [comma-separated, Enter keeps current]: ')
      : chalk.white('  Choose providers to configure [comma-separated, Enter for DeepSeek]: ');

    const input = await ask(prompt);
    const parsed = parseProviderSelection(input);
    if (parsed === null) {
      console.log(chalk.red('  Please choose valid provider numbers, like `1` or `1,3,5`.'));
      console.log('');
      continue;
    }

    if (parsed.length > 0) return parsed;
    if (!isReconfig) return ['deepseek'];
    return configured.length > 0 ? configured : ['deepseek'];
  }
}

async function chooseDefaultProvider(config: MercuryConfig): Promise<void> {
  const configured = getConfiguredProviderNames(config);

  if (configured.length === 0) {
    return;
  }

  if (configured.length === 1) {
    config.providers.default = configured[0];
    console.log(chalk.dim(`  Default provider set to ${getProviderLabel(configured[0])}`));
    return;
  }

  const suggested = configured.includes('deepseek') ? 'deepseek' : configured[0];

  console.log('');
  console.log(chalk.bold.white('  Default Provider'));
  console.log(chalk.dim('  Select the LLM provider Mercury should use first.'));
  console.log('');
  for (let i = 0; i < configured.length; i++) {
    const provider = configured[i];
    const recommended = provider === suggested ? ' (recommended)' : '';
    const current = provider === config.providers.default ? ' (current)' : '';
    console.log(chalk.white(`    ${i + 1}. ${getProviderLabel(provider)}${recommended}${current}`));
  }
  console.log('');

  while (true) {
    const choice = await ask(chalk.white(`  Choose [1-${configured.length}] [Enter for ${getProviderLabel(suggested)}]: `));
    if (!choice) {
      config.providers.default = suggested;
      return;
    }

    const num = parseInt(choice, 10);
    if (num >= 1 && num <= configured.length) {
      config.providers.default = configured[num - 1];
      return;
    }

    console.log(chalk.red('  Please choose a valid number from the list above.'));
  }
}

function looksLikeToken(value: string, minLength: number = 20): boolean {
  return value.length >= minLength && !/\s/.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value);
}

function validateApiKey(provider: ProviderName, value: string): string | null {
  if (provider === 'openai') {
    return /^sk-(proj-|svcacct-)?[A-Za-z0-9_-]{16,}$/i.test(value)
      ? null
      : 'OpenAI keys must start with `sk-`, `sk-proj-`, or `sk-svcacct-`.';
  }

  if (provider === 'anthropic') {
    return /^sk-ant-[A-Za-z0-9_-]{16,}$/i.test(value)
      ? null
      : 'Anthropic keys must start with `sk-ant-`.';
  }

  if (provider === 'deepseek') {
    return /^sk-[A-Za-z0-9_-]{16,}$/i.test(value)
      ? null
      : 'DeepSeek keys must start with `sk-`.';
  }

  if (provider === 'grok') {
    return looksLikeToken(value)
      ? null
      : 'Grok keys must look like a real API token: long, no spaces, and not plain text.';
  }

  if (provider === 'ollamaCloud') {
    return looksLikeToken(value)
      ? null
      : 'Ollama Cloud keys must look like a real API token: long, no spaces, and not plain text.';
  }

  return null;
}

function validateBaseUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'Base URL must start with http:// or https://.';
    }
    return null;
  } catch {
    return 'Please enter a valid URL.';
  }
}

function validateModelName(value: string): string | null {
  if (!value.trim()) return 'Model name is required.';
  if (/\s/.test(value)) return 'Model name cannot contain spaces.';
  return null;
}

async function promptValidatedValue(
  prompt: string,
  validator: (value: string) => string | null,
  existingValue?: string,
  options?: { allowSkip?: boolean },
): Promise<string | undefined> {
  while (true) {
    const value = await ask(prompt);
    if (!value) {
      if (existingValue) return existingValue;
      if (options?.allowSkip) return undefined;
      console.log(chalk.red('  A value is required here.'));
      continue;
    }

    const error = validator(value);
    if (!error) return value;

    console.log(chalk.red(`  ${error}`));
  }
}

function appendToEnv(key: string, value: string): void {
  const envPath = join(getMercuryHome(), '.env');
  let envContent = '';
  if (existsSync(envPath)) {
    envContent = readFileSync(envPath, 'utf-8');
  }
  const lines = envContent.split('\n').filter((l: string) => !l.startsWith(`${key}=`) && l.trim() !== '');
  lines.push(`${key}=${value}`);
  writeFileSync(envPath, lines.join('\n') + '\n', 'utf-8');
  process.env[key] = value;
}

function parseGithubRepo(input: string): { owner: string; repo: string } | null {
  const trimmed = input.trim().replace(/\/+$/, '');
  const urlMatch = trimmed.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (urlMatch) return { owner: urlMatch[1], repo: urlMatch[2] };
  const shortMatch = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (shortMatch) return { owner: shortMatch[1], repo: shortMatch[2] };
  return null;
}

async function configure(existingConfig?: MercuryConfig): Promise<void> {
  const isReconfig = !!existingConfig;
  const config = existingConfig ?? loadConfig();

  if (isReconfig) {
    banner();
    console.log(chalk.yellow('  Reconfiguring Mercury — press Enter to keep current value.'));
  } else {
    splashScreen();
    console.log(chalk.yellow('  First run detected — let\'s set you up.'));
  }

  hr();
  console.log('');
  console.log(chalk.bold.white('  Identity'));
  console.log('');

  if (isReconfig) {
    const ownerName = await ask(chalk.white(`  Your name [${config.identity.owner}]: `));
    if (ownerName) config.identity.owner = ownerName;

    const agentName = await ask(chalk.white(`  Agent name [${config.identity.name}]: `));
    if (agentName) config.identity.name = agentName;
  } else {
    const ownerName = await ask(chalk.white('  Your name: '));
    if (!ownerName) {
      console.log(chalk.red('  Name is required.'));
      process.exit(1);
    }
    config.identity.owner = ownerName;

    const agentName = await ask(chalk.white(`  Agent name [${config.identity.name}]: `));
    if (agentName) config.identity.name = agentName;
  }

  config.identity.creator = config.identity.creator || 'Cosmic Stack';

  hr();
  console.log('');
  console.log(chalk.bold.white('  LLM Providers'));
  if (isReconfig) {
    console.log(chalk.dim('  Choose which providers to configure now. Existing values are shown where available.'));
  } else {
    console.log(chalk.dim('  Choose one or more providers. Press Enter to configure DeepSeek by default.'));
  }
  console.log('');

  while (true) {
    const selectedProviders = await chooseProvidersToConfigure(config, isReconfig);
    console.log('');

    for (const provider of selectedProviders) {
      if (provider === 'deepseek') {
        const mask = isReconfig && config.providers.deepseek.apiKey ? ` [${maskKey(config.providers.deepseek.apiKey)}]` : '';
        const key = await promptValidatedValue(
          chalk.white(`  DeepSeek API key${mask}${isReconfig ? '' : ' (Enter to skip)'}: `),
          (value) => validateApiKey('deepseek', value),
          isReconfig ? config.providers.deepseek.apiKey : undefined,
          { allowSkip: true },
        );
        if (key) {
          config.providers.deepseek.apiKey = key;
          config.providers.deepseek.enabled = true;
        }
        continue;
      }

      if (provider === 'openai') {
        const mask = isReconfig && config.providers.openai.apiKey ? ` [${maskKey(config.providers.openai.apiKey)}]` : '';
        const key = await promptValidatedValue(
          chalk.white(`  OpenAI API key${mask}${isReconfig ? '' : ' (Enter to skip)'}: `),
          (value) => validateApiKey('openai', value),
          isReconfig ? config.providers.openai.apiKey : undefined,
          { allowSkip: true },
        );
        if (key) {
          config.providers.openai.apiKey = key;
          config.providers.openai.enabled = true;
        }
        continue;
      }

      if (provider === 'anthropic') {
        const mask = isReconfig && config.providers.anthropic.apiKey ? ` [${maskKey(config.providers.anthropic.apiKey)}]` : '';
        const key = await promptValidatedValue(
          chalk.white(`  Anthropic API key${mask}${isReconfig ? '' : ' (Enter to skip)'}: `),
          (value) => validateApiKey('anthropic', value),
          isReconfig ? config.providers.anthropic.apiKey : undefined,
          { allowSkip: true },
        );
        if (key) {
          config.providers.anthropic.apiKey = key;
          config.providers.anthropic.enabled = true;
        }
        continue;
      }

      if (provider === 'grok') {
        const mask = isReconfig && config.providers.grok.apiKey ? ` [${maskKey(config.providers.grok.apiKey)}]` : '';
        const key = await promptValidatedValue(
          chalk.white(`  Grok API key${mask}${isReconfig ? '' : ' (Enter to skip)'}: `),
          (value) => validateApiKey('grok', value),
          isReconfig ? config.providers.grok.apiKey : undefined,
          { allowSkip: true },
        );
        if (key) {
          config.providers.grok.apiKey = key;
          config.providers.grok.enabled = true;
        }
        continue;
      }

      if (provider === 'ollamaCloud') {
        const mask = isReconfig && config.providers.ollamaCloud.apiKey ? ` [${maskKey(config.providers.ollamaCloud.apiKey)}]` : '';
        const key = await promptValidatedValue(
          chalk.white(`  Ollama Cloud API key${mask}${isReconfig ? '' : ' (Enter to skip)'}: `),
          (value) => validateApiKey('ollamaCloud', value),
          isReconfig ? config.providers.ollamaCloud.apiKey : undefined,
          { allowSkip: true },
        );
        if (key) {
          config.providers.ollamaCloud.apiKey = key;
          config.providers.ollamaCloud.enabled = true;
        }
        continue;
      }

      if (provider === 'ollamaLocal') {
        config.providers.ollamaLocal.baseUrl = (await promptValidatedValue(
          chalk.white(`  Ollama Local base URL [${config.providers.ollamaLocal.baseUrl}]: `),
          validateBaseUrl,
          config.providers.ollamaLocal.baseUrl,
        ))!;

        config.providers.ollamaLocal.model = (await promptValidatedValue(
          chalk.white(`  Ollama Local model [${config.providers.ollamaLocal.model}]: `),
          validateModelName,
          config.providers.ollamaLocal.model,
        ))!;

        config.providers.ollamaLocal.enabled = true;
      }
    }

    const configuredProviders = getConfiguredProviderNames(config);
    if (configuredProviders.length === 0) {
      console.log(chalk.red('  You need to configure at least one LLM provider to continue.'));
      console.log(chalk.dim('  Let’s try that step again.'));
      console.log('');
      continue;
    }

    await chooseDefaultProvider(config);
    break;
  }

  hr();
  console.log('');
  console.log(chalk.bold.white('  Telegram (optional)'));
  if (isReconfig) {
    console.log(chalk.dim('  Leave empty to keep current value. Enter "none" to disable.'));
  } else {
    console.log(chalk.dim('  Leave empty to skip. You can add it later.'));
    console.log(chalk.dim('  To create a bot token:'));
    console.log(chalk.dim('    1. Open Telegram and message @BotFather'));
    console.log(chalk.dim('    2. Run /newbot and follow the prompts'));
    console.log(chalk.dim('    3. Copy the bot token BotFather gives you'));
    console.log(chalk.dim('    4. Paste that token here'));
  }
  console.log('');

  const tgMask = isReconfig && config.channels.telegram.botToken ? ` [${maskKey(config.channels.telegram.botToken)}]` : '';
  const telegramToken = await ask(chalk.white(`  Telegram Bot Token${tgMask}: `));
  if (isReconfig && telegramToken.toLowerCase() === 'none') {
    config.channels.telegram.enabled = false;
    config.channels.telegram.botToken = '';
    clearTelegramPairing(config);
  } else if (telegramToken) {
    if (telegramToken !== config.channels.telegram.botToken) {
      clearTelegramPairing(config);
    }
    config.channels.telegram.botToken = telegramToken;
    config.channels.telegram.enabled = true;
  }

  hr();
  console.log('');
  console.log(chalk.bold.white('  GitHub Integration (optional)'));
  console.log(chalk.dim('  Connect Mercury to GitHub so it can create PRs, manage issues,'));
  console.log(chalk.dim('  review code, and co-author commits on your behalf.'));
  console.log(chalk.dim('  Leave empty to skip. You can add it later with mercury doctor.'));
  console.log('');

  const ghUserCurrent = isReconfig && config.github.username ? ` [${config.github.username}]` : '';
  const ghUsername = await ask(chalk.white(`  1. Your GitHub username${ghUserCurrent}: `));
  if (ghUsername) config.github.username = ghUsername;

  if (!config.github.email) {
    config.github.email = 'mercury@cosmicstack.org';
  }

  console.log('');
  console.log(chalk.dim('     You need a Personal Access Token (PAT) with repo access.'));
  console.log(chalk.dim('     Fine-grained (recommended): github.com/settings/personal-access-tokens/new'));
  console.log(chalk.dim('       → Permissions: Contents (R/W), Pull requests (R/W), Issues (R/W)'));
  console.log(chalk.dim('     Classic: github.com/settings/tokens/new'));
  console.log(chalk.dim('       → Scope: repo (full control)'));
  const ghTokenCurrent = process.env.GITHUB_TOKEN ? ` [${maskKey(process.env.GITHUB_TOKEN)}]` : '';
  const ghToken = await ask(chalk.white(`  2. GitHub PAT${ghTokenCurrent}: `));
  if (ghToken) {
    appendToEnv('GITHUB_TOKEN', ghToken);
  }

  if (config.github.username || process.env.GITHUB_TOKEN) {
    console.log('');
    console.log(chalk.dim('     Set a default repo so you can say "create an issue" without'));
    console.log(chalk.dim('     specifying the repo every time. Enter owner/name or a full URL.'));
    console.log(chalk.dim('     Example: hotheadhacker/mercury-agent'));
    console.log(chalk.dim('     Example: https://github.com/hotheadhacker/mercury-agent'));
    const ghOwnerCurrent = isReconfig && config.github.defaultOwner ? ` [${config.github.defaultOwner}/${config.github.defaultRepo}]` : '';
    const ghRepoInput = await ask(chalk.white(`  3. Default repo${ghOwnerCurrent}: `));
    if (ghRepoInput) {
      const parsed = parseGithubRepo(ghRepoInput);
      if (parsed) {
        config.github.defaultOwner = parsed.owner;
        config.github.defaultRepo = parsed.repo;
      } else {
        console.log(chalk.yellow('  Could not parse repo. Use format: owner/repo or a GitHub URL.'));
      }
    }
  }

  hr();
  console.log('');
  console.log(chalk.bold.white('  Token Budget'));
  console.log('');

  const budgetPrompt = isReconfig
    ? chalk.white(`  Daily token budget [${config.tokens.dailyBudget.toLocaleString()}]: `)
    : chalk.white(`  Daily token budget [${config.tokens.dailyBudget.toLocaleString()}]: `);
  const budgetStr = await ask(budgetPrompt);
  if (budgetStr) {
    const budget = parseInt(budgetStr.replace(/,/g, ''), 10);
    if (!isNaN(budget) && budget > 0) {
      config.tokens.dailyBudget = budget;
    }
  }

  hr();
  saveConfig(config);

  const home = getMercuryHome();
  console.log('');
  console.log(chalk.green(`  ✓ Config saved to ${home}/mercury.yaml`));
  console.log(chalk.green(`  ✓ Soul files seeded in ${home}/soul/`));
  console.log(chalk.green(`  ✓ Memory stored in ${home}/memory/`));
  console.log(chalk.green(`  ✓ Permissions seeded in ${home}/permissions.yaml`));
  console.log(chalk.green(`  ✓ Skills directory ready in ${home}/skills/`));
  console.log('');
  console.log(chalk.cyan(`  ${config.identity.name} is ready. Run \`mercury start\` to chat.`));
  console.log(chalk.dim('  mercury.cosmicstack.org'));
  console.log('');
}

function autoDaemonize(): void {
  const daemon = getDaemonStatus();
  if (daemon.running) {
    return;
  }

  console.log(chalk.dim('  Setting up background mode...'));

  try {
    if (!isServiceInstalled()) {
      installService();
    }
  } catch {
    console.log(chalk.dim('  Service install skipped (can run `mercury service install` later).'));
  }

  const ok = tryAutoDaemonize();
  if (ok) {
    const status = getDaemonStatus();
    console.log(chalk.green(`  ✓ Mercury is running in background (PID: ${status.pid})`));
    console.log(chalk.green('  ✓ Auto-starts on login. Auto-restarts on crash.'));
    console.log(chalk.dim('  Use `mercury stop` to stop. `mercury restart` to restart.'));
  } else {
    console.log(chalk.dim('  Background mode not available. Run `mercury up` to set it up.'));
  }
  console.log('');
}

async function runAgent(isDaemon: boolean = false): Promise<void> {
  let config = loadConfig();
  config = ensureCreatorField(config);
  const name = config.identity.name;

  if (!isDaemon) {
    banner();
    console.log(chalk.white(`  ${name} is waking up...`));
    console.log('');
  } else {
    logger.info(`${name} is waking up (daemon mode)...`);
  }

  const tokenBudget = new TokenBudget(config);
  const providers = new ProviderRegistry(config);

  if (!providers.hasProviders()) {
    if (isDaemon) {
      logger.error('No LLM providers available. Run `mercury doctor` to configure providers.');
      return;
    }
    console.log(chalk.red('  No LLM providers available. Run `mercury doctor` to configure providers.'));
    process.exit(1);
  }

  const available = providers.listAvailable();
  if (!isDaemon) {
    console.log(chalk.dim(`  Providers: ${available.join(', ')}`));
  } else {
    logger.info({ providers: available }, 'Providers loaded');
  }

  const skillLoader = new SkillLoader();
  const skills = skillLoader.discover();
  if (!isDaemon) {
    console.log(chalk.dim(`  Skills: ${skills.length > 0 ? skills.map(s => s.name).join(', ') : 'none installed'}`));
  }

  const scheduler = new Scheduler(config);

  const identity = new Identity();
  const shortTerm = new ShortTermMemory(config);
  const longTerm = new LongTermMemory(config);
  const episodic = new EpisodicMemory(config);

  const channels = new ChannelRegistry(config);
  const capabilities = new CapabilityRegistry(skillLoader, scheduler, tokenBudget);

  capabilities.setChatCommandContext({
    toolNames: () => capabilities.getToolNames(),
    skillNames: () => skills.map(s => s.name),
    config: () => config,
    tokenBudget: () => tokenBudget,
    manual: () => getManual(),
  });

  capabilities.setSendFileHandler(async (filePath: string) => {
    const msg = channels.getActiveChannels().includes('telegram')
      ? channels.get('telegram')
      : channels.get('cli');
    if (msg) {
      await msg.sendFile(filePath);
    }
  });

  capabilities.setSendMessageHandler(async (content: string) => {
    const telegram = channels.get('telegram');
    const pairedChatId = config.channels.telegram.pairedChatId;
    const pairedUserId = config.channels.telegram.pairedUserId;

    if (!config.channels.telegram.enabled || !telegram) {
      throw new Error('Telegram is not configured. Add a bot token in setup or run `mercury doctor`.');
    }

    if (pairedChatId == null || pairedUserId == null) {
      throw new Error('Telegram is not paired. Complete the pairing flow with /start or /pair from the Telegram owner account.');
    }

    await telegram.send(content, `telegram:${pairedChatId}`);
  });
  if (process.env.GITHUB_TOKEN) {
    setGitHubToken(process.env.GITHUB_TOKEN);
  }

  capabilities.registerAll();

  const agent = new Agent(
    config, providers, identity, shortTerm, longTerm, episodic, channels, tokenBudget, capabilities, scheduler,
  );

  await agent.birth();
  await agent.wake();

  const cliChannel = channels.get('cli') as CLIChannel | undefined;
  const tgChannel = channels.get('telegram') as TelegramChannel | undefined;

  capabilities.permissions.onAsk(async (prompt: string) => {
    const channelType = capabilities.permissions.getCurrentChannelType();
    if (channelType === 'telegram' && tgChannel) {
      return tgChannel.askPermission(prompt);
    }
    if (cliChannel) {
      return cliChannel.askPermission(prompt);
    }
    return 'no';
  });

  const activeCh = channels.getActiveChannels();
  const toolNames = capabilities.getToolNames();

  if (!isDaemon) {
    console.log(chalk.dim(`  Channels: ${activeCh.join(', ')}`));
    console.log(chalk.dim(`  Tools: ${toolNames.join(', ')}`));
    console.log(chalk.dim(`  Permissions: ${getMercuryHome()}/permissions.yaml`));
    console.log(chalk.dim(`  Schedules: ${getMercuryHome()}/schedules.yaml`));
    if (config.identity.creator) {
      console.log(chalk.dim(`  Creator: ${config.identity.creator}`));
    }
    hr();
    console.log('');
    console.log(chalk.green(`  ${name} is live. Type a message and press Enter.`));
    console.log(chalk.dim('  Ctrl+C to exit · /help for commands'));
    console.log('');
  } else {
    logger.info({ channels: activeCh, tools: toolNames }, 'Mercury is live (daemon mode)');
  }

  const shutdown = async () => {
    if (!isDaemon) {
      console.log('');
      console.log(chalk.dim(`  ${name} is shutting down...`));
    } else {
      logger.info('Mercury is shutting down (daemon mode)');
    }
    await agent.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const program = new Command();

program
  .name('mercury')
  .description('Mercury — Soul-driven AI agent with permission-hardened tools, token budgets, and multi-channel access.')
  .version(pkgVersion)
  .option('-v, --verbose', 'Show debug logs')
  .action(async () => {
    if (!isSetupComplete()) {
      await configure();
      autoDaemonize();
      return;
    }
    await runAgent();
  });

program
  .command('start')
  .description('Start Mercury agent')
  .option('-v, --verbose', 'Show debug logs')
  .option('-d, --detached', 'Run in background (daemon mode)')
  .option('--daemon', 'Internal flag for daemon child process')
  .action(async (opts) => {
    if (opts.daemon) {
      await runWithWatchdog(() => runAgent(true));
      return;
    }

    if (opts.detached) {
      startBackground();
      return;
    }

    if (!isSetupComplete()) {
      await configure();
      return;
    }
    await runAgent();
  });

program
  .command('stop')
  .description('Stop a background Mercury process')
  .action(() => {
    stopDaemon();
  });

program
  .command('restart')
  .description('Restart a background Mercury process')
  .action(() => {
    restartDaemon();
  });

program
  .command('up')
  .description('Ensure Mercury is running persistently — installs service if needed, starts daemon')
  .action(async () => {
    if (!isSetupComplete()) {
      await configure();
    }

    const daemon = getDaemonStatus();

    if (daemon.running && daemon.pid) {
      console.log('');
      console.log(chalk.green(`  Mercury is already running (PID: ${daemon.pid})`));
      console.log(chalk.dim(`  Logs: ${daemon.logPath}`));
      console.log('');
      return;
    }

    if (!isServiceInstalled()) {
      console.log('');
      console.log(chalk.cyan('  Installing Mercury as a system service...'));
      installService();
    }

    console.log(chalk.cyan('  Starting Mercury in background...'));
    startBackground();
  });

program
  .command('logs')
  .description('Show recent daemon logs')
  .action(() => {
    showLogs();
  });

program
  .command('setup')
  .description('Re-run the setup wizard (reconfigure)')
  .action(async () => {
    if (isSetupComplete()) {
      await configure(loadConfig());
    } else {
      await configure();
    }
  });

program
  .command('doctor')
  .description('Reconfigure Mercury — change keys, name, settings (Enter to keep current)')
  .action(async () => {
    if (isSetupComplete()) {
      await configure(loadConfig());
    } else {
      await configure();
    }
  });

program
  .command('status')
  .description('Show current configuration and daemon status')
  .action(() => {
    const config = loadConfig();
    const home = getMercuryHome();
    const skillLoader = new SkillLoader();
    const skills = skillLoader.discover();
    const daemon = getDaemonStatus();
    banner();
    console.log(`  Name:     ${chalk.cyan(config.identity.name)}`);
    console.log(`  Owner:    ${chalk.white(config.identity.owner || '(not set)')}`);
    if (config.identity.creator) {
      console.log(`  Creator:  ${chalk.white(config.identity.creator)}`);
    }
    console.log(`  Provider: ${chalk.white(getProviderLabel(config.providers.default))}`);
    console.log(`  Telegram: ${config.channels.telegram.enabled ? chalk.green('enabled') : chalk.dim('disabled')}`);
    console.log(`  Telegram Pairing: ${config.channels.telegram.pairedUserId != null ? chalk.green(`paired to user ${config.channels.telegram.pairedUserId}${config.channels.telegram.pairedUsername ? ` (@${config.channels.telegram.pairedUsername})` : ''}`) : chalk.dim('unpaired')}`);
    console.log(`  Skills:   ${skills.length > 0 ? chalk.green(skills.map(s => s.name).join(', ')) : chalk.dim('none')}`);
    console.log(`  Budget:   ${chalk.white(config.tokens.dailyBudget.toLocaleString())} tokens/day`);
    console.log(`  Setup:    ${isSetupComplete() ? chalk.green('complete') : chalk.red('not done')}`);
    console.log(`  Daemon:   ${daemon.running ? chalk.green(`running (PID: ${daemon.pid})`) : chalk.dim('not running')}`);
    console.log(`  Home:     ${chalk.dim(home)}`);
    console.log('');
  });

program
  .command('help')
  .description('Show capabilities and commands manual')
  .action(() => {
    console.log(getManual());
  });

const telegramCmd = program
  .command('telegram')
  .description('Manage Telegram pairing and access');

telegramCmd
  .command('unpair')
  .description('Clear the paired Telegram owner for this Mercury instance')
  .action(() => {
    const config = loadConfig();
    const daemon = getDaemonStatus();
    if (config.channels.telegram.pairedUserId == null) {
      console.log('');
      console.log(chalk.dim('  Telegram is already unpaired.'));
      console.log('');
      return;
    }

    clearTelegramPairing(config);
    saveConfig(config);

    console.log('');
    console.log(chalk.green('  ✓ Telegram pairing cleared.'));
    if (daemon.running) {
      console.log(chalk.dim('  Restarting the background daemon to apply the change immediately...'));
      restartDaemon();
    } else {
      console.log(chalk.dim('  The next private Telegram user to send /start will pair this Mercury instance.'));
    }
    console.log('');
  });

const serviceCmd = program
  .command('service')
  .description('Manage Mercury as a system service (auto-start, crash recovery)');

serviceCmd
  .command('install')
  .description('Install Mercury as a system service (auto-start on boot)')
  .action(() => {
    installService();
  });

serviceCmd
  .command('uninstall')
  .description('Uninstall the system service')
  .action(() => {
    uninstallService();
  });

serviceCmd
  .command('status')
  .description('Show system service status')
  .action(() => {
    showServiceStatus();
  });

program.parse();
