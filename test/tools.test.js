// 工具调用解析 / 正文清洗的回归测试
//   node --test test/
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseToolCalls, buildToolPrompt, normalizeFenceLines } = require('../lib/tools');

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

const BACKGROUND_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'super_admin:bash',
      description: 'run a shell command',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' }, background: { type: 'string' }, timeoutMs: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'terminal_wait',
      parameters: { type: 'object', properties: { sessionId: { type: 'string' }, timeoutMs: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_screen',
      parameters: { type: 'object', properties: { sessionId: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'terminal_observe',
      parameters: { type: 'object', properties: { observation: { type: 'object' } } },
    },
  },
];

test('长任务提示点名真实的后台工具，而不是模型调不到的 terminal_observe', () => {
  // 回归：terminal_observe 在 Runtime 里要求 plugin owner，模型直接调用必报错；
  // 真正可用的是 super_admin:bash 的 background + terminal_wait + get_screen。
  const prompt = buildToolPrompt(BACKGROUND_TOOLS);
  assert.ok(prompt.includes('## 长任务不要干等'), '缺少长任务段落');
  // 工具定义 JSON 里当然会列出 terminal_observe，这里只看指引段落
  const guide = prompt.slice(prompt.indexOf('## 长任务不要干等'));
  assert.ok(guide.includes('`background: "true"`'), '没有教后台启动');
  assert.ok(guide.includes('`super_admin:bash`'), '没有点名真实的执行工具');
  assert.ok(guide.includes('`terminal_wait`'), '没有点名等待工具');
  assert.ok(guide.includes('`get_screen`'), '没有点名屏幕工具');
  assert.ok(!/terminal_observe/.test(guide), '指引仍在教模型调不到的工具');
  assert.ok(!/"op":"open"/.test(guide), '仍在教 open/next/close 形状');
});

test('没有后台执行工具时不凭空造长任务段落', () => {
  const prompt = buildToolPrompt(TOOLS);
  assert.ok(!prompt.includes('## 长任务不要干等'), '无背景工具却冒出长任务指引');
  assert.ok(prompt.includes('串行执行'), '串行说明丢了');
});

test('只有 terminal_observe 的工具列表不产生 open/next/close 指引', () => {
  const prompt = buildToolPrompt([BACKGROUND_TOOLS[3]]);
  assert.ok(!/"op":"open"/.test(prompt));
  assert.ok(!prompt.includes('## 长任务不要干等'));
});

const PROXY_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'package_proxy',
      parameters: {
        type: 'object',
        properties: { tool_name: { type: 'string' }, params: { type: 'object' } },
      },
    },
  },
];

const proxyCall = (paramsLiteral) => '<tool_call>{"name":"package_proxy","arguments":{"tool_name":"super_admin:bash","params":' + paramsLiteral + '}}</tool_call>';

// 外层 JSON 一定合法，坏的是 params 字符串里面的内容（真实故障就是这样）
const proxyCallWithParamsText = (paramsText) => '<tool_call>' + JSON.stringify({
  name: 'package_proxy',
  arguments: { tool_name: 'super_admin:bash', params: paramsText },
}) + '</tool_call>';

test('能解开的 params 字符串被解成对象', () => {
  const r = parseToolCalls(proxyCall(JSON.stringify(JSON.stringify({ command: 'ls' }))), PROXY_TOOLS);
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.calls[0].arguments.params, { command: 'ls' });
});

test('解不开的 params 字符串不再静默变成 {}（否则客户端只会说“参数没到”）', () => {
  // 真实故障：转义坏掉的字符串被替换成 {}，客户端报 "Missing required parameters: command
  // (no parameters arrived)"，真正的转义错误被吞掉。
  const broken = '{"command":"echo "hi" and \'single\'';   // 内层 JSON 故意不合法
  const r = parseToolCalls(proxyCallWithParamsText(broken), PROXY_TOOLS);
  assert.equal(r.calls.length, 1, '坏 params 不能连调用一起丢掉');
  const params = r.calls[0].arguments.params;
  assert.notDeepEqual(params, {}, '不能把坏掉的 params 变成空对象');
  assert.equal(typeof params, 'string', '原文应透传给客户端，让客户端报出真正的解析错误');
  assert.ok(params.includes('command'), '原文里必须还能看到 command');
});

test('扁平参数（没有 params 包一层）仍然落进 params', () => {
  const flat = '<tool_call>{"name":"package_proxy","arguments":{"tool_name":"super_admin:bash","command":"ls","timeoutMs":"3000"}}</tool_call>';
  const r = parseToolCalls(flat, PROXY_TOOLS);
  assert.deepEqual(r.calls[0].arguments.params, { command: 'ls', timeoutMs: '3000' });
});

const FENCE = '\u0060\u0060\u0060';

test('粘在文字上的围栏被拆到独立行（否则后面整段被吞进代码块）', () => {
  // 真实故障：模型写成 `…是崩``` ` 和 ```**加粗**，严格的 Markdown 解析器不认行中围栏，
  // 于是关闭围栏失效、后面所有小节都渲染成代码。
  const source = '结果：是崩' + FENCE + '\nAssertionError: x\n' + FENCE + '**后面的正文**\n';
  const out = normalizeFenceLines(source);
  assert.ok(out.includes('结果：是崩\n' + FENCE + '\n'), out);
  assert.ok(out.includes('\n' + FENCE + '\n**后面的正文**'), out);
  assert.ok(!/[^\n]`{3}/.test(out.split('\n').filter(line => !line.startsWith(FENCE)).join('\n')), '围栏仍粘在文字里');
});

test('没闭合的围栏在结尾补上，避免吞掉后文', () => {
  const out = normalizeFenceLines('开头\n' + FENCE + 'bash\nls\n');
  assert.equal((out.match(/`{3}/g) || []).length, 2, out);
  assert.ok(out.trimEnd().endsWith(FENCE), out);
});

test('本来就合法的围栏一个字节都不动', () => {
  const source = '正常\n' + FENCE + '\ncode\n' + FENCE + '\n结束';
  assert.equal(normalizeFenceLines(source), source);
  assert.equal(normalizeFenceLines('没有围栏'), '没有围栏');
});

/** 逐行输出围栏状态，用来断言「某段正文不在代码块里」。 */
function fenceStatePerLine(text) {
  const states = [];
  let inFence = false;
  for (const line of String(text).split('\n')) {
    const isFence = /^(`{3,})([^`]*)$/.test(line.trim());
    if (isFence) { states.push({ line, inFence: true, fence: true }); inFence = !inFence; }
    else states.push({ line, inFence, fence: false });
  }
  return states;
}

test('真实事故：合法代码块 + 粘连关闭围栏，不能把后面整段包进代码', () => {
  // 手机上一模一样的形状：先一个独立围栏，关闭围栏粘了正文（正文里还有行内 `code`），
  // 末尾还有一行多余围栏。
  const body = [
    '## 一、验证',
    '',
    FENCE,
    'ROOTFS_NAME=[rootfs-debian]',
    FENCE + '这两个变量都已进入`env -i`白名单，`UBUNTU_PATH`按设计仍然是空。',
    '',
    '## 二、后面还有正文',
    '',
    '这里必须是普通正文，不能被当成代码。',
    '',
    FENCE,
    '',
  ].join('\n');
  const fixed = normalizeFenceLines(body);
  const states = fenceStatePerLine(fixed);
  const prose = states.filter(s => s.line.includes('必须是普通正文'));
  assert.equal(prose.length, 1);
  assert.equal(prose[0].inFence, false, '正文被包进代码块了：\n' + fixed);
  const braces = states.filter(s => s.fence).length;
  assert.equal(braces % 2, 0, '围栏没有配平：\n' + fixed);
  assert.equal(braces, 2, '只应剩下原来那个代码块：\n' + fixed);
  assert.ok(fixed.includes(FENCE + '\n这两个变量都已进入'), '关闭围栏没有独立成行：\n' + fixed);
});

// 真实事故（2026-10-22 16:26，deepseek-reasoner 经本机反代）：
// write 的 content 是一整段多行源码，模型把换行裸着写进 JSON 字符串，
// JSON.parse 失败 → 参数整段丢失 → 客户端报 "missing required property file_path / content"。
// 代理日志表现为 recover=residue emptyArgs=1。
test('参数里带裸换行的多行内容也能解析（write 大段源码的真实形状）', () => {
  const body = [
    '<tool_call>{"name":"create_file","arguments":{"path":"a.js","content":"const a = 1;',
    'const b = 2;',
    '\tconsole.log(a + b);',
    '"}}</tool_call>',
  ].join('\n');
  const out = parseToolCalls(body, TOOLS);
  assert.equal(out.calls.length, 1);
  assert.equal(out.calls[0].name, 'create_file');
  assert.equal(out.calls[0].arguments.path, 'a.js');
  assert.equal(out.calls[0].arguments.content, 'const a = 1;\nconst b = 2;\n\tconsole.log(a + b);\n');
});

test('字符串外的换行和缩进不受影响（只转义字符串内部的控制字符）', () => {
  const body = [
    '<tool_call>',
    '{',
    '  "name": "create_file",',
    '  "arguments": { "path": "a.txt", "content": "第一行',
    '第二行" }',
    '}',
    '</tool_call>',
  ].join('\n');
  const out = parseToolCalls(body, TOOLS);
  assert.equal(out.calls.length, 1);
  assert.equal(out.calls[0].arguments.path, 'a.txt');
  assert.equal(out.calls[0].arguments.content, '第一行\n第二行');
});

test('无参数调用仍然拿到 {}，不会被当成解析失败', () => {
  const out = parseToolCalls('<tool_call>{"name":"create_file","arguments":{}}</tool_call>', TOOLS);
  assert.equal(out.calls.length, 1);
  assert.deepEqual(out.calls[0].arguments, {});
});

// 真实事故（2026-10-22 16:33，raw/chatcmpl-aa601b….txt）：
// 开标签是约定的 <tool_call>，收尾却被写成上游 DSL 形式，正文只剩半段代码。
test('开标签是 <tool_call>、收尾是 DSML 形式时，仍要解析出完整参数', () => {
  const body = [
    '<tool_call>{"name":"create_file","arguments":{"path":"a.js","content":"第1行\\n第2行\\n第3行"}}',
    '</｜｜DSML｜｜ invoke>',
    '</｜｜DSML｜｜ calls>',
  ].join('\n');
  const out = parseToolCalls(body, TOOLS);
  assert.equal(out.calls.length, 1);
  assert.equal(out.calls[0].name, 'create_file');
  assert.equal(out.calls[0].arguments.path, 'a.js');
  assert.equal(out.calls[0].arguments.content, '第1行\n第2行\n第3行');
  assert.equal(out.content.trim(), '', '协议残渣不能留在正文里：' + out.content);
});

test('完全没有闭合标签、后面直接结束，也要解析出来', () => {
  const body = '<tool_call>{"name":"create_file","arguments":{"path":"b.js","content":"x = 1"}}';
  const out = parseToolCalls(body, TOOLS);
  assert.equal(out.calls.length, 1);
  assert.equal(out.calls[0].arguments.path, 'b.js');
  assert.equal(out.content.trim(), '');
});

// 真实事故（2026-10-22 16:34）：write 的内容是 JS，里面有模板字符串 `...`，
// 行内代码切分把 <tool_call> 块切碎，pattern 匹配不到，剩下被当残渣删掉 → tools=0、正文只剩半段。
test('参数里的模板反引号不能把协议块切碎', () => {
  const body = '<tool_call>{"name":"create_file","arguments":{"path":"a.js","content":"const s = `HTTP ${r.status}`;\\nreturn s;"}}</tool_call>';
  const out = parseToolCalls(body, TOOLS);
  assert.equal(out.calls.length, 1);
  assert.equal(out.calls[0].arguments.path, 'a.js');
  assert.equal(out.calls[0].arguments.content, 'const s = `HTTP ${r.status}`;\nreturn s;');
});

test('参数里带整段代码围栏也不能把协议块切碎', () => {
  const body = '<tool_call>{"name":"create_file","arguments":{"path":"doc.md","content":"示例：\\n```js\\nconst a = 1;\\n```\\n结束"}}</tool_call>';
  const out = parseToolCalls(body, TOOLS);
  assert.equal(out.calls.length, 1);
  assert.ok(out.calls[0].arguments.content.includes('const a = 1;'), JSON.stringify(out.calls[0].arguments));
});

test('围栏里的示例仍然不执行（保护没被上面的改动破坏）', () => {
  const body = ['看这个例子：', FENCE + 'json', '<tool_call>{"name":"create_file","arguments":{"path":"x"}}</tool_call>', FENCE].join('\n');
  const out = parseToolCalls(body, TOOLS);
  assert.equal(out.calls.length, 0, '围栏里的示例被当成真调用了');
  assert.ok(out.content.includes('<tool_call>'), '围栏内容应原样保留');
});




