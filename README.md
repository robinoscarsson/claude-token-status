# Claude Code Token Status

A VS Code extension that shows your Claude Code token budget — for the current session and the current week — right in the status bar, including when each limit resets.

```
✓ Session 93% · Week 74%
```

Hover for details:

```
Claude Code – Token Budget

Session: 7% used (93% remaining)
4 hours, 36 minutes to reset

Week: 26% used (74% remaining)
1 day, 20 hours to reset

Updated: 3:41:12 PM

Click to refresh.
```

## How it works

The extension doesn't talk to Anthropic's servers itself. It simply shells out to the Claude Code CLI you already have installed and logged in:

```
claude -p "/usage" --output-format json
```

This is the same `/usage` command you'd type inside an interactive Claude Code session — it costs no tokens and makes no model call. The extension parses the CLI's response into structured percentages and reset timestamps, and re-runs it on a timer.

Because it relies entirely on your existing `claude` login, the extension never reads your credentials, never talks to the network on its own, and has no notion of your account beyond what the CLI already reports.

## Requirements

- [Claude Code](https://claude.com/claude-code) CLI installed and available on `PATH` (or pointed to via `claudeTokenStatus.claudePath`)
- Logged in to a Claude Code subscription (Pro, Max 5x, or Max 20x) — session/week limits only apply to subscription plans, not API-key billing

## Status bar states

| State | What it means |
|---|---|
| `✓ Session X% · Week Y%` | Normal — showing remaining budget for both windows |
| `⊘ Claude Code not found` | The `claude` executable couldn't be found — install it or set `claudeTokenStatus.claudePath` |
| `👤 Claude Code: not logged in` | The CLI is installed but no one is logged in — run `claude` in a terminal and complete login |
| `⚠ Claude Code: fetch failed` | Logged in, but the CLI couldn't reach the backend for usage numbers (e.g. no network) |
| `⚠ Claude Code timed out` | The CLI didn't respond in time |
| `⚠ Claude Code CLI error` | The CLI exists but couldn't be executed (e.g. permissions) |
| `⚠ Claude Code: unexpected response` | The CLI responded in a format the extension doesn't recognize |

Hovering over any of these shows a specific, actionable message in the tooltip.

## Commands

- **Claude Token Status: Refresh** — manually re-fetch usage right now (also triggered by clicking the status bar item)
- **Claude Token Status: Open Session Transcript** — opens the most recently modified transcript file for the current workspace from `~/.claude/projects/`

## Settings

| Setting | Default | Description |
|---|---|---|
| `claudeTokenStatus.warnThresholdPercent` | `20` | Show a yellow warning when remaining budget drops below this percentage |
| `claudeTokenStatus.criticalThresholdPercent` | `5` | Show a red warning when remaining budget drops below this percentage |
| `claudeTokenStatus.refreshIntervalMinutes` | `5` | How often to automatically re-fetch usage |
| `claudeTokenStatus.claudePath` | `claude` | Path to the `claude` executable, if it isn't on `PATH` |

## Development

```bash
npm install
npm run compile   # one-off build
npm run watch      # rebuild on change
```

Press **F5** in VS Code to launch an Extension Development Host with the extension loaded.

### Installing a build locally

```bash
./scripts/reinstall.sh
```

Packages the extension into a `.vsix` and installs it into your regular VS Code. Run **Developer: Reload Window** afterwards to pick it up.
