import type { ReplyToCommentStep } from '../../domain/types.js';
import { nonEmptyString } from './fields.js';
import type { StepDefinition } from './registry.js';

export const replyToComment: StepDefinition<ReplyToCommentStep> = {
  validate(raw) {
    const issues: string[] = [];
    nonEmptyString(raw, 'text', issues);
    return issues;
  },
  templates: (step) => [step.text],
  produces: () => [],
};
