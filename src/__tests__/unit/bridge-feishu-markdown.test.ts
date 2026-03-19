import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  FEISHU_CARD_TEXT_SOFT_LIMIT,
  buildToolProgressMarkdown,
  splitFeishuCardText,
} from '../../lib/bridge/markdown/feishu.js';

describe('splitFeishuCardText', () => {
  it('returns the original text when it fits in one card', () => {
    const text = 'short text';
    assert.deepEqual(splitFeishuCardText(text), [text]);
  });

  it('splits long text and preserves the original content when joined with newlines', () => {
    const line = 'a'.repeat(Math.floor(FEISHU_CARD_TEXT_SOFT_LIMIT / 3));
    const text = [line, line, line, line].join('\n');

    const chunks = splitFeishuCardText(text, FEISHU_CARD_TEXT_SOFT_LIMIT);

    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= FEISHU_CARD_TEXT_SOFT_LIMIT);
    }
    assert.equal(chunks.join('\n'), text);
  });

  it('renders both tool input and result details without overwriting the command', () => {
    const markdown = buildToolProgressMarkdown([
      {
        id: 'tool-1',
        name: 'Bash',
        status: 'complete',
        inputDetail: 'pwd',
        resultDetail: '/Users/fly/project',
      },
    ]);

    assert.match(markdown, /`Bash`/);
    assert.match(markdown, /\*\*Input\*\*/);
    assert.match(markdown, /pwd/);
    assert.match(markdown, /\*\*Result\*\*/);
    assert.match(markdown, /\/Users\/fly\/project/);
  });
});
