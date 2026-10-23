import type { Platform } from '../domain/types.js';

export class TransientPlatformError extends Error {
  readonly transient = true;
}

export class PermanentPlatformError extends Error {
  readonly transient = false;
}

export type PlatformError = TransientPlatformError | PermanentPlatformError;

export interface SendResult {
  messageId: string;
}

export interface PlatformClient {
  replyToComment(input: { accountId: string; commentId: string; text: string }): Promise<SendResult>;
  /** replyToCommentId sends the DM as a private reply to that comment. */
  sendDm(input: {
    accountId: string;
    contactId: string;
    text: string;
    replyToCommentId?: string;
  }): Promise<SendResult>;
}

export interface DmFacts {
  now: Date;
  commentCreatedAt: Date;
  privateReplyUsed: boolean;
  lastInboundDmAt: Date | null;
}

export type DmPermission =
  | { ok: true; mode: 'standard' | 'private_reply' }
  | { ok: false; reason: string };

export interface RateLimit {
  capacity: number;
  refillPerSecond: number;
}

export interface PlatformAdapter {
  platform: Platform;
  canSendDm(facts: DmFacts): DmPermission;
  rateLimit: RateLimit;
}
