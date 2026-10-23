import { describe, expect, it } from 'vitest';
import { matchesKeyword, triggerMatches } from '../src/routing/match.js';

describe('matchesKeyword', () => {
  it.each([
    ['pricing', true],
    ['PRICING please', true],
    ['what is the Pricing?', true],
    ['pricing!!!', true],
    ['"pricing"', true],
    ['repricing', false],
    ['pricings', false],
    ['pricing_info', true],
    ['précisément pricing', true],
    ['épricing', false],
    ['', false],
  ])('%j -> %s', (text, expected) => {
    expect(matchesKeyword(text, 'pricing')).toBe(expected);
  });

  it('treats regex characters in the keyword literally', () => {
    expect(matchesKeyword('price?', 'price?')).toBe(true);
    expect(matchesKeyword('pric', 'price?')).toBe(false);
  });

  it('matches multi-word keywords', () => {
    expect(matchesKeyword('send me the price list', 'price list')).toBe(true);
  });
});

describe('triggerMatches', () => {
  const trigger = { type: 'comment_keyword', keyword: 'pricing' } as const;

  it('matches any post when post_ids is null', () => {
    expect(triggerMatches({ ...trigger, post_ids: null }, { post_id: 'p9', text: 'pricing' })).toBe(true);
  });

  it('only matches listed posts', () => {
    const scoped = { ...trigger, post_ids: ['p1'] };
    expect(triggerMatches(scoped, { post_id: 'p1', text: 'pricing' })).toBe(true);
    expect(triggerMatches(scoped, { post_id: 'p2', text: 'pricing' })).toBe(false);
  });
});
