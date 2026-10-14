/**
 * One 400 from the provider, then a normal reply: not a 429 or 5xx, so the step is `settled`
 * with the error recorded and the checks decide the category (DESIGN 5.6).
 */
import { type FauxScript, fauxAssistantMessage, throttledResponse } from '../../src/faux.js';

const script: FauxScript = {
  steps: [
    throttledResponse('HTTP 400 Bad Request: invalid transcript at line 512'),
    () => fauxAssistantMessage('ok')
  ]
};
export const steps = script.steps;
export default script;
