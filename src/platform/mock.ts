import type { PlatformClient, PlatformError, SendResult } from './types.js';

export type SentMessage =
  | { kind: 'comment_reply'; messageId: string; accountId: string; commentId: string; text: string }
  | {
      kind: 'dm';
      messageId: string;
      accountId: string;
      contactId: string;
      text: string;
      replyToCommentId?: string;
    };

export class MockPlatformClient implements PlatformClient {
  readonly sent: SentMessage[] = [];
  private failures: PlatformError[] = [];
  private nextId = 1;

  /** The next calls fail with these errors, in order, without sending anything. */
  failNext(...errors: PlatformError[]): void {
    this.failures.push(...errors);
  }

  async replyToComment(input: { accountId: string; commentId: string; text: string }): Promise<SendResult> {
    this.throwIfFailing();
    const messageId = this.newId();
    this.sent.push({ kind: 'comment_reply', messageId, ...input });
    return { messageId };
  }

  async sendDm(input: {
    accountId: string;
    contactId: string;
    text: string;
    replyToCommentId?: string;
  }): Promise<SendResult> {
    this.throwIfFailing();
    const messageId = this.newId();
    this.sent.push({ kind: 'dm', messageId, ...input });
    return { messageId };
  }

  private throwIfFailing(): void {
    const failure = this.failures.shift();
    if (failure) throw failure;
  }

  private newId(): string {
    return `mock-msg-${this.nextId++}`;
  }
}
