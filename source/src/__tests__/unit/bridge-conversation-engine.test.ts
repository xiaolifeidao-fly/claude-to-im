import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initBridgeContext } from '../../lib/bridge/context';
import { buildReplayPrompt, processMessage } from '../../lib/bridge/conversation-engine';
import type {
  BridgeStore,
  BridgeMessage,
  LLMProvider,
  PermissionGateway,
  LifecycleHooks,
  StreamChatParams,
} from '../../lib/bridge/host';
import type { ChannelBinding } from '../../lib/bridge/types';

class TestStore implements BridgeStore {
  messages = new Map<string, BridgeMessage[]>();

  getSetting() { return null; }
  getChannelBinding() { return null; }
  upsertChannelBinding() {
    return {
      id: 'binding-unused',
      channelType: 'qq',
      chatId: 'chat-unused',
      codepilotSessionId: 'session-unused',
      sdkSessionId: '',
      workingDirectory: '/tmp',
      model: 'test-model',
      mode: 'code' as const,
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  updateChannelBinding() {}
  listChannelBindings() { return []; }
  getSession(id: string) { return { id, working_directory: '/tmp', model: 'test-model' }; }
  createSession() { return { id: 'session-1', working_directory: '/tmp', model: 'test-model' }; }
  updateSessionProviderId() {}
  addMessage(sessionId: string, role: string, content: string, usage?: string | null) {
    const msgs = this.messages.get(sessionId) || [];
    void usage;
    msgs.push({ role, content });
    this.messages.set(sessionId, msgs);
  }
  getMessages(sessionId: string) { return { messages: this.messages.get(sessionId) || [] }; }
  acquireSessionLock() { return true; }
  renewSessionLock() {}
  releaseSessionLock() {}
  setSessionRuntimeStatus() {}
  updateSdkSessionId() {}
  updateSessionModel() {}
  syncSdkTasks() {}
  getProvider() { return undefined; }
  getDefaultProviderId() { return null; }
  insertAuditLog() {}
  checkDedup() { return false; }
  insertDedup() {}
  cleanupExpiredDedup() {}
  insertOutboundRef() {}
  insertPermissionLink() {}
  getPermissionLink() { return null; }
  markPermissionLinkResolved() { return false; }
  listPendingPermissionLinksByChat() { return []; }
  getChannelOffset() { return '0'; }
  setChannelOffset() {}
}

describe('conversation-engine replay prompt', () => {
  let store: TestStore;
  let capturedParams: StreamChatParams | null;

  beforeEach(() => {
    store = new TestStore();
    capturedParams = null;

    const llm: LLMProvider = {
      streamChat(params: StreamChatParams): ReadableStream<string> {
        capturedParams = params;
        return new ReadableStream({
          start(controller) {
            controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: 'ok' })}\n`);
            controller.enqueue(`data: ${JSON.stringify({
              type: 'result',
              data: JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 }, session_id: 'sdk-new' }),
            })}\n`);
            controller.close();
          },
        });
      },
    };

    const permissions: PermissionGateway = { resolvePendingPermission: () => false };
    const lifecycle: LifecycleHooks = {};
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
    initBridgeContext({ store, llm, permissions, lifecycle });
  });

  it('buildReplayPrompt returns plain text when there is no history', () => {
    assert.equal(buildReplayPrompt('hello', []), 'hello');
  });

  it('replays prior history into the prompt when forced', async () => {
    const sessionId = 'session-1';
    store.addMessage(sessionId, 'user', '你好');
    store.addMessage(sessionId, 'assistant', '你好。有什么需要我处理的？');
    store.addMessage(sessionId, 'user', '帮我写一个2000字的文章 关于春天的');
    store.addMessage(sessionId, 'assistant', '[Task stopped by user]');

    const binding: ChannelBinding = {
      id: 'binding-1',
      channelType: 'qq',
      chatId: 'chat-1',
      codepilotSessionId: sessionId,
      sdkSessionId: '',
      workingDirectory: '/tmp',
      model: 'test-model',
      mode: 'code',
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await processMessage(binding, '我都问了哪些问题', undefined, undefined, undefined, undefined, undefined, {
      forceHistoryReplay: true,
    });

    assert.ok(capturedParams, 'Expected LLM provider to be called');
    assert.ok(capturedParams!.prompt.includes('User: 你好'));
    assert.ok(capturedParams!.prompt.includes('Assistant: 你好。有什么需要我处理的？'));
    assert.ok(capturedParams!.prompt.includes('User: 帮我写一个2000字的文章 关于春天的'));
    assert.ok(capturedParams!.prompt.includes('Assistant: [Task stopped by user]'));
    assert.ok(capturedParams!.prompt.includes('User: 我都问了哪些问题'));
  });
});
