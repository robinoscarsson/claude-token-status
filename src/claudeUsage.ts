import { execFile, ExecFileException } from 'child_process';

/**
 * Distinguishes *why* a usage fetch failed, so the UI can show a specific,
 * actionable message instead of a generic "something went wrong".
 */
export type UsageFetchErrorKind =
    | 'not-installed'
    | 'not-executable'
    | 'timed-out'
    | 'not-logged-in'
    | 'fetch-failed'
    | 'unexpected-response';

export class UsageFetchError extends Error {
    constructor(public readonly kind: UsageFetchErrorKind, message: string) {
        super(message);
        this.name = 'UsageFetchError';
    }
}

export interface UsageLimit {
    percentUsed: number;
    /** Raw text from the CLI, e.g. "Aug 27, 2:20am (Europe/Stockholm)". */
    resetsAtRaw: string;
    /** Parsed timestamp, if the text could be parsed. */
    resetsAt?: Date;
}

export interface UsageStatus {
    session: UsageLimit;
    week: UsageLimit;
    raw: string;
    fetchedAt: Date;
}

const SESSION_RE = /Current session:\s*(\d+)%\s*used\s*·\s*resets\s*(.+)/i;
const WEEK_RE = /Current week[^:]*:\s*(\d+)%\s*used\s*·\s*resets\s*(.+)/i;

// When the CLI has no logged-in session, "/usage" silently falls back to a
// plain cost/turn summary (as if nothing was asked) instead of an error.
const NOT_LOGGED_IN_RE = /^Total cost:/m;
// When the CLI is logged in but couldn't reach the backend for usage numbers
// (e.g. no network), it echoes only the static header line with no figures.
const FETCH_FAILED_RE = /power your Claude Code usage/i;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const RESET_TIME_RE = /^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)$/i;

/** Computes the difference (in minutes) between a time zone's local clock and UTC at a given instant. */
function tzOffsetMinutes(date: Date, timeZone: string): number {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    const parts = dtf.formatToParts(date);
    const map: Record<string, string> = {};
    for (const part of parts) {
        map[part.type] = part.value;
    }
    const asUtc = Date.UTC(
        Number(map.year), Number(map.month) - 1, Number(map.day),
        Number(map.hour), Number(map.minute), Number(map.second)
    );
    return (asUtc - date.getTime()) / 60000;
}

function zonedWallTimeToUtc(year: number, monthIndex: number, day: number, hour: number, minute: number, timeZone: string): Date {
    const guess = new Date(Date.UTC(year, monthIndex, day, hour, minute));
    const offsetMinutes = tzOffsetMinutes(guess, timeZone);
    return new Date(guess.getTime() - offsetMinutes * 60000);
}

/** Parses the CLI's reset text (e.g. "Aug 27, 2:20am (Europe/Stockholm)") into a Date object. */
export function parseResetDate(resetsAt: string, now: Date): Date | undefined {
    const match = RESET_TIME_RE.exec(resetsAt.trim());
    if (!match) {
        return undefined;
    }
    const [, monthName, dayStr, hour12Str, minuteStr, ampm, timeZone] = match;
    const monthIndex = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase());
    if (monthIndex === -1) {
        return undefined;
    }

    const day = Number(dayStr);
    let hour = Number(hour12Str) % 12;
    if (ampm.toLowerCase() === 'pm') {
        hour += 12;
    }
    const minute = minuteStr ? Number(minuteStr) : 0;

    try {
        let resolved = zonedWallTimeToUtc(now.getUTCFullYear(), monthIndex, day, hour, minute, timeZone);
        // Handles year boundaries, e.g. "now" is Dec 31 and the reset is "Jan 2".
        if (resolved.getTime() < now.getTime() - 24 * 60 * 60 * 1000) {
            resolved = zonedWallTimeToUtc(now.getUTCFullYear() + 1, monthIndex, day, hour, minute, timeZone);
        }
        return resolved;
    } catch {
        // Unknown/invalid IANA time zone.
        return undefined;
    }
}

export function parseUsageOutput(text: string, now: Date = new Date()): UsageStatus {
    const sessionMatch = SESSION_RE.exec(text);
    const weekMatch = WEEK_RE.exec(text);

    if (!sessionMatch || !weekMatch) {
        if (NOT_LOGGED_IN_RE.test(text)) {
            throw new UsageFetchError(
                'not-logged-in',
                'Not logged in to Claude Code. Run "claude" in a terminal and complete login, then refresh.'
            );
        }
        if (FETCH_FAILED_RE.test(text)) {
            throw new UsageFetchError(
                'fetch-failed',
                'Claude Code could not fetch your usage data (possibly a network issue). Try refreshing again shortly.'
            );
        }
        throw new UsageFetchError(
            'unexpected-response',
            `Unrecognized output from "claude -p /usage": ${text}`
        );
    }

    const sessionResetsAtRaw = sessionMatch[2].trim();
    const weekResetsAtRaw = weekMatch[2].trim();

    return {
        session: {
            percentUsed: Number(sessionMatch[1]),
            resetsAtRaw: sessionResetsAtRaw,
            resetsAt: parseResetDate(sessionResetsAtRaw, now)
        },
        week: {
            percentUsed: Number(weekMatch[1]),
            resetsAtRaw: weekResetsAtRaw,
            resetsAt: parseResetDate(weekResetsAtRaw, now)
        },
        raw: text,
        fetchedAt: now
    };
}

export function fetchUsageStatus(claudePath: string, cwd: string, timeoutMs: number): Promise<UsageStatus> {
    return new Promise((resolve, reject) => {
        execFile(
            claudePath,
            ['-p', '/usage', '--output-format', 'json'],
            { cwd, timeout: timeoutMs },
            (error, stdout, stderr) => {
                if (error) {
                    const errno = error as ExecFileException;
                    if (errno.code === 'ENOENT') {
                        reject(new UsageFetchError(
                            'not-installed',
                            `Claude Code CLI not found at "${claudePath}". Install it, or set the "claudeTokenStatus.claudePath" setting.`
                        ));
                        return;
                    }
                    if (errno.killed) {
                        reject(new UsageFetchError(
                            'timed-out',
                            `Timed out waiting for "${claudePath} -p /usage" to respond.`
                        ));
                        return;
                    }
                    reject(new UsageFetchError(
                        'not-executable',
                        `Failed to run "${claudePath} -p /usage": ${error.message}${stderr ? `\n${stderr}` : ''}`
                    ));
                    return;
                }
                let parsed: { is_error?: boolean; result?: unknown };
                try {
                    parsed = JSON.parse(stdout);
                } catch (e) {
                    reject(new UsageFetchError(
                        'unexpected-response',
                        `Failed to parse JSON from claude CLI: ${(e as Error).message}`
                    ));
                    return;
                }

                if (parsed.is_error || typeof parsed.result !== 'string') {
                    reject(new UsageFetchError(
                        'unexpected-response',
                        `Unexpected response from claude CLI: ${stdout}`
                    ));
                    return;
                }

                try {
                    resolve(parseUsageOutput(parsed.result));
                } catch (e) {
                    reject(e as Error);
                }
            }
        );
    });
}
