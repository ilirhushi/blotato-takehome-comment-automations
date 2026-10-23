import { VAR_NAME } from '../template.js';

type Raw = Record<string, unknown>;

export function nonEmptyString(raw: Raw, field: string, issues: string[]): void {
  const value = raw[field];
  if (typeof value !== 'string' || value.trim() === '') issues.push(`${field} must be a non-empty string`);
}

export function intInRange(raw: Raw, field: string, min: number, max: number, issues: string[]): void {
  const value = raw[field];
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    issues.push(`${field} must be an integer between ${min} and ${max}`);
  }
}

export function varName(raw: Raw, field: string, issues: string[]): void {
  const value = raw[field];
  if (typeof value !== 'string' || !VAR_NAME.test(value)) issues.push(`${field} must be a valid variable name`);
}

export function oneOf(raw: Raw, field: string, allowed: readonly string[], issues: string[]): void {
  if (!allowed.includes(raw[field] as string)) issues.push(`${field} must be one of: ${allowed.join(', ')}`);
}
