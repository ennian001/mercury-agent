# Release v0.4.0

## ☿ Mercury Agent v0.4.0

**Persistent working directory, Ollama support, Telegram messaging, and more.**

### Highlights

- **`cd` tool** — Change directories persistently. All subsequent file, shell, and git operations use the new working directory. No more lost `cd` between commands.
- **Relative path support** — All 8 filesystem tools and all 6 git tools now resolve relative paths against the current working directory instead of `process.cwd()`.
- **`run_command` learns `cd`** — Running `cd /some/path` or `cd /some/path && ls` in `run_command` automatically updates the persistent working directory.
- **Ollama provider** — Run Mercury fully locally with Ollama. Added during onboarding with model selection.
- **Telegram paired messaging** — New `send_message` tool lets the agent proactively send messages to the paired Telegram chat.
- **Improved onboarding** — Relaxed provider setup, better Telegram guidance, Ollama configuration flow.

### What's New

- `cd` tool — persistent directory changes across all tool calls
- `currentCwd` state in `CapabilityRegistry` with `getCwd()`/`setCwd()`
- `send_message` capability for paired Telegram chats
- Ollama provider (`ollama-ai-provider`) with onboarding setup
- Enhanced Telegram channel with paired messaging support

### Fixes & Improvements

- All filesystem tools (`read_file`, `write_file`, `create_file`, `list_dir`, `delete_file`, `edit_file`, `send_file`, `approve_scope`) now resolve relative paths against current working directory
- All git tools (`git_status`, `git_diff`, `git_log`, `git_add`, `git_commit`, `git_push`) now use `cwd: getCwd()` in `execSync`
- `run_command` uses persistent `cwd` and auto-detects directory changes
- Improved provider onboarding flow with Ollama support
- Enhanced `.env.example` with all available configuration options
- Updated documentation with new tools and provider setup

### Migration from v0.3.x

No configuration changes required. The `cd` tool is automatically registered. Existing relative paths in tool calls will now resolve against the persistent working directory (defaults to `process.cwd()` on startup, same as before).

### Credits

- Persistent working directory implementation — @salmanqureshi
- Ollama provider & onboarding improvements — @salmanqureshi
- Telegram paired messaging — @salmanqureshi
- Social media & documentation updates — reviewed by PR #3 contributors

---

**Full Changelog**: https://github.com/cosmicstack-labs/mercury-agent/compare/v0.3.4...v0.4.0