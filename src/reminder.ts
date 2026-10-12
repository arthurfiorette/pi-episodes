import type { ExtensionAPI, SessionEntry } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { type ThreadRecord, threadRecords } from './archive.js';
import { episodesSettings } from './settings.js';

export const REMINDER_TYPE = 'episodes-open';

/**
 * Open items from threads archived since the last reminder on this branch. Read from the
 * branch, not from memory, so a resumed session reminds of the same things.
 */
export function pendingOpen(branch: readonly SessionEntry[]): ThreadRecord[] {
  const last = branch.findLastIndex(
    (entry) => entry.type === 'custom_message' && entry.customType === REMINDER_TYPE
  );
  return threadRecords(branch.slice(last + 1)).filter((record) => record.open);
}

/** Newest first, cut at `maxTokens` (about four characters each) on a whole item. */
export function reminderText(
  records: readonly ThreadRecord[],
  maxTokens: number
): string | undefined {
  const budget = maxTokens * 4;
  const header = 'Open items from work folded since the last reminder, in case they matter now:';
  const lines: string[] = [];
  let used = header.length;
  for (const record of [...records].reverse()) {
    const line = `- ${record.handle} (${record.headline}): ${record.open}`;
    if (used + line.length + 1 > budget) {
      if (lines.length === 0) lines.push(`${line.slice(0, Math.max(0, budget - used - 4))}...`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length === 0) return undefined;
  const dropped = records.length - lines.length;
  if (dropped > 0) lines.push(`(${dropped} older thread(s) with open items; recall or ask them)`);
  return [header, ...lines].join('\n');
}

/**
 * A fold happens when the main goal of an episode is met, which is when trailing steps and
 * parked work are most easily forgotten. Their cue is the note, but nothing brings the note
 * back. On the next user prompt after such a fold this appends one short message listing its
 * open items. It is a new message at the end of the transcript, never an edit, so the cached
 * prefix is untouched, and it is sent once, not on every request.
 */
export function registerReminder(pi: ExtensionAPI): void {
  pi.on('before_agent_start', (event, ctx) => {
    // Newer pi also runs this for extension messages, such as the /fold request; those are
    // not the user coming back to the task.
    const messageType = (event as { messageType?: string }).messageType;
    if (messageType !== undefined && messageType !== 'user') return undefined;
    const settings = episodesSettings(pi.getSettings());
    if (!settings.openReminder) return undefined;

    const text = reminderText(
      pendingOpen(ctx.sessionManager.getBranch()),
      settings.openReminderMaxTokens
    );
    if (!text) return undefined;
    return { message: { customType: REMINDER_TYPE, content: text, display: true } };
  });

  pi.registerMessageRenderer(REMINDER_TYPE, (message, { expanded }, theme) => {
    const text = typeof message.content === 'string' ? message.content : '';
    const items = text.split('\n').slice(1);
    const count = items.filter((line) => line.startsWith('- ')).length;
    const body = expanded ? `\n${items.join('\n')}` : '';
    return new Text(
      theme.fg(
        'dim',
        `episodes: reminded of open items from ${count} thread(s)${expanded ? '' : ', ctrl+o to show'}`
      ) + theme.fg('muted', body),
      0,
      0
    );
  });
}
