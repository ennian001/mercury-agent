import chalk from 'chalk';

export function getManual(): string {
  const sections: string[] = [];

  sections.push('');
  sections.push(chalk.bold.cyan('  MERCURY — Capabilities & Commands'));
  sections.push(chalk.dim('  ─────────────────────────────────────────'));
  sections.push('');

  sections.push(chalk.bold.white('  Built-in Tools'));
  sections.push(chalk.dim('  Tools Mercury can use during conversations.'));
  sections.push('');

  const tools = [
    ['read_file', 'Read file contents', 'path (required)'],
    ['write_file', 'Write to an existing file', 'path, content'],
    ['create_file', 'Create a new file (+ dirs)', 'path, content'],
    ['edit_file', 'Replace specific text in a file', 'path, old_string, new_string'],
    ['list_dir', 'List directory contents', 'path'],
    ['delete_file', 'Delete a file', 'path'],
    ['run_command', 'Execute a shell command', 'command'],
    ['approve_command', 'Permanently approve a command type', 'command (e.g. "curl")'],
    ['fetch_url', 'Fetch a URL and return content', 'url, format? (text/markdown)'],
    ['git_status', 'Show working tree status', 'path?'],
    ['git_diff', 'Show file changes', 'path?, staged?'],
    ['git_log', 'Show commit history', 'count?, path?'],
    ['git_add', 'Stage files for commit', 'paths (array)'],
    ['git_commit', 'Create a commit', 'message'],
    ['git_push', 'Push to remote (needs approval)', 'remote?, branch?'],
    ['install_skill', 'Install a skill from content or URL', 'content? or url?'],
    ['list_skills', 'List installed skills', '—'],
    ['use_skill', 'Invoke a skill by name', 'name'],
    ['schedule_task', 'Schedule a recurring or delayed task', 'cron? or delay_seconds, description, prompt? or skill_name?'],
    ['list_scheduled_tasks', 'List all scheduled tasks', '—'],
    ['cancel_scheduled_task', 'Cancel a scheduled task', 'id'],
    ['budget_status', 'Check token budget', '—'],
  ];

  for (const [name, desc, params] of tools) {
    sections.push(`  ${chalk.cyan(name.padEnd(24))} ${desc}`);
    sections.push(`  ${' '.repeat(24)} ${chalk.dim(params)}`);
  }

  sections.push('');
  sections.push(chalk.bold.white('  CLI Commands'));
  sections.push(chalk.dim('  Run these from your terminal (no API calls consumed).'));
  sections.push('');

  const commands = [
    ['mercury up', 'Start persistently (install service + daemon)'],
    ['mercury', 'Start the agent (same as mercury start)'],
    ['mercury start', 'Start the agent in foreground'],
    ['mercury start -d', 'Start in background (daemon mode)'],
    ['mercury restart', 'Restart a background process'],
    ['mercury stop', 'Stop a background process'],
    ['mercury logs', 'Show recent daemon logs'],
    ['mercury doctor', 'Reconfigure settings (Enter keeps current)'],
    ['mercury setup', 'Re-run the setup wizard'],
    ['mercury status', 'Show config and daemon status'],
    ['mercury help', 'Show this manual'],
    ['mercury service install', 'Install as system service (auto-start)'],
    ['mercury service uninstall', 'Uninstall system service'],
    ['mercury service status', 'Show system service status'],
    ['mercury --verbose', 'Start with debug logging on stderr'],
  ];

  for (const [cmd, desc] of commands) {
    sections.push(`  ${chalk.white(cmd.padEnd(26))} ${desc}`);
  }

  sections.push('');
  sections.push(chalk.bold.white('  In-Chat Commands'));
  sections.push(chalk.dim('  Type these during a conversation (no API calls).'));
  sections.push('');

  const chat = [
    ['/help', 'Show this manual'],
    ['/status', 'Show config and budget info'],
    ['/tools', 'List currently loaded tools'],
    ['/skills', 'List installed skills'],
  ];

  for (const [cmd, desc] of chat) {
    sections.push(`  ${chalk.white(cmd.padEnd(16))} ${desc}`);
  }

  sections.push('');
  sections.push(chalk.bold.white('  Permissions'));
  sections.push('');

  const perms = [
    'Commands are blocked (never run), auto-approved, or need approval.',
    'Say "always" when prompted to permanently approve a command type.',
    'Edit ~/.mercury/permissions.yaml to customize manually.',
    'File access is scoped — new paths need approval (y/n/always).',
  ];

  for (const p of perms) {
    sections.push(`  ${chalk.dim('•')} ${p}`);
  }

  sections.push('');
  sections.push(chalk.bold.white('  Skills'));
  sections.push('');

  const skillInfo = [
    'Skills live in ~/.mercury/skills/<name>/SKILL.md',
    'Install: ask Mercury to "install skill from <url>" or paste content',
    'Invoke: ask Mercury to "use skill <name>"',
    'Schedule: "remind me daily at 9am to run daily-digest skill"',
  ];

  for (const s of skillInfo) {
    sections.push(`  ${chalk.dim('•')} ${s}`);
  }

  sections.push('');
  sections.push(chalk.bold.white('  Scheduling'));
  sections.push('');

  const schedInfo = [
    'Recurring: "every day at 9am remind me to…"',
    'One-shot: "remind me in 15 seconds to…"',
    'Tasks persist to ~/.mercury/schedules.yaml',
  ];

  for (const s of schedInfo) {
    sections.push(`  ${chalk.dim('•')} ${s}`);
  }

  sections.push('');
  sections.push(chalk.bold.white('  Configuration'));
  sections.push('');

  const configInfo = [
    ['~/.mercury/mercury.yaml', 'Main config (providers, channels, budget)'],
    ['~/.mercury/permissions.yaml', 'Capabilities and approval rules'],
    ['~/.mercury/soul/*.md', 'Agent personality (soul, persona, taste, heartbeat)'],
    ['~/.mercury/skills/', 'Installed skills'],
    ['~/.mercury/schedules.yaml', 'Scheduled tasks'],
    ['~/.mercury/token-usage.json', 'Daily token usage tracking'],
    ['~/.mercury/memory/', 'Short-term, long-term, episodic memory'],
  ];

  for (const [path, desc] of configInfo) {
    sections.push(`  ${chalk.dim(path.padEnd(36))} ${desc}`);
  }

  sections.push('');
  sections.push(chalk.dim('  mercury.cosmicstack.org'));
  sections.push('');

  return sections.join('\n');
}