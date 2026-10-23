import type { PlatformAdapter } from './types.js';

const HOUR = 60 * 60 * 1000;
const MESSAGING_WINDOW_MS = 24 * HOUR;
const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * HOUR;

export const instagram: PlatformAdapter = {
  platform: 'instagram',

  // A business may DM someone within 24h of their last message. Otherwise the
  // only way in is one private reply per comment, within 7 days of the comment.
  canSendDm({ now, commentCreatedAt, privateReplyUsed, lastInboundDmAt }) {
    if (lastInboundDmAt && now.getTime() - lastInboundDmAt.getTime() < MESSAGING_WINDOW_MS) {
      return { ok: true, mode: 'standard' };
    }
    if (privateReplyUsed) {
      return { ok: false, reason: 'messaging window closed and private reply already used' };
    }
    if (now.getTime() - commentCreatedAt.getTime() >= PRIVATE_REPLY_WINDOW_MS) {
      return { ok: false, reason: 'comment is too old for a private reply' };
    }
    return { ok: true, mode: 'private_reply' };
  },

  rateLimit: { capacity: 20, refillPerSecond: 1 },
};
