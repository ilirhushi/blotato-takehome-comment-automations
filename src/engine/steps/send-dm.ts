import type { SendDmStep } from '../../domain/types.js';
import { nonEmptyString } from './fields.js';
import type { StepDefinition } from './registry.js';

export const sendDm: StepDefinition<SendDmStep> = {
  validate(raw) {
    const issues: string[] = [];
    nonEmptyString(raw, 'text', issues);
    return issues;
  },
  templates: (step) => [step.text],
  produces: () => [],
};
