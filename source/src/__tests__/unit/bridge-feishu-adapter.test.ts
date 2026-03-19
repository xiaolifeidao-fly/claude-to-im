import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FeishuAdapter } from '../../lib/bridge/adapters/feishu-adapter.js';

describe('FeishuAdapter streaming batching', () => {
  it('flushes immediately once the stream grows by about 100 tokens', () => {
    const adapter = new FeishuAdapter() as any;
    const flushes: string[] = [];

    adapter.restClient = {};
    adapter.activeCards.set('chat-1', {
      cards: [],
      startTime: Date.now(),
      toolCalls: [],
      thinking: false,
      pendingText: '',
      lastUpdateAt: Date.now(),
      lastFlushTokenEstimate: 0,
      throttleTimer: null,
    });
    adapter.flushCardUpdate = (chatId: string) => {
      flushes.push(chatId);
    };

    adapter.updateCardContent('chat-1', 'a'.repeat(420));

    assert.deepEqual(flushes, ['chat-1']);
    assert.equal(adapter.activeCards.get('chat-1').throttleTimer, null);
  });

  it('schedules a trailing update when the token delta stays below the threshold', () => {
    const adapter = new FeishuAdapter() as any;
    const flushes: string[] = [];

    adapter.restClient = {};
    adapter.activeCards.set('chat-1', {
      cards: [],
      startTime: Date.now(),
      toolCalls: [],
      thinking: false,
      pendingText: '',
      lastUpdateAt: Date.now(),
      lastFlushTokenEstimate: 60,
      throttleTimer: null,
    });
    adapter.flushCardUpdate = (chatId: string) => {
      flushes.push(chatId);
    };

    adapter.updateCardContent('chat-1', 'small delta');

    assert.deepEqual(flushes, []);
    assert.ok(adapter.activeCards.get('chat-1').throttleTimer);

    clearTimeout(adapter.activeCards.get('chat-1').throttleTimer);
  });
});

describe('FeishuAdapter outbound files', () => {
  it('uploads non-image attachments as file messages with mapped file_type', async () => {
    const adapter = new FeishuAdapter() as any;
    const uploads: Array<{ file_name: string; file_type: string }> = [];
    const sent: Array<{ msg_type: string; content: string }> = [];

    adapter.restClient = {
      im: {
        file: {
          create: async ({ data }: any) => {
            uploads.push({ file_name: data.file_name, file_type: data.file_type });
            return { data: { file_key: 'file-key-1' } };
          },
        },
        message: {
          create: async ({ data }: any) => {
            sent.push({ msg_type: data.msg_type, content: data.content });
            return { data: { message_id: 'msg-1' } };
          },
        },
      },
    };

    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '',
      attachments: [{
        id: 'file-1',
        name: 'artifact.txt',
        type: 'text/plain',
        size: 4,
        data: Buffer.from('demo').toString('base64'),
      }],
    });

    assert.equal(result.ok, true);
    // 'txt' is not a valid Feishu file_type → falls back to 'stream'
    assert.deepEqual(uploads, [{ file_name: 'artifact.txt', file_type: 'stream' }]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].msg_type, 'file');
    assert.equal(JSON.parse(sent[0].content).file_key, 'file-key-1');
  });

  it('maps known extensions to Feishu file_type (pdf, docx, xlsx)', async () => {
    const adapter = new FeishuAdapter() as any;
    const uploads: Array<{ file_type: string }> = [];

    adapter.restClient = {
      im: {
        file: {
          create: async ({ data }: any) => {
            uploads.push({ file_type: data.file_type });
            return { data: { file_key: `key-${uploads.length}` } };
          },
        },
        message: {
          create: async () => ({ data: { message_id: 'msg-1' } }),
        },
      },
    };

    const files = [
      { name: 'report.pdf', type: 'application/pdf', expected: 'pdf' },
      { name: 'slides.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', expected: 'doc' },
      { name: 'data.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', expected: 'xls' },
      { name: 'video.mp4', type: 'video/mp4', expected: 'mp4' },
    ];

    for (const f of files) {
      uploads.length = 0;
      await adapter.send({
        address: { channelType: 'feishu', chatId: 'chat-1' },
        text: '',
        attachments: [{ id: 'x', name: f.name, type: f.type, size: 1, data: Buffer.from('x').toString('base64') }],
      });
      assert.equal(uploads[0]?.file_type, f.expected, `Expected file_type '${f.expected}' for '${f.name}'`);
    }
  });

  it('uploads image attachments via im.image.create and sends as image message', async () => {
    const adapter = new FeishuAdapter() as any;
    const imageUploads: Array<{ image_type: string }> = [];
    const sent: Array<{ msg_type: string; content: string }> = [];

    adapter.restClient = {
      im: {
        image: {
          create: async ({ data }: any) => {
            imageUploads.push({ image_type: data.image_type });
            return { data: { image_key: 'img-key-1' } };
          },
        },
        message: {
          create: async ({ data }: any) => {
            sent.push({ msg_type: data.msg_type, content: data.content });
            return { data: { message_id: 'msg-2' } };
          },
        },
      },
    };

    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '',
      attachments: [{
        id: 'img-1',
        name: 'screenshot.png',
        type: 'image/png',
        size: 8,
        data: Buffer.from('fakepng!').toString('base64'),
      }],
    });

    assert.equal(result.ok, true);
    assert.deepEqual(imageUploads, [{ image_type: 'message' }]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].msg_type, 'image');
    assert.equal(JSON.parse(sent[0].content).image_key, 'img-key-1');
  });
});
