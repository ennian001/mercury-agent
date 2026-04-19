import { Command } from 'commander';
import readline from 'node:readline';
import chalk from 'chalk';
import { loadConfig, saveConfig, isSetupComplete, getMercuryHome } from './utils/config.js';
import { logger } from './utils/logger.js';
import { Identity } from './soul/identity.js';
import { ShortTermMemory, LongTermMemory, EpisodicMemory } from './memory/store.js';
import { ProviderRegistry } from './providers/registry.js';
import { Agent } from './core/agent.js';
import { ChannelRegistry } from './channels/registry.js';
import { CLIChannel } from './channels/cli.js';
import { TokenBudget } from './utils/tokens.js';
import { SkillLoader } from './skills/loader.js';

function hr() {
  console.log(chalk.dim('─'.repeat(50)));
}

function banner() {
  console.log('');
  console.log(chalk.cyan('  ╦═╗┌─┐┌┬┐┬┬  ┬┌─┐'));
  console.log(chalk.cyan('  ╠╦╝├┤  │ ││  │├┤ '));
  console.log(chalk.cyan('  ╩╚═└─┘ ┴ ┴┴─┘└─┘'));
  console.log(chalk.dim('     v0.1.0 — an AI agent for personal tasks'));
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

async function onboarding(): Promise<void> {
  banner();
  console.log(chalk.yellow('  First run detected — let\'s set you up.'));
  hr();
  console.log('');

  const config = loadConfig();

  const ownerName = await ask(chalk.white('  Your name: '));
  if (!ownerName) {
    console.log(chalk.red('  Name is required.'));
    process.exit(1);
  }
  config.identity.owner = ownerName;

  const agentName = await ask(chalk.white(`  Agent name [${config.identity.name}]: `));
  if (agentName) config.identity.name = agentName;

  hr();
  console.log('');
  console.log(chalk.white('  LLM Providers'));
  console.log(chalk.dim('  At least one API key is required.'));
  console.log('');

  const deepseekKey = await ask(chalk.white('  DeepSeek API key: '));
  if (deepseekKey) {
    config.providers.deepseek.apiKey = deepseekKey;
    config.providers.default = 'deepseek';
  }

  const openaiKey = await ask(chalk.white('  OpenAI API key (Enter to skip): '));
  if (openaiKey) config.providers.openai.apiKey = openaiKey;

  const anthropicKey = await ask(chalk.white('  Anthropic API key (Enter to skip): '));
  if (anthropicKey) config.providers.anthropic.apiKey = anthropicKey;

  if (!deepseekKey && !openaiKey && !anthropicKey) {
    console.log(chalk.red('\n  At least one LLM API key is required.'));
    process.exit(1);
  }

  hr();
  console.log('');
  console.log(chalk.white('  Telegram (optional)'));
  console.log(chalk.dim('  Leave empty to skip. You can add it later.'));
  console.log('');

  const telegramToken = await ask(chalk.white('  Telegram Bot Token: '));
  if (telegramToken) {
    config.channels.telegram.botToken = telegramToken;
    config.channels.telegram.enabled = true;
  }

  hr();
  saveConfig(config);

  const home = getMercuryHome();
  console.log('');
  console.log(chalk.green(`  ✓ Config saved to ${home}/mercury.yaml`));
  console.log(chalk.green(`  ✓ Soul files will be seeded in ${home}/soul/`));
  console.log(chalk.green(`  ✓ Memory stored in ${home}/memory/`));
  console.log('');
  console.log(chalk.cyan(`  ${config.identity.name} is ready. Run \`mercury start\` to begin.`));
  console.log('');
}

async function runAgent(): Promise<void> {
  const config = loadConfig();
  const name = config.identity.name;

  banner();
  console.log(chalk.white(`  ${name} is waking up...`));
  console.log('');

  const tokenBudget = new TokenBudget(config);
  const providers = new ProviderRegistry(config);

  if (!providers.hasProviders()) {
    console.log(chalk.red('  No LLM providers available. Run `mercury setup` to configure API keys.'));
    process.exit(1);
  }

  const available = providers.listAvailable();
  console.log(chalk.dim(`  Providers: ${available.join(', ')}`));

  const identity = new Identity();
  const shortTerm = new ShortTermMemory(config);
  const longTerm = new LongTermMemory(config);
  const episodic = new EpisodicMemory(config);
  const skillLoader = new SkillLoader();
  const skills = skillLoader.discover();
  if (skills.length > 0) {
    console.log(chalk.dim(`  Skills: ${skills.map(s => s.name).join(', ')}`));
  }

  const channels = new ChannelRegistry(config);

  const agent = new Agent(
    config, providers, identity, shortTerm, longTerm, episodic, channels, tokenBudget,
  );

  await agent.birth();
  await agent.wake();

  const cliChannel = channels.get('cli') as CLIChannel | undefined;

  const activeCh = channels.getActiveChannels();
  console.log(chalk.dim(`  Channels: ${activeCh.join(', ')}`));
  hr();
  console.log('');
  console.log(chalk.green(`  ${name} is live. Type a message and press Enter.`));
  console.log(chalk.dim('  Ctrl+C to exit.'));
  console.log('');

  cliChannel?.showPrompt();

  const shutdown = async () => {
    console.log('');
    console.log(chalk.dim(`  ${name} is shutting down...`));
    await agent.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const program = new Command();

program
  .name('mercury')
  .description('Mercury — an AI agent for personal tasks')
  .version('0.1.0')
  .action(async () => {
    if (!isSetupComplete()) {
      await onboarding();
      return;
    }
    await runAgent();
  });

program
  .command('start')
  .description('Start Mercury agent')
  .action(async () => {
    if (!isSetupComplete()) {
      await onboarding();
      return;
    }
    await runAgent();
  });

program
  .command('setup')
  .description('Re-run the setup wizard')
  .action(async () => {
    await onboarding();
  });

program
  .command('status')
  .description('Show current configuration')
  .action(() => {
    const config = loadConfig();
    const home = getMercuryHome();
    banner();
    console.log(`  Name:     ${chalk.cyan(config.identity.name)}`);
    console.log(`  Owner:    ${chalk.white(config.identity.owner || '(not set)')}`);
    console.log(`  Provider: ${chalk.white(config.providers.default)}`);
    console.log(`  Telegram: ${config.channels.telegram.enabled ? chalk.green('enabled') : chalk.dim('disabled')}`);
    console.log(`  Budget:   ${chalk.white(config.tokens.dailyBudget)} tokens/day`);
    console.log(`  Setup:    ${isSetupComplete() ? chalk.green('complete') : chalk.red('not done')}`);
    console.log(`  Home:     ${chalk.dim(home)}`);
    console.log('');
  });

program.parse();