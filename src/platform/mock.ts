import { PrivateReplyAlreadyUsedError, type PlatformClient, type PlatformError, type SendResult } from './types.js';

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
  private holds: Promise<void>[] = [];
  private privateReplies = new Set<string>();
  private nextId = 1;

  /** The next calls fail with these errors, in order, without sending anything. */
  failNext(...errors: PlatformError[]): void {
    this.failures.push(...errors);
  }

  /**
   * The next call is delivered but does not return until release() is called,
   * which simulates a worker that stalls or dies after the platform accepted it.
   */
  holdNext(): () => void {
    let release!: () => void;
    this.holds.push(new Promise((resolve) => (release = resolve)));
    return release;
  }

  async replyToComment(input: { accountId: string; commentId: string; text: string }): Promise<SendResult> {
    this.throwIfFailing();
    const messageId = this.newId();
    this.sent.push({ kind: 'comment_reply', messageId, ...input });
    await this.holds.shift();
    return { messageId };
  }

  async sendDm(input: {
    accountId: string;
    contactId: string;
    text: string;
    replyToCommentId?: string;
  }): Promise<SendResult> {
    this.throwIfFailing();
    if (input.replyToCommentId) {
      if (this.privateReplies.has(input.replyToCommentId)) {
        throw new PrivateReplyAlreadyUsedError(`comment ${input.replyToCommentId} already has a private reply`);
      }
      this.privateReplies.add(input.replyToCommentId);
    }
    const messageId = this.newId();
    this.sent.push({ kind: 'dm', messageId, ...input });
    await this.holds.shift();
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
