import { describe, expect, it } from 'vitest';
import { MockPlatformClient } from '../src/platform/mock.js';
import { PrivateReplyAlreadyUsedError, TransientPlatformError } from '../src/platform/types.js';

describe('MockPlatformClient', () => {
  it('records sends and fails injected calls without sending', async () => {
    const client = new MockPlatformClient();
    client.failNext(new TransientPlatformError('503'));
    await expect(client.sendDm({ accountId: 'a', contactId: 'c', text: 'hi' })).rejects.toThrow('503');
    await client.sendDm({ accountId: 'a', contactId: 'c', text: 'hi' });
    expect(client.sent).toEqual([{ kind: 'dm', messageId: 'mock-msg-1', accountId: 'a', contactId: 'c', text: 'hi' }]);
  });

  it('allows one private reply per comment, like Instagram', async () => {
    const client = new MockPlatformClient();
    const dm = { accountId: 'a', contactId: 'c', text: 'hi', replyToCommentId: 'c-1' };
    await client.sendDm(dm);
    await expect(client.sendDm(dm)).rejects.toBeInstanceOf(PrivateReplyAlreadyUsedError);
    await client.sendDm({ ...dm, replyToCommentId: undefined });
    expect(client.sent).toHaveLength(2);
  });
});
