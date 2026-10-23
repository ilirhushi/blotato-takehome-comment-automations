import { describe, expect, it } from 'vitest';
import { MockPlatformClient } from '../src/platform/mock.js';
import { TransientPlatformError } from '../src/platform/types.js';

describe('MockPlatformClient', () => {
  it('records sends and fails injected calls without sending', async () => {
    const client = new MockPlatformClient();
    client.failNext(new TransientPlatformError('503'));
    await expect(client.sendDm({ accountId: 'a', contactId: 'c', text: 'hi' })).rejects.toThrow('503');
    await client.sendDm({ accountId: 'a', contactId: 'c', text: 'hi' });
    expect(client.sent).toEqual([{ kind: 'dm', messageId: 'mock-msg-1', accountId: 'a', contactId: 'c', text: 'hi' }]);
  });
});
