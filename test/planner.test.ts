import { describe, expect, it } from 'vitest';
import type { CommentPayload } from '../src/core/inbound.js';
import { planRunsForComment, type CandidateAutomation } from '../src/core/planner.js';

const comment: CommentPayload = {
  comment_id: 'c1',
  post_id: 'post-1',
  text: 'pricing?',
  username: 'ana',
  created_at: '2026-01-01T00:00:00Z',
};

const candidate = (id: string, keyword: string, postIds: string[] | null = null): CandidateAutomation => ({
  automationId: id,
  versionId: `${id}-v1`,
  trigger: { type: 'comment_keyword', keyword, post_ids: postIds },
});

describe('planRunsForComment', () => {
  it('starts the first match and skips the others', () => {
    const plan = planRunsForComment(
      [candidate('a', 'hello'), candidate('b', 'pricing'), candidate('c', 'pricing')],
      comment,
      false,
    );
    expect(plan.map((p) => [p.automationId, p.status, p.context.outcome])).toEqual([
      ['b', 'running', undefined],
      ['c', 'skipped', 'contact_busy'],
    ]);
    expect(plan[0]!.context).toEqual({
      vars: { username: 'ana', comment_text: 'pricing?' },
      comment: { id: 'c1', post_id: 'post-1', created_at: '2026-01-01T00:00:00Z' },
    });
  });

  it('skips every match when the contact is busy', () => {
    const plan = planRunsForComment([candidate('a', 'pricing')], comment, true);
    expect(plan.map((p) => p.status)).toEqual(['skipped']);
  });

  it('plans nothing when no trigger matches', () => {
    expect(planRunsForComment([candidate('a', 'pricing', ['other-post'])], comment, false)).toEqual([]);
  });
});
