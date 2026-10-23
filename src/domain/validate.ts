import { getStepDefinition } from '../engine/steps/registry.js';
import { templateVars } from '../engine/template.js';
import { TRIGGER_VARS, type Step, type Trigger } from './types.js';

export class VersionValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid automation version: ${issues.join('; ')}`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateTrigger(raw: unknown, issues: string[]): void {
  if (!isObject(raw) || raw.type !== 'comment_keyword') {
    issues.push('trigger.type must be comment_keyword');
    return;
  }
  if (typeof raw.keyword !== 'string' || raw.keyword.trim() === '') {
    issues.push('trigger.keyword must be a non-empty string');
  }
  const postIds = raw.post_ids;
  const validPostIds =
    postIds === null ||
    (Array.isArray(postIds) && postIds.length > 0 && postIds.every((id) => typeof id === 'string'));
  if (!validPostIds) issues.push('trigger.post_ids must be null or a non-empty array of strings');
}

export function validateVersion(trigger: unknown, steps: unknown): { trigger: Trigger; steps: Step[] } {
  const issues: string[] = [];
  validateTrigger(trigger, issues);

  if (!Array.isArray(steps) || steps.length === 0) {
    issues.push('steps must be a non-empty array');
    throw new VersionValidationError(issues);
  }

  const available = new Set<string>(TRIGGER_VARS);
  steps.forEach((raw: unknown, i) => {
    const at = `steps[${i}]`;
    const definition = isObject(raw) ? getStepDefinition(raw.type) : undefined;
    if (!isObject(raw) || !definition) {
      issues.push(`${at}.type is not a known step type`);
      return;
    }
    const stepIssues = definition.validate(raw);
    issues.push(...stepIssues.map((issue) => `${at}.${issue}`));
    if (stepIssues.length > 0) return;

    const step = raw as unknown as Step;
    // The wait consumes replies to the DM before it, so it needs one to anchor to.
    if (step.type === 'wait_for_reply' && (steps[i - 1] as Step | undefined)?.type !== 'send_dm') {
      issues.push(`${at} must directly follow a send_dm step`);
    }
    for (const text of definition.templates(step)) {
      for (const name of templateVars(text)) {
        if (!available.has(name)) issues.push(`${at} uses {{${name}}} before it is set`);
      }
    }
    for (const name of definition.produces(step)) {
      if (available.has(name)) issues.push(`${at}.save_as "${name}" is already set earlier`);
      available.add(name);
    }
  });

  if (issues.length > 0) throw new VersionValidationError(issues);
  return { trigger: trigger as Trigger, steps: steps as Step[] };
}
