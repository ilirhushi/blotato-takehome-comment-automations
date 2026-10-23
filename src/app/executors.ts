import type { RunContext } from '../core/run.js';
import { renderTemplate } from '../core/template.js';
import type { Step, StepType } from '../core/types.js';
import { PermanentStepError } from './errors.js';
import type { StepContext, StepResult } from './step-context.js';

type StepExecutor<S extends Step> = (ctx: StepContext, step: S) => Promise<StepResult>;

/** Sends a DM through whichever channel the platform currently allows. */
async function sendDirectMessage(ctx: StepContext, effectKey: string, text: string): Promise<RunContext> {
  const { run } = ctx;
  const permission = ctx.adapter.canSendDm({
    now: ctx.now(),
    commentCreatedAt: new Date(run.context.comment.created_at),
    privateReplyUsed: run.context.private_reply_used ?? false,
    lastInboundDmAt: await ctx.lastInboundDmAt(),
  });
  await ctx.send(effectKey, () => {
    if (!permission.ok) throw new PermanentStepError(permission.reason);
    return ctx.client.sendDm({
      accountId: run.contact.accountId,
      contactId: run.contact.contactId,
      text,
      replyToCommentId: permission.mode === 'private_reply' ? run.context.comment.id : undefined,
    });
  });
  const usedPrivateReply = permission.ok && permission.mode === 'private_reply';
  return usedPrivateReply ? { ...run.context, private_reply_used: true } : run.context;
}

// Typed over StepType, so adding a step type without an executor fails to compile.
const executors: { [T in StepType]: StepExecutor<Extract<Step, { type: T }>> } = {
  async reply_to_comment(ctx, step) {
    const { run } = ctx;
    const text = renderTemplate(step.text, run.context.vars);
    await ctx.send('main', () =>
      ctx.client.replyToComment({ accountId: run.contact.accountId, commentId: run.context.comment.id, text }),
    );
    return { type: 'advance' };
  },

  async send_dm(ctx, step) {
    const context = await sendDirectMessage(ctx, 'main', renderTemplate(step.text, ctx.run.context.vars));
    return { type: 'advance', context };
  },

  async wait_for_reply() {
    throw new PermanentStepError('wait_for_reply is not implemented yet');
  },
};

export function executeStep(ctx: StepContext, step: Step): Promise<StepResult> {
  return (executors[step.type] as StepExecutor<Step>)(ctx, step);
}
