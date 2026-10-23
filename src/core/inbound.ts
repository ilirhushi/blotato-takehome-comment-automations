import type { ContactKey } from './types.js';

export interface CommentPayload {
  comment_id: string;
  post_id: string;
  text: string;
  username: string;
  created_at: string;
}

export interface DmPayload {
  message_id: string;
  text: string;
}

export type InboundEventData =
  | { kind: 'comment'; payload: CommentPayload }
  | { kind: 'dm'; payload: DmPayload };

export type NewInboundEvent = InboundEventData & {
  contact: ContactKey;
  platformEventId: string;
};

export type InboundEvent = InboundEventData & {
  id: string;
  contact: ContactKey;
  receivedAt: Date;
  consumedByRunId: string | null;
};

export type InboundDm = Extract<InboundEvent, { kind: 'dm' }>;

/** A DM's text, or '' for one without text (a sticker, an attachment, a malformed payload). */
export function dmText(dm: InboundDm): string {
  const text = (dm.payload as Partial<DmPayload> | null)?.text;
  return typeof text === 'string' ? text : '';
}
