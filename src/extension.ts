import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fetchUsageStatus, UsageFetchError, UsageFetchErrorKind, UsageLimit, UsageStatus } from './claudeUsage';

let statusBarItem: vscode.StatusBarItem;
let refreshTimer: NodeJS.Timeout | undefined;
let renderTimer: NodeJS.Timeout | undefined;
let lastStatus: UsageStatus | undefined;
let lastError: Error | undefined;

const ERROR_STATUS_TEXT: Record<UsageFetchErrorKind, string> = {
    'not-installed': '$(circle-slash) Claude Code not found',
    'not-executable': '$(warning) Claude Code CLI error',
    'timed-out': '$(warning) Claude Code timed out',
    'not-logged-in': '$(account) Claude Code: not logged in',
    'fetch-failed': '$(warning) Claude Code: fetch failed',
    'unexpected-response': '$(warning) Claude Code: unexpected response'
};

export function activate(context: vscode.ExtensionContext) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'claudeTokenStatus.refresh';
    context.subscriptions.push(statusBarItem);

    context.subscriptions.push(
        vscode.commands.registerCommand('claudeTokenStatus.refresh', () => refresh(true))
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('claudeTokenStatus.openTranscript', openLatestTranscript)
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('claudeTokenStatus')) {
                scheduleTimer();
                refresh(false);
            }
        })
    );

    statusBarItem.show();
    scheduleTimer();
    refresh(false);

    // Recomputes the countdown text every minute without doing a new fetch.
    renderTimer = setInterval(() => render(), 60 * 1000);
    context.subscriptions.push({ dispose: () => clearInterval(renderTimer) });
}

export function deactivate() {
    if (refreshTimer) {
        clearInterval(refreshTimer);
    }
    if (renderTimer) {
        clearInterval(renderTimer);
    }
}

function scheduleTimer() {
    if (refreshTimer) {
        clearInterval(refreshTimer);
    }
    const config = vscode.workspace.getConfiguration('claudeTokenStatus');
    const minutes = Math.max(1, config.get<number>('refreshIntervalMinutes', 5));
    refreshTimer = setInterval(() => refresh(false), minutes * 60 * 1000);
}

async function refresh(manual: boolean) {
    const config = vscode.workspace.getConfiguration('claudeTokenStatus');
    const claudePath = config.get<string>('claudePath', 'claude');
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();

    if (manual) {
        statusBarItem.text = '$(sync~spin) Claude Token Status';
    }

    try {
        lastStatus = await fetchUsageStatus(claudePath, cwd, 15000);
        lastError = undefined;
    } catch (e) {
        lastError = e as Error;
        if (manual) {
            vscode.window.showErrorMessage(`Claude Token Status: ${lastError.message}`);
        }
    }

    render();
}

function render() {
    const config = vscode.workspace.getConfiguration('claudeTokenStatus');
    const warnThreshold = config.get<number>('warnThresholdPercent', 20);
    const criticalThreshold = config.get<number>('criticalThresholdPercent', 5);

    if (!lastStatus) {
        if (lastError instanceof UsageFetchError) {
            statusBarItem.text = ERROR_STATUS_TEXT[lastError.kind];
            statusBarItem.tooltip = lastError.message;
        } else {
            statusBarItem.text = '$(warning) Claude Token Status';
            statusBarItem.tooltip = lastError
                ? `Failed to fetch token status.\n\n${lastError.message}`
                : 'Fetching token status…';
        }
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        return;
    }

    const sessionRemaining = 100 - lastStatus.session.percentUsed;
    const weekRemaining = 100 - lastStatus.week.percentUsed;
    const worstRemaining = Math.min(sessionRemaining, weekRemaining);

    let icon = '$(check)';
    statusBarItem.backgroundColor = undefined;
    if (worstRemaining < criticalThreshold) {
        icon = '$(alert)';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (worstRemaining < warnThreshold) {
        icon = '$(warning)';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }

    statusBarItem.text = `${icon} Session ${sessionRemaining}% · Week ${weekRemaining}%`;

    const lines = [
        `**Claude Code – Token Budget**`,
        ``,
        `Session: ${lastStatus.session.percentUsed}% used (${sessionRemaining}% remaining)`,
        formatDurationToReset(lastStatus.session),
        ``,
        `Week: ${lastStatus.week.percentUsed}% used (${weekRemaining}% remaining)`,
        formatDurationToReset(lastStatus.week),
        ``,
        `Updated: ${lastStatus.fetchedAt.toLocaleTimeString()}`,
        ``,
        `Click to refresh.`
    ];
    const tooltip = new vscode.MarkdownString(lines.join('\n'));
    tooltip.isTrusted = true;
    statusBarItem.tooltip = tooltip;
}

function formatDurationToReset(limit: UsageLimit): string {
    if (!limit.resetsAt) {
        return limit.resetsAtRaw;
    }

    const diffMs = limit.resetsAt.getTime() - Date.now();
    if (diffMs <= 0) {
        return 'Resetting now';
    }

    const totalMinutes = Math.round(diffMs / 60000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;

    const parts: string[] = [];
    if (days > 0) {
        parts.push(`${days} day${days === 1 ? '' : 's'}`);
    }
    if (hours > 0) {
        parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
    }
    if (minutes > 0 || parts.length === 0) {
        parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
    }

    return `${parts.slice(0, 2).join(', ')} to reset`;
}

function encodeProjectPath(cwd: string): string {
    return cwd.replace(/[/\\]/g, '-');
}

async function openLatestTranscript() {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) {
        vscode.window.showErrorMessage('Claude Token Status: No open workspace folder to find a transcript for.');
        return;
    }

    const projectDir = path.join(os.homedir(), '.claude', 'projects', encodeProjectPath(cwd));

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(projectDir, { withFileTypes: true });
    } catch {
        vscode.window.showErrorMessage(`Claude Token Status: No transcript folder found for this workspace (${projectDir}).`);
        return;
    }

    const transcripts = entries
        .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
        .map((e) => {
            const full = path.join(projectDir, e.name);
            return { full, mtime: fs.statSync(full).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);

    if (transcripts.length === 0) {
        vscode.window.showErrorMessage('Claude Token Status: No transcripts found for this workspace.');
        return;
    }

    const doc = await vscode.workspace.openTextDocument(transcripts[0].full);
    await vscode.window.showTextDocument(doc, { preview: false });
}
