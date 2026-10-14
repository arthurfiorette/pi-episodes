/** The first response never arrives within a short step cap; the step must end as `timeout`. */
import { type FauxScript, fauxAssistantMessage, stallingResponse } from '../../src/faux.js';

const script: FauxScript = {
  steps: [stallingResponse(30_000), () => fauxAssistantMessage('too late')]
};
export const steps = script.steps;
export default script;
