import { VAR_NAME } from './template.js';
import type { Step, StepType } from './types.js';

type Raw = Record<string, unknown>;

export interface StepDefinition<S extends Step = Step> {
  validate(raw: Raw): string[];
  templates(step: S): string[];
  produces(step: S): string[];
}

function nonEmptyString(raw: Raw, field: string, issues: string[]): void {
  const value = raw[field];
  if (typeof value !== 'string' || value.trim() === '') issues.push(`${field} must be a non-empty string`);
}

function intInRange(raw: Raw, field: string, min: number, max: number, issues: string[]): void {
  const value = raw[field];
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    issues.push(`${field} must be an integer between ${min} and ${max}`);
  }
}

function varName(raw: Raw, field: string, issues: string[]): void {
  const value = raw[field];
  if (typeof value !== 'string' || !VAR_NAME.test(value)) issues.push(`${field} must be a valid variable name`);
}

function oneOf(raw: Raw, field: string, allowed: readonly string[], issues: string[]): void {
  if (!allowed.includes(raw[field] as string)) issues.push(`${field} must be one of: ${allowed.join(', ')}`);
}

const SEVEN_DAYS = 7 * 24 * 60 * 60;

const textStep: StepDefinition<Extract<Step, { text: string }>> = {
  validate(raw) {
    const issues: string[] = [];
    nonEmptyString(raw, 'text', issues);
    return issues;
  },
  templates: (step) => [step.text],
  produces: () => [],
};

const stepDefinitions: { [T in StepType]: StepDefinition<Extract<Step, { type: T }>> } = {
  reply_to_comment: textStep,
  send_dm: textStep,
  wait_for_reply: {
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
  },
};

export function getStepDefinition(type: unknown): StepDefinition | undefined {
  if (typeof type !== 'string' || !Object.hasOwn(stepDefinitions, type)) return undefined;
  return stepDefinitions[type as StepType] as StepDefinition;
}
