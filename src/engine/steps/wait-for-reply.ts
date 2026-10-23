import type { WaitForReplyStep } from '../../domain/types.js';
import { intInRange, nonEmptyString, oneOf, varName } from './fields.js';
import type { StepDefinition } from './registry.js';

const SEVEN_DAYS = 7 * 24 * 60 * 60;

export const waitForReply: StepDefinition<WaitForReplyStep> = {
  validate(raw) {
    const issues: string[] = [];
    oneOf(raw, 'validator', ['email'], issues);
    varName(raw, 'save_as', issues);
    intInRange(raw, 'timeout_seconds', 1, SEVEN_DAYS, issues);
    intInRange(raw, 'max_reprompts', 0, 10, issues);
    nonEmptyString(raw, 'reprompt_text', issues);
    nonEmptyString(raw, 'give_up_text', issues);
    return issues;
  },
  // Re-prompts and the give-up message are sent before save_as is set.
  templates: (step) => [step.reprompt_text, step.give_up_text],
  produces: (step) => [step.save_as],
};
