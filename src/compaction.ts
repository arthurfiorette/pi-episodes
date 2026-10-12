import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { compactionHandle } from './archive.js';
import { episodesSettings } from './settings.js';

export const COMPACTION_NOTICE_TYPE = 'episodes-compacted';

export function compactionNotice(handle: string): string {
  return `The turns the summary above replaced are archived as ${handle}. recall searches them for exact text the summary left out, such as errors, paths and command output; they are too large for ask.`;
}

/**
 * A fold's note names its archive; pi's compaction summary is pi's own text and cannot. This
 * is how the agent learns the compacted turns can still be searched. It is appended once after
 * the summary, which just rewrote the whole prompt anyway, so it costs no cache.
 */
export function registerCompactionNotice(pi: ExtensionAPI): void {
  pi.on('session_compact', (event) => {
    if (!episodesSettings(pi.getSettings()).compactionNotice) return;
    // Mid-run, steering puts it before the next request; when idle it is appended right away.
    pi.sendMessage(
      {
        customType: COMPACTION_NOTICE_TYPE,
        content: compactionNotice(compactionHandle(event.compactionEntry.id)),
        display: true
      },
      { deliverAs: 'steer' }
    );
  });

  pi.registerMessageRenderer(COMPACTION_NOTICE_TYPE, (message, _options, theme) => {
    const handle = /cp-[0-9a-z-]+/.exec(
      typeof message.content === 'string' ? message.content : ''
    )?.[0];
    return new Text(
      theme.fg(
        'dim',
        `episodes: compacted turns archived as ${handle ?? 'cp-?'}, recall searches them`
      ),
      0,
      0
    );
  });
}
