/**
 * Long assistant replies against a 4000-token window. Plain pi's system prompt is about 1.5k
 * faux tokens and pi-episodes' about 3.6k, so with `reserveTokens` 500 the threshold (3500)
 * is crossed within goal-1 in A and at once in B. Summary requests are answered by the
 * driver's default summary without consuming a step.
 */
import {
  type FauxScript,
  type FauxStep,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  longText
} from '../../src/faux.js';

function talkAndRun(seed: string, command: string): FauxStep {
  return () =>
    fauxAssistantMessage([fauxText(longText(800, seed)), fauxToolCall('bash', { command })], {
      stopReason: 'toolUse'
    });
}

const script: FauxScript = {
  model: { contextWindow: 4000, maxTokens: 2000 },
  settings: { compaction: { reserveTokens: 500, keepRecentTokens: 150 } },
  steps: [
    talkAndRun('first', 'echo one'),
    talkAndRun('second', 'echo two'),
    talkAndRun('third', 'echo three'),
    () => fauxAssistantMessage('done'),
    () => fauxAssistantMessage('aside answered: 5'),
    talkAndRun('fourth', 'echo four'),
    talkAndRun('fifth', 'echo five'),
    () => fauxAssistantMessage('done again'),
    () => fauxAssistantMessage('src/add.js')
  ]
};
export const steps = script.steps;
export default script;
