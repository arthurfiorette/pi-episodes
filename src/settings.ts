/**
 * The `episodes` key in pi's settings.json. Pi's settings type has no slot for extension keys,
 * so the object is read loosely and every value falls back to its default.
 */
export interface EpisodesSettings {
  /** Stop a fork after this long; its work so far stays archived. */
  forkTimeoutMs: number;
  /** Remind the agent of open items from notes folded since the last reminder. */
  openReminder: boolean;
  /** Upper bound on the reminder's size. */
  openReminderMaxTokens: number;
}

const DEFAULTS: EpisodesSettings = {
  forkTimeoutMs: 30 * 60 * 1000,
  openReminder: true,
  openReminderMaxTokens: 300
};

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function episodesSettings(settings: object): EpisodesSettings {
  const raw = (settings as { episodes?: Record<string, unknown> }).episodes ?? {};
  return {
    forkTimeoutMs: positive(raw.forkTimeoutMs, DEFAULTS.forkTimeoutMs),
    openReminder: typeof raw.openReminder === 'boolean' ? raw.openReminder : DEFAULTS.openReminder,
    openReminderMaxTokens: positive(raw.openReminderMaxTokens, DEFAULTS.openReminderMaxTokens)
  };
}
