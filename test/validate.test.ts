import { describe, expect, it } from 'vitest';
import { validateVersion, VersionValidationError } from '../src/domain/validate.js';

const trigger = { type: 'comment_keyword', keyword: 'pricing', post_ids: null };
const wait = {
  type: 'wait_for_reply',
  validator: 'email',
  save_as: 'email',
  timeout_seconds: 3600,
  max_reprompts: 2,
  reprompt_text: 'That does not look like an email, try again?',
  give_up_text: 'No worries, {{username}}!',
};
const pricingSteps = [
  { type: 'reply_to_comment', text: 'Sent you a DM!' },
  { type: 'send_dm', text: 'Hi {{username}}, what is your email?' },
  wait,
  { type: 'send_dm', text: 'Here is the link: https://example.com/pricing (sent to {{email}})' },
];

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof VersionValidationError) return err.issues;
    throw err;
  }
  throw new Error('expected validation to fail');
}

describe('validateVersion', () => {
  it('accepts the pricing automation', () => {
    expect(validateVersion(trigger, pricingSteps).steps).toHaveLength(4);
  });

  it('rejects a bad trigger', () => {
    expect(issuesOf(() => validateVersion({ type: 'comment_keyword', keyword: ' ', post_ids: [] }, pricingSteps)))
      .toEqual([
        'trigger.keyword must be a non-empty string',
        'trigger.post_ids must be null or a non-empty array of strings',
      ]);
  });

  it('rejects empty and unknown steps', () => {
    expect(issuesOf(() => validateVersion(trigger, []))).toEqual(['steps must be a non-empty array']);
    expect(issuesOf(() => validateVersion(trigger, [{ type: 'send_email' }]))).toEqual([
      'steps[0].type is not a known step type',
    ]);
  });

  it('reports invalid step config', () => {
    const bad = [{ type: 'send_dm', text: 'ask' }, { ...wait, timeout_seconds: 0, save_as: '1x' }];
    expect(issuesOf(() => validateVersion(trigger, bad))).toEqual([
      'steps[1].save_as must be a valid variable name',
      'steps[1].timeout_seconds must be an integer between 1 and 604800',
    ]);
  });

  it('rejects a variable used before it is set', () => {
    const steps = [{ type: 'send_dm', text: 'Your email is {{email}}' }, wait];
    expect(issuesOf(() => validateVersion(trigger, steps))).toEqual(['steps[0] uses {{email}} before it is set']);
  });

  it('rejects the saved variable in the wait step\'s own messages', () => {
    const steps = [{ type: 'send_dm', text: 'email?' }, { ...wait, reprompt_text: 'not {{email}}' }];
    expect(issuesOf(() => validateVersion(trigger, steps))).toEqual(['steps[1] uses {{email}} before it is set']);
  });

  it('rejects save_as shadowing an existing variable', () => {
    const steps = [{ type: 'send_dm', text: 'name?' }, { ...wait, save_as: 'username' }];
    expect(issuesOf(() => validateVersion(trigger, steps))).toEqual([
      'steps[1].save_as "username" is already set earlier',
    ]);
  });

  it('requires a send_dm directly before a wait', () => {
    const steps = [{ type: 'reply_to_comment', text: 'hi' }, wait];
    expect(issuesOf(() => validateVersion(trigger, steps))).toEqual(['steps[1] must directly follow a send_dm step']);
  });
});
