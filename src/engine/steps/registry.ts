import type { Step, StepType } from '../../domain/types.js';
import { replyToComment } from './reply-to-comment.js';
import { sendDm } from './send-dm.js';
import { waitForReply } from './wait-for-reply.js';

export interface StepDefinition<S extends Step = Step> {
  validate(raw: Record<string, unknown>): string[];
  templates(step: S): string[];
  produces(step: S): string[];
}

type Registry = { [T in StepType]: StepDefinition<Extract<Step, { type: T }>> };

export const stepRegistry: Registry = {
  reply_to_comment: replyToComment,
  send_dm: sendDm,
  wait_for_reply: waitForReply,
};

export function getStepDefinition(type: unknown): StepDefinition | undefined {
  if (typeof type !== 'string' || !Object.hasOwn(stepRegistry, type)) return undefined;
  return stepRegistry[type as StepType] as StepDefinition;
}
