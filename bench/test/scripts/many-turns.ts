/** Twenty tool-calling assistant messages; against a turn cap of 5 the step ends as `turn_cap`. */
import { type FauxScript, fauxAssistantMessage, fauxToolCall } from '../../src/faux.js';

const script: FauxScript = {
  steps: [
    ...Array.from(
      { length: 20 },
      (_, index) => () =>
        fauxAssistantMessage(fauxToolCall('bash', { command: `echo turn ${index + 1}` }), {
          stopReason: 'toolUse'
        })
    ),
    () => fauxAssistantMessage('done after twenty turns')
  ]
};
export const steps = script.steps;
export default script;
