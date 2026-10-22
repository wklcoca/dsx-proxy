// 工具调用解析 / 正文清洗的回归测试
//   node --test test/
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseToolCalls } = require('../lib/tools');

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'super_admin:bash',
      description: 'run a shell command',
      parameters: { type: 'object', properties: { command: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_file',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
    },
  },
];

// 正文里不允许出现的协议痕迹
const LEAK = /<\|\s*DSML|<\/?(?:invoke|parameter|param|call|tool_)|<think/i;

test('标准 tool_call 标签被解析，正文保留', () => {
  const out = '先看一下目录。\n<tool_call>{"name":"bash","arguments":{"command":"pwd"}}</tool_call>\n然后再说。';
  const r = parseToolCalls(out, TOOLS);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].name, 'super_admin:bash');
  assert.equal(r.calls[0].arguments.command, 'pwd');
  assert.ok(r.content.includes('先看一下目录'));
  assert.ok(r.content.includes('然后再说'));
});

test('DSML 方言被解析', () => {
  const out = '<|DSML|| invoke name="super_admin:bash">\n<|DSML|| parameter name="command">ls -la</|DSML|| parameter>\n</|DSML|| invoke>';
  const r = parseToolCalls(out, TOOLS);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].arguments.command, 'ls -la');
  assert.ok(!LEAK.test(r.content), `正文泄漏协议标记: ${r.content}`);
});

test('残缺的 DSML 调用被抢救，而不是删成空', () => {
  const out = '开始。\n<|DSML|| invoke name="bash",arguments={"command":"echo hi"}}';
  const r = parseToolCalls(out, TOOLS);
  assert.equal(r.calls.length, 1, '残缺调用应该被抢救成真调用');
  assert.equal(r.calls[0].name, 'super_admin:bash');
  assert.equal(r.calls[0].arguments.command, 'echo hi');
  assert.ok(!LEAK.test(r.content));
  assert.ok(r.content.includes('开始'));
});

test('只写末段工具名也能解析（名称归一化）', () => {
  const out = '{"name":"bash","arguments":{"command":"ls"}}';
  const r = parseToolCalls(out, TOOLS);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].name, 'super_admin:bash');
});

test('大小写与分隔符不一致也能解析', () => {
  const out = '{"name":"Super_Admin.Bash","arguments":{"command":"ls"}}';
  const r = parseToolCalls(out, TOOLS);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].name, 'super_admin:bash');
});

test('认不出的工具名照原样透传，绝不让整轮变空', () => {
  const out = '{"name":"grep_stuff","arguments":{"pattern":"x"}}';
  const r = parseToolCalls(out, TOOLS);
  assert.equal(r.calls.length, 1, '未知工具名也应该产出调用，交给客户端报错');
  assert.equal(r.calls[0].name, 'grep_stuff');
  assert.ok(!/"arguments"/.test(r.content), '调用 JSON 不能留在正文里');
});

test('围栏里的示例不执行，但仍可见', () => {
  const out = '示例：\n```json\n{"name":"bash","arguments":{"command":"rm -rf /"}}\n```\n上面只是举例。';
  const r = parseToolCalls(out, TOOLS);
  assert.equal(r.calls.length, 0);
  assert.ok(r.content.includes('rm -rf'));
});

test('纯正文不受影响', () => {
  const out = '这是一段普通回复，里面提到 {"name": "x"} 但没有 arguments，不算调用。';
  const r = parseToolCalls(out, TOOLS);
  assert.equal(r.calls.length, 0);
  assert.ok(r.content.includes('普通回复'));
});

test('思考块不留在正文', () => {
  const out = '<think>内部推理</think>这是可见的答案。';
  const r = parseToolCalls(out, TOOLS);
  assert.ok(!LEAK.test(r.content), `正文泄漏思考标记: ${r.content}`);
  assert.ok(r.content.includes('这是可见的答案'));
});

test('多个调用按顺序解析', () => {
  const out = '<tool_call>{"name":"bash","arguments":{"command":"a"}}</tool_call>' +
              '<tool_call>{"name":"bash","arguments":{"command":"b"}}</tool_call>';
  const r = parseToolCalls(out, TOOLS);
  assert.equal(r.calls.length, 2);
  assert.deepEqual(r.calls.map(c => c.arguments.command), ['a', 'b']);
});

test('正文里复述的工具结果 JSON 整段删除（含被截断的）', () => {
  const out = [
    'super_admin:bash 工具调用参数不合法: command 为空',
    '',
    '{"command":"cd /tmp && ls","timeoutMs":30000}',
    '',
    '{"command":"cd /tmp && ls","context_preserved":true,"exitCode":0,"output":"a\\nb\\n',
    '',
    '真正的结论在这里。',
  ].join('\r\n');
  const r = parseToolCalls(out, TOOLS);
  assert.ok(!/context_preserved|exitCode|"command"/.test(r.content), `仍有复述残留: ${r.content}`);
  assert.ok(!/工具调用参数不合法/.test(r.content), '报错行没被清掉');
  assert.ok(r.content.includes('真正的结论'), `正文被误删: ${r.content}`);
});

test('围栏里的 JSON 示例不受影响', () => {
  const out = '看看这个配置：\n\n```json\n{"command":"ls","output":"x"}\n```\n\n就这样。';
  const r = parseToolCalls(out, TOOLS);
  assert.ok(r.content.includes('"command"'), '围栏内的示例被误删');
  assert.ok(r.content.includes('就这样'));
});

test('模型自造的闭合标签变体（</call_call>）不留在正文', () => {
  // 真实案例：模型吐 </call_call>，旧规则只认 </call>，正文里就多出这个残片
  const out = '探针只有 high/high_bounded/ultra_low。\n</call_call>\n';
  const r = parseToolCalls(out, TOOLS);
  assert.ok(!/<\/?call[-_]/i.test(r.content), `残留协议标记: ${r.content}`);
  assert.ok(r.content.includes('探针只有'));

  const kept = parseToolCalls('我要 call 一下这个函数，别删我的字。', TOOLS);
  assert.ok(kept.content.includes('别删我的字'), '正常正文被误删');
});

test('正常工具调用不算“复述垃圾”（echoChars 必须为 0）', () => {
  // 回归：曾用「原文长度 - 清洗后长度」当阈值，导致每次工具调用都误报
  const out = '我先看看目录。\n<tool_call>{"name":"super_admin:bash","arguments":{"command":"ls -la /sdcard/Download && sed -n 1,200p Sim/TextMapLoader.py"}}</tool_call>\n然后分析。';
  const stats = {};
  const r = parseToolCalls(out, TOOLS, { stats });
  assert.equal(r.calls.length, 1);
  assert.equal(stats.echoChars || 0, 0, `正常调用被误判成复述：echoChars=${stats.echoChars}`);
  assert.ok(r.content.includes('我先看看目录'));
});
