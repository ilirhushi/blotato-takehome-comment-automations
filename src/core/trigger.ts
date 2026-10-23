import type { Trigger } from './types.js';

export interface CommentFacts {
  post_id: string;
  text: string;
}

export function matchesKeyword(text: string, keyword: string): boolean {
  const escaped = keyword.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // \b is ASCII-only in JS, so word boundaries are spelled out with Unicode classes.
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

export function triggerMatches(trigger: Trigger, comment: CommentFacts): boolean {
  if (trigger.post_ids !== null && !trigger.post_ids.includes(comment.post_id)) return false;
  return matchesKeyword(comment.text, trigger.keyword);
}
