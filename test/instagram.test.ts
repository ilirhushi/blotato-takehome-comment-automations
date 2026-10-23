import { describe, expect, it } from 'vitest';
import { instagram } from '../src/platform/instagram.js';

const HOUR = 60 * 60 * 1000;
const now = new Date('2026-01-10T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);

describe('instagram.canSendDm', () => {
  it('uses a private reply for the first DM to a commenter', () => {
    expect(
      instagram.canSendDm({ now, commentCreatedAt: ago(HOUR), privateReplyUsed: false, lastInboundDmAt: null }),
    ).toEqual({ ok: true, mode: 'private_reply' });
  });

  it('allows only one private reply per comment', () => {
    expect(
      instagram.canSendDm({ now, commentCreatedAt: ago(HOUR), privateReplyUsed: true, lastInboundDmAt: null }),
    ).toMatchObject({ ok: false });
  });

  it('allows standard DMs within 24h of the contact\'s last message', () => {
    expect(
      instagram.canSendDm({ now, commentCreatedAt: ago(HOUR), privateReplyUsed: true, lastInboundDmAt: ago(23 * HOUR) }),
    ).toEqual({ ok: true, mode: 'standard' });
  });

  it('blocks once the 24h window has closed', () => {
    expect(
      instagram.canSendDm({ now, commentCreatedAt: ago(HOUR), privateReplyUsed: true, lastInboundDmAt: ago(24 * HOUR) }),
    ).toMatchObject({ ok: false });
  });

  it('blocks private replies to comments older than 7 days', () => {
    expect(
      instagram.canSendDm({ now, commentCreatedAt: ago(7 * 24 * HOUR), privateReplyUsed: false, lastInboundDmAt: null }),
    ).toMatchObject({ ok: false });
  });
});
