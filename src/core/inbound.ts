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
};
