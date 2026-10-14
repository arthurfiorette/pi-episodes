/** Three 429 responses in a row (DESIGN 5.6: the trial is `infra`), then a normal reply. */
import { type FauxScript, fauxAssistantMessage, throttledResponse } from '../../src/faux.js';

const script: FauxScript = {
  steps: [
    throttledResponse(),
    throttledResponse(),
    throttledResponse(),
    () => fauxAssistantMessage('ok')
  ]
};
export const steps = script.steps;
export default script;
