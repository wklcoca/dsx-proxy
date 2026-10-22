// CompletionStream 的回归测试：上游用 SET 覆盖 fragment 时必须把正文发出去
//   node --test test/
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { CompletionStream } = require('../lib/sse');

function mk() {
  const deltas = [];
  const cs = new CompletionStream(d => deltas.push(d));
  return { cs, deltas, text: () => deltas.map(d => d.text).join('') };
}

// 上游真实开头：先给一份 fragments 快照（content 为空）
function snapshot(cs, content = '') {
  cs.feedEvent('', JSON.stringify({
    v: { response: { message_id: 'm1', fragments: [{ type: 'RESPONSE', content }] } },
  }));
}

test('SET 覆盖单个 fragment 时正文必须发出（短回答回归）', () => {
  const { cs, deltas, text } = mk();
  snapshot(cs);
  // 真实事故形状：整段回答一次 SET 下发，不是 APPEND
  cs.feedEvent('', JSON.stringify({ p: 'response/fragments/0', o: 'SET', v: { type: 'RESPONSE', content: '通了' } }));

  assert.strictEqual(cs.content, '通了');
  assert.deepStrictEqual(deltas, [{ type: 'content', text: '通了' }]);
  assert.strictEqual(text(), '通了');
});

test('APPEND 仍逐段增量，后续 SET 全量只补尾巴', () => {
  const { cs, deltas, text } = mk();
  snapshot(cs);
  cs.feedEvent('', JSON.stringify({ p: 'response/fragments/0/content', o: 'APPEND', v: '通' }));
  cs.feedEvent('', JSON.stringify({ p: 'response/fragments/0/content', o: 'APPEND', v: '了' }));
  // 同一段文本再以 SET 全量重发一次，不能重复输出
  cs.feedEvent('', JSON.stringify({ p: 'response/fragments/0', o: 'SET', v: { type: 'RESPONSE', content: '通了' } }));

  assert.deepStrictEqual(deltas.map(d => d.text), ['通', '了']);
  assert.strictEqual(cs.content, '通了');
  assert.strictEqual(text(), '通了');
});

test('SET 带来的更长文本补发增量', () => {
  const { cs, deltas } = mk();
  snapshot(cs);
  cs.feedEvent('', JSON.stringify({ p: 'response/fragments/0/content', o: 'APPEND', v: '通了' }));
  cs.feedEvent('', JSON.stringify({ p: 'response/fragments/0', o: 'SET', v: { type: 'RESPONSE', content: '通了，可以' } }));

  assert.strictEqual(deltas.map(d => d.text).join(''), '通了，可以');
  assert.strictEqual(cs.content, '通了，可以');
});

test('SET 只改 type 时不动正文、不重复发', () => {
  const { cs, deltas } = mk();
  snapshot(cs, '已有内容'); // 快照自带正文 → 补发一次
  cs.feedEvent('', JSON.stringify({ p: 'response/fragments/0', o: 'SET', v: { type: 'SEARCH' } }));

  assert.deepStrictEqual(deltas, [{ type: 'content', text: '已有内容' }]);
  assert.strictEqual(cs.content, '已有内容');
});

test('THINK fragment 的 SET 走 reasoning 通道', () => {
  const { cs, deltas } = mk();
  cs.feedEvent('', JSON.stringify({
    v: { response: { fragments: [{ type: 'THINK', content: '' }] } },
  }));
  cs.feedEvent('', JSON.stringify({ p: 'response/fragments/0', o: 'SET', v: { type: 'THINK', content: '想一想' } }));

  assert.deepStrictEqual(deltas, [{ type: 'think', text: '想一想' }]);
  assert.strictEqual(cs.thinking, '想一想');
  assert.strictEqual(cs.content, '');
});

test('快照之后追加的内容不重复，最终正文与已发增量一致', () => {
  const { cs, deltas, text } = mk();
  snapshot(cs, '');
  cs.feedEvent('', JSON.stringify({ p: 'response/fragments/0/content', o: 'APPEND', v: 'a' }));
  cs.feedEvent('', JSON.stringify({ p: 'response/fragments/0', o: 'SET', v: { content: 'ab' } }));
  cs.feedEvent('', JSON.stringify({ p: 'response/fragments/0/content', o: 'APPEND', v: 'c' }));

  assert.strictEqual(cs.content, 'abc');
  assert.strictEqual(text(), 'abc');
  assert.deepStrictEqual(deltas.length, 3);
});

// 真实事故：短回答上游只发一份快照就 FINISHED，没有任何增量 patch。
// 旧代码认为「快照内容通常为空」，于是正文进了 fragments 却一个 delta 都没发。
test('快照里就带正文时必须补发（短回答真实形状）', () => {
  const { cs, deltas } = mk();
  cs.feedEvent('', JSON.stringify({
    v: { response: { message_id: 2, status: 'WIP', fragments: [{ id: 2, type: 'RESPONSE', content: '通了' }] } },
  }));
  cs.feedEvent('', JSON.stringify({ p: 'response', o: 'BATCH', v: [{ p: 'quasi_status', v: 'FINISHED' }] }));
  cs.feedEvent('', JSON.stringify({ p: 'response/status', o: 'SET', v: 'FINISHED' }));

  assert.strictEqual(cs.content, '通了');
  assert.deepStrictEqual(deltas, [{ type: 'content', text: '通了' }]);
  assert.strictEqual(cs.messageId, 2);
  assert.strictEqual(cs.quasiStatus, 'FINISHED');
  assert.strictEqual(cs.done, true);
});

test('重连快照重发已有内容时只补尾巴，不重复输出', () => {
  const { cs, deltas } = mk();
  cs.feedEvent('', JSON.stringify({
    v: { response: { message_id: 7, fragments: [{ type: 'RESPONSE', content: 'abc' }] } },
  }));
  // 断线重连：上游把同一段内容连同新增部分一起重发
  cs.feedEvent('', JSON.stringify({
    v: { response: { message_id: 7, fragments: [{ type: 'RESPONSE', content: 'abcdef' }] } },
  }));

  assert.strictEqual(deltas.map(d => d.text).join(''), 'abcdef');
  assert.strictEqual(cs.content, 'abcdef');
});

test('快照内容被替换成完全不同的文本时全量重发', () => {
  const { cs, deltas } = mk();
  cs.feedEvent('', JSON.stringify({
    v: { response: { fragments: [{ type: 'RESPONSE', content: '旧内容' }] } },
  }));
  cs.feedEvent('', JSON.stringify({
    v: { response: { fragments: [{ type: 'RESPONSE', content: '新内容' }] } },
  }));

  assert.strictEqual(cs.content, '新内容');
  assert.strictEqual(deltas.map(d => d.text).join(''), '旧内容新内容');
});

test('BATCH 里的相对路径要拼上父路径（否则丢 token 用量）', () => {
  const { cs } = mk();
  snapshot(cs, '');
  cs.feedEvent('', JSON.stringify({
    p: 'response',
    o: 'BATCH',
    v: [{ p: 'accumulated_token_usage', v: 38 }, { p: 'quasi_status', v: 'FINISHED' }],
  }));

  assert.strictEqual(cs.usageTokens, 38);
  assert.strictEqual(cs.quasiStatus, 'FINISHED');
});
