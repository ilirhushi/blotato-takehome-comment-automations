import { describe, expect, it } from 'vitest';
import { validateReply } from '../src/core/reply-validators.js';

describe('email validator', () => {
  it.each([
    ['ana@example.com', 'ana@example.com'],
    ['  sure, it is ana.b+promo@mail.example.co.uk thanks', 'ana.b+promo@mail.example.co.uk'],
    ['not an email', null],
    ['ana@example', null],
    ['@example.com', null],
  ])('%j -> %j', (text, expected) => {
    expect(validateReply('email', text)).toBe(expected);
  });
});
