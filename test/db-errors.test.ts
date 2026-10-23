import { describe, expect, it } from 'vitest';
import { isTransientDbError } from '../src/db/errors.js';

const withCode = (code: string) => Object.assign(new Error('boom'), { code });

describe('isTransientDbError', () => {
  it('treats dropped connections and contention as transient', () => {
    expect(isTransientDbError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isTransientDbError(withCode('ECONNRESET'))).toBe(true);
    expect(isTransientDbError(withCode('08006'))).toBe(true);
    expect(isTransientDbError(withCode('57P01'))).toBe(true);
    expect(isTransientDbError(withCode('40P01'))).toBe(true);
  });

  it('treats query bugs and constraint violations as permanent', () => {
    expect(isTransientDbError(withCode('42601'))).toBe(false);
    expect(isTransientDbError(withCode('23505'))).toBe(false);
    expect(isTransientDbError(new TypeError('x is undefined'))).toBe(false);
    expect(isTransientDbError('not an error')).toBe(false);
  });
});
