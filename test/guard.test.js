'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { findRunawayRepetition, RunawayGuard } = require('../lib/guard');
const { consumeSSE } = require('../lib/sse');

// 真实场景：模型陷进复读，同一句话几百遍，一口气几万字
test('同一句话反复输出会被判定为复读', () => {
  const sentence = '我们需要先确认 uperf 是否在这个设备上真的生效了。';
  const text = '开头是正常的一段话。' + sentence.repeat(40);
  const hit = findRunawayRepetition(text);
  assert.ok(hit, '应该判定为复读');
  assert.ok(hit.repeats >= 6, `重复次数太少: ${hit && hit.repeats}`);
  assert.ok(hit.chars >= 800, `重复总长太短: ${hit && hit.chars}`);
});

test('同一个字符刷屏也会被判定', () => {
  const hit = findRunawayRepetition('正常文字' + '。'.repeat(3000));
  assert.ok(hit);
  assert.equal(hit.period, 1);
});

test('正常的长回复不会误判', () => {
  const text = [
    '第一段：这里讲的是参数解析的边界，每一行都不一样。',
    '第二段：工具调用的残留要清掉，但不能牺牲正文。',
    '第三段：终端会话返回空的时候，要换一种方式确认状态。',
    '第四段：代理的日志字段要能说明问题出在哪一层。',
    '第五段：测试必须能在修复前失败，否则就是空测试。',
  ].join('\n');
  assert.equal(findRunawayRepetition(text), null);
});

test('表格/列表的短重复不够长，不算复读', () => {
  const row = '| c6 | 3440 | 38% |\n';
  // 只重复 5 次，达不到最小次数
  assert.equal(findRunawayRepetition('表头\n' + row.repeat(5)), null);
});

test('复读判定带上重复单元，便于上层裁剪尾部', () => {
  const unit = '重复这一句。';
  const hit = findRunawayRepetition('x' + unit.repeat(200));
  assert.ok(hit);
  assert.equal(hit.unit, unit);
});

test('RunawayGuard 按步长检查并在命中后保持结果', () => {
  const guard = new RunawayGuard({ stepChars: 100 });
  assert.equal(guard.check('短文本'), null, '未到步长不检查');
  const unit = '这句话在重复。';
  const long = unit.repeat(200);
  const first = guard.check(long);
  assert.ok(first, '应该命中');
  assert.strictEqual(guard.check(long + '还有更多'), first, '命中后返回同一个结果');
});

test('consumeSSE 在 shouldStop 为真后停止读取', async () => {
  let delivered = 0;
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (let i = 0; i < 50; i += 1) {
        controller.enqueue(encoder.encode(`data: {"i":${i}}\n\n`));
      }
      // 不 close：模拟上游还在吐，我们主动取消
    },
  });

  const resp = { body };
  await consumeSSE(resp, () => { delivered += 1; }, () => delivered >= 3);
  assert.equal(delivered, 3, `shouldStop 之后不应再投递事件，实际 ${delivered}`);
});

test('consumeSSE 没有 shouldStop 时读完整段（行为不变）', async () => {
  let delivered = 0;
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (let i = 0; i < 5; i += 1) controller.enqueue(encoder.encode(`data: {"i":${i}}\n\n`));
      controller.close();
    },
  });
  await consumeSSE({ body }, () => { delivered += 1; });
  assert.equal(delivered, 5);
});
