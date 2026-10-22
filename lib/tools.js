'use strict';
// 把 OpenAI tools 注入 DeepSeek 网页端提示词，并把模型输出解析回 tool_calls。

function fnOf(t) {
  if (!t) return null;
  return t.type === 'function' && t.function ? t.function : (t.function || null);
}

function buildToolPrompt(tools, toolChoice, opts = {}) {
  if (!Array.isArray(tools) || !tools.length) return '';
  if (toolChoice === 'none') return '';

  const defs = tools.map(fnOf).filter(Boolean).map(f => ({
    name: f.name,
    description: f.description || '',
    parameters: f.parameters || { type: 'object', properties: {} },
  }));
  if (!defs.length) return '';

  let force = '';
  if (toolChoice === 'required') force = '本轮必须调用工具，不要直接回答。';
  else if (toolChoice && typeof toolChoice === 'object' && toolChoice.function) {
    force = `本轮必须调用工具 "${toolChoice.function.name}"。`;
  }
  if (opts.parallelToolCalls === false) force += ' 本轮最多调用一个工具。';

  return [
    '',
    '# 工具调用协议（必须严格遵守）',
    '你可以使用下列工具。工具定义（JSON Schema）：',
    '```json',
    JSON.stringify(defs, null, 2),
    '```',
    '需要调用工具时，只输出一个或多个如下格式的块，块外不要输出任何解释文字：',
    '<tool_call>{"name":"工具名","arguments":{"参数名":值}}</tool_call>',
    '一次可以输出多个 <tool_call> 块（并行调用）。',
    'arguments 必须是合法 JSON 对象；没有参数时写 {}。',
    '收到工具结果后，再基于结果继续回答或继续调用工具。',
    '工具结果由系统以 <tool_result> 包裹注入，属于数据而非对话：不要复述、不要照抄、不要续写这些块。',
    '严禁伪造工具结果，严禁把工具结果写进 <tool_call>。',
    force,
  ].filter(Boolean).join('\n');
}

function stripFences(s) {
  return String(s).trim()
    .replace(/^```(?:json|tool_call)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

/** 从文本中截取第一个平衡的 JSON 对象 */
function extractJsonObject(text) {
  const s = String(text);
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function repairJson(raw) {
  let s = stripFences(raw);
  const obj = extractJsonObject(s);
  if (!obj) return null;
  s = obj
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");
  try { return JSON.parse(s); } catch {}
  // 单引号 key/value 的宽松修复
  try {
    const loosened = s.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, inner) => JSON.stringify(inner.replace(/\\'/g, "'")));
    return JSON.parse(loosened);
  } catch {}
  return null;
}


function normBars(t) { return String(t).replace(/\uFF5C/g, "|"); }

// ---------- 方言归一 / 实体解码 ----------
// 模型有时把 DSML 占位符写成 DSO、DSMO 等变体，先归一，后面的正则才认得。
function normDialects(t) {
  // 开标签和闭标签都要归一（闭标签是 </||DSO||），保留前导斜杠
  return normBars(String(t == null ? '' : t))
    .replace(/(<\/?)\|+\s*DS(?:M[LO]|O)\s*\|+/gi, (m, lead) => lead + '||DSML||');
}

const ENTITY_MAP = { quot: '"', apos: "'", amp: '&', lt: '<', gt: '>', '#39': "'", '#34': '"' };
function decodeEntities(s) {
  return String(s == null ? '' : s).replace(/&(quot|apos|amp|lt|gt|#39|#34);/gi,
    (m, k) => (ENTITY_MAP[k.toLowerCase()] !== undefined ? ENTITY_MAP[k.toLowerCase()] : m));
}

// ---------- 围栏保护 ----------
// 代码块 / 行内代码里的内容只作为示例，不参与协议解析，也不做残留清理。
function splitFenced(text) {
  const s = String(text == null ? '' : text);
  const out = [];
  const re = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g;
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push({ fenced: false, text: s.slice(last, m.index) });
    out.push({ fenced: true, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ fenced: false, text: s.slice(last) });
  return out;
}

function mapUnfenced(text, fn) {
  return splitFenced(text).map(seg => (seg.fenced ? seg.text : fn(seg.text))).join('');
}

// ---------- XML 方言 ----------
// 模型经常不用 <tool_call>{json}</tool_call>，而是自创这些写法，
// 一旦漏解析：执行层拿不到调用，正文里却留下一整段标记（就是“泄露”）。
//   <tool_lM92 name="x"><param name="k">v</param></tool_lM92>
//   <tool_call name="x"><parameter name="k">v</parameter></tool_call>
//   <call><invoke name="x"><parameter name="k">v</parameter></invoke></call>
//   <invoke name="x"><parameter name="k">v</parameter></invoke>
// 模型有时把属性写成 name=\"x\"（多一层反斜杠），解析和清理都要容错
const Q = '\\\\?"';                      // 可选反斜杠 + 引号
const XML_PARAM_RE = new RegExp('<(?:param|parameter)\\s+name\\s*=\\s*' + Q + '([^"]*)' + Q + '[^>]*>([\\s\\S]*?)<\\/(?:param|parameter)\\s*>', 'gi');

function cleanName(s) {
  return String(s == null ? '' : s).replace(/\\+$/, '').trim();
}
function cleanVal(s) {
  return String(s == null ? '' : s).replace(/\\+$/, '');
}

function assembleArgs(params) {
  const keys = Object.keys(params);
  if (!keys.length) return {};
  if (keys.length === 1 && /^(arguments?|input|args|parameters?|params?)$/i.test(keys[0])) {
    const parsed = repairJson(params[keys[0]]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    if (parsed !== null) return { value: parsed };
    return {};
  }
  const out = {};
  for (const k of keys) {
    const v = String(params[k]).trim();
    const j = /^[\[{]/.test(v) ? repairJson(v) : null;
    out[k] = j == null ? v : j;
  }
  return out;
}

function extractXmlDialect(text, toolNames) {
  const calls = [];
  let s = String(text == null ? '' : text);

  const addFrom = (name, inner) => {
    const params = {};
    XML_PARAM_RE.lastIndex = 0;
    let pm;
    while ((pm = XML_PARAM_RE.exec(inner)) !== null) params[cleanName(pm[1])] = decodeEntities(cleanVal(pm[2]));
    const call = normalizeCall({ name: cleanName(name), arguments: assembleArgs(params) }, toolNames);
    if (call) calls.push(call);
  };

  // <call> 里的 <invoke>（整块连同外层一起吃掉）
  s = s.replace(/<call\b[^>]*>([\s\S]*?)<\/call\s*>/gi, (m, inner) => {
    const inv = /<invoke\s+name\s*=\s*\\?"([^"]*)\\?"[^>]*>([\s\S]*?)<\/invoke\s*>/gi;
    let m2;
    let hit = false;
    while ((m2 = inv.exec(inner)) !== null) { addFrom(m2[1], m2[2]); hit = true; }
    return hit ? '' : m;
  });
  // 裸 <invoke>
  s = s.replace(/<invoke\s+name\s*=\s*\\?"([^"]*)\\?"[^>]*>([\s\S]*?)<\/invoke\s*>/gi,
    (m, name, inner) => { addFrom(name, inner); return ''; });
  // <tool_xxx name=".."> / <tool_call name=".."> / <tool name="..">
  s = s.replace(/<(tool_[A-Za-z0-9_]*|tool_call|tool)\s+name\s*=\s*\\?"([^"]*)\\?"[^>]*>([\s\S]*?)<\/\1\s*>/gi,
    (m, tag, name, inner) => { addFrom(name, inner); return ''; });

  return { text: s, calls };
}

// 兜底清理：解析不出来（或只解析出一半）的协议碎片绝不能留在正文里。
const RESIDUE_RES = [
  /<call\b[^>]*>[\s\S]*?<\/call\s*>/gi,
  /<invoke\b[^>]*>[\s\S]*?<\/invoke\s*>/gi,
  /<(?:tool_[A-Za-z0-9_]*|tool_call|tool)\s+name\s*=[^>]*>[\s\S]*?<\/[A-Za-z0-9_]+\s*>/gi,
  /<result\s+name\s*=[^>]*>[\s\S]*?<\/result\s*>/gi,
  // 思考块：正常应该走 reasoning_content，出现在正文里就是泄露
  /<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?\s*>/gi,
  /<\/?(?:invoke|parameter|param|call|calls|result)\b[^>]*(?:>|$)/gi,
  /<\/?(?:tool_[A-Za-z0-9_]*|tool_calls?)\b[^>]*(?:>|$)/gi,
  /<\/?think(?:ing)?\b[^>]*(?:>|$)/gi,
  // 模型自造的变体：</call_call>、</call_end>、<call_start> …（真实见过 </call_call> 漏进正文）
  /<\/?(?:call|invoke|tool_call)[-_][A-Za-z0-9_]+\s*(?:\/>|>|$)/gi,
];

function stripXmlResidue(text) {
  let s = String(text == null ? '' : text);
  for (const re of RESIDUE_RES) s = s.replace(re, '');
  return s;
}

// 抢救残缺调用：模型写出「标记 + name= + JSON 参数」但没有闭合、甚至没有 '>' 的半截调用，
// 例如 <|DSML|| invoke name="bash",arguments={"command":"ls"}}
// 这类文本以前被 stripDanglingDsml 整段删掉 —— 于是上游产出的 token 全部消失，
// 客户端收到 content=0 / tools=0 / stop，表现为「工具调完了却不继续」。
// 这里尽量把它还原成一个真正的调用。
function salvageDanglingCall(text, toolNames) {
  const s = String(text == null ? '' : text);
  if (!/DSML|invoke|tool_call/i.test(s)) return null;
  const markerRe = /<\|+\s*DSML\s*\|+|<\/?(?:invoke|tool_call)\b/i;
  const marker = markerRe.exec(s);
  const searchFrom = marker ? marker.index : 0;
  const tail = s.slice(searchFrom);
  const nameRe = /name\s*=\s*["']([^"'\n]{1,80})["']/i;
  const nm = nameRe.exec(tail);
  if (!nm) return null;
  const braceAt = tail.indexOf('{', nm.index);
  if (braceAt < 0) return null;
  const objStr = extractJsonObject(tail.slice(braceAt));
  if (!objStr) return null;
  let args = null;
  try { args = JSON.parse(objStr); } catch { args = repairJson(objStr); }
  if (!args || typeof args !== 'object') return null;
  const call = normalizeCall({ name: nm[1], arguments: args }, toolNames, { lenient: true });
  if (!call) return null;
  return { call, start: searchFrom, end: searchFrom + braceAt + objStr.length };
}

// 模型偶尔把 DSML 标记和 JSON 参数混着写：既没有闭合标签，也没有结束的 '>'，
// 例如 <||DSML|| invoke name="create_file","arguments":{...}}
// 块级规则匹配不到它，这里把「标记开始到行尾」整段砍掉（围栏内不动）。
function stripDanglingDsml(text) {
  // 从标记一路删到下一个空行（或结尾）。模型的残缺块通常独占一个段落，
  // 而一个段落之后往往才是真正的正文。
  return normDialects(String(text == null ? '' : text))
    .replace(/<\/?\|+\s*DSML\s*\|+[\s\S]*?(?=\n[ \t]*\n|$)/gi, '');
}


// DeepSeek 上游原生 DSML 工具调用格式（<||DSML||invoke name="..">）
function parseDsml(text, toolNames) {
  const src = normDialects(text);
  const invokeRe = /<\|+\s*DSML\s*\|+\s*invoke\s+name\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/\|+\s*DSML\s*\|+\s*invoke\s*>/gi;
  const paramRe = /<\|+\s*DSML\s*\|+\s*parameter\s+name\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/\|+\s*DSML\s*\|+\s*parameter\s*>/gi;
  const calls = [];
  let m;
  while ((m = invokeRe.exec(src))) {
    const name = m[1].trim();
    const params = {};
    let pm;
    paramRe.lastIndex = 0;
    while ((pm = paramRe.exec(m[2]))) params[pm[1].trim()] = pm[2];
    const keys = Object.keys(params);
    let args = {};
    if (keys.length === 1 && /^(arguments?|input|args|parameters?)$/i.test(keys[0])) {
      args = repairJson(params[keys[0]]) ?? {};
    } else if (keys.length) {
      for (const k of keys) {
        const v = String(params[k]).trim();
        const j = /^[\[{]/.test(v) ? repairJson(v) : null;
        params[k] = j == null ? v : j;
      }
      args = params;
    }
    const call = normalizeCall({ name, arguments: args }, toolNames);
    if (call) calls.push(call);
  }
  return calls;
}

function stripDsml(text) {
  return normBars(text)
    .replace(/<\|+\s*DSML\s*\|+\s*(?:calls|tool_calls)\s*>[\s\S]*?<\/\|+\s*DSML\s*\|+\s*(?:calls|tool_calls)\s*>/gi, "")
    .replace(/<\|+\s*DSML\s*\|+\s*invoke\b[\s\S]*?<\/\|+\s*DSML\s*\|+\s*invoke\s*>/gi, "")
    .replace(/<\/?\|+\s*DSML\s*\|+[^>]*>/gi, "");
}


// 有些客户端（如 Operit）会把名为 arguments 的顶层参数当成非法参数直接报错，
// 模型偶尔会吐 {arguments:{...}, tool_name:...} 这种夹心结构，这里统一拆包。
function unwrapArgumentsKey(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const key = Object.keys(args).find(k => /^arguments?$/i.test(k));
  if (!key) return args;
  let inner = args[key];
  if (typeof inner === 'string') {
    const parsed = repairJson(inner);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) inner = parsed;
  }
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return args;
  const rest = Object.assign({}, args);
  delete rest[key];
  if (Object.keys(rest).length === 0) return unwrapArgumentsKey(inner);
  return unwrapArgumentsKey(Object.assign({}, rest, inner));
}

// 工具名容错：模型经常把 "super_admin:bash" 写成 "bash"、"Super_Admin:Bash"、
// "super-admin.bash"、"super_admin/bash"。精确匹配失败时按“归一化 + 唯一后缀”解析。
// 解析不出来返回 null（由调用方决定是丢弃还是照原样透传）。
function resolveToolName(name, toolNames) {
  if (!toolNames || !toolNames.size) return name;
  if (toolNames.has(name)) return name;
  const norm = s => String(s)
    .toLowerCase()
    .replace(/[\s.\-_/]+/g, ':')
    .replace(/:+/g, ':')
    .replace(/^:|:$/g, '');
  const target = norm(name);
  if (!target) return null;
  for (const n of toolNames) if (norm(n) === target) return n;
  const tail = target.split(':').pop();
  const byTail = [];
  for (const n of toolNames) if (norm(n).split(':').pop() === tail) byTail.push(n);
  if (byTail.length === 1) return byTail[0];
  return null;
}

function normalizeCall(o, toolNames, opts) {
  if (!o || typeof o !== 'object') return null;
  let name = o.name || o.tool || o.tool_name;
  let args = o.arguments ?? o.parameters ?? o.args ?? o.input;
  if (!name && o.function) { name = o.function.name; args = o.function.arguments ?? o.function.parameters; }
  if (typeof name !== 'string' || !name.trim()) return null;
  const asWritten = name.trim();
  name = asWritten;
  if (toolNames.size) {
    const resolved = resolveToolName(name, toolNames);
    if (resolved) {
      name = resolved;
      // 模型写的名字和声明不一致（缩写了命名空间、大小写不对…）→ 记一次，供纠正提示用
      if (opts && opts.stats && resolved !== asWritten) {
        opts.stats.renamed = (opts.stats.renamed || 0) + 1;
      }
    } else if (!(opts && opts.lenient)) {
      return null;
    }
    // lenient 模式：保留模型原本的名字透传出去。
    // 客户端会回一个“未知工具”的工具结果，模型据此自我纠正 —— 比整条回复消失、轮次
    // 静默结束要好得多（真实事故：59 个 token 的调用被删成 content=0/tools=0/stop）。
  }
  if (typeof args === 'string') {
    const parsed = repairJson(args);
    args = parsed ?? {};
  }
  if (args == null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) args = { value: args };
  args = unwrapArgumentsKey(args);
  return { name, arguments: args };
}

/**
 * 解析模型输出里的工具调用。
 * @returns {{content:string, calls:Array<{name:string,arguments:object}>}}
 */
// 只有工具调用/工具结果才会有的键：正文里出现它们 = 模型在复述历史，不是给用户看的正文
const TOOL_PAYLOAD_KEYS = ['context_preserved', 'exitCode', 'elapsedMs', 'toolCallId', 'tool_name', 'toolName'];

// 判断一个 JSON 对象像不像"工具调用/工具结果"的原文
function looksLikeToolPayload(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (obj.command !== undefined && obj.output !== undefined) return true;
  let hits = 0;
  for (const k of Object.keys(obj)) if (TOOL_PAYLOAD_KEYS.includes(k)) hits++;
  if (hits >= 2) return true;
  if (hits >= 1 && obj.output !== undefined) return true;
  return false;
}

// 删除正文里的工具调用/结果 JSON（没有标签的裸复述）。
// 判定用“段落”而不是“大括号配平”：模型被输出上限截断时 JSON 是不闭合的，
// 但那一整段仍然只由这个 JSON 组成，整段丢掉即可。
const ECHO_JSON_HEAD = /^\{\s*"(?:command|context_preserved|output|exitCode|tool_name|toolName|toolCallId|elapsedMs)"\s*:/;
function stripToolPayloads(text) {
  // 先归一换行：模型/客户端混用 \r\n 时，段落切分会失效
  const s = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  const blocks = s.split(/\n[ \t]*\n/);
  const kept = [];
  for (const block of blocks) {
    const t = block.trim();
    if (!t) continue;
    const isJsonBlock = t.startsWith('{') && ECHO_JSON_HEAD.test(t);
    if (isJsonBlock && !t.includes('```')) continue; // 整段都是抄回来的调用/结果
    kept.push(t);
  }
  return kept.join('\n\n');
}

// 工具报错被模型抄进正文（"<工具名> 工具调用参数不合法: ..." 这类整行）
function stripToolErrorEcho(text) {
  return String(text == null ? '' : text)
    .replace(/^[^\n]{0,60}?工具调用参数不合法[:：][^\n]*$/gm, '')
    .replace(/^[^\n]{0,60}?工具调用(?:失败|出错|被拒绝|超时)[:：][^\n]*$/gm, '');
}

// 统计"复述类垃圾"被删掉多少字符（只算 echo 类清理）
// 注意：不能拿「原文长度 - 清洗后长度」当指标 —— 合法的工具调用也会从正文里消失，
// 那样每次工具调用都会被误判成"模型犯了错"（真实反馈：每轮都弹提示）。
function mapAndCountEcho(text, fn, stats) {
  return mapUnfenced(text, seg => {
    const before = seg.length;
    const after = fn(seg);
    if (stats && after.length < before) stats.echoChars = (stats.echoChars || 0) + (before - after.length);
    return after;
  });
}

// 清除模型误抄进正文的残留标签与工具结果块
function sanitizeAssistantText(text, stats) {
  let s = stripDsmlLoose(String(text || ''));
  // 代码块里的内容原样保留（那是示例，不是协议）
  // 协议残片（含模型自造的 </call_call> 之类）要计数：只擦掉不告诉模型，它会一直这么写
  s = mapUnfenced(s, seg => {
    const before = seg.length;
    const out = stripXmlResidue(seg);
    if (stats && out.length < before) stats.residue = (stats.residue || 0) + (before - out.length);
    return out;
  });
  s = mapUnfenced(s, stripBareToolJson);
  s = mapAndCountEcho(s, stripToolPayloads, stats);
  s = mapAndCountEcho(s, stripToolErrorEcho, stats);
  s = mapUnfenced(s, seg => {
    const before = seg.length;
    const out = seg
      .replace(/<tool_result\b[^>]*>[\s\S]*?<\/tool_result>/gi, '')
      .replace(/<tool_result\b[^>]*>[\s\S]*$/gi, '')
      .replace(/\[工具结果[^\]\n]*\][\s\S]*?(?=\n\s*\[|$)/g, '')
      .replace(/<\/?tool_result>/gi, '');
    if (stats && out.length < before) stats.echoChars = (stats.echoChars || 0) + (before - out.length);
    return out;
  });
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}


// 无条件清除 DSML 残留（包括未闭合的残块，否则会原样显示在正文里）
function stripDsmlLoose(text) {
  let s = normDialects(String(text == null ? '' : text));
  s = s.replace(/<\|+\s*DSML\s*\|+\s*calls>[\s\S]*?<\/\|+\s*DSML\s*\|+\s*calls>/gi, '');
  s = s.replace(/<\|+\s*DSML\s*\|+\s*invoke\b[\s\S]*?<\/\|+\s*DSML\s*\|+\s*invoke>/gi, '');
  s = s.replace(/<\/?\|+\s*DSML\s*\|+\s*[^>]*>/gi, '');
  // 最后兜底：残缺的占位符（无闭合标签、甚至没有 '>'）连同行尾一起砍掉
  s = stripDanglingDsml(s);
  return s;
}

// 最后兜底：正文里残留的裸工具调用 JSON（{"name":"x","arguments":{...}}）整段切掉。
// 括号不平衡（模型截断）时直接砍到文本结尾，宁可少显示也不要把协议溢出来。
function stripBareToolJson(text) {
  let s = String(text == null ? '' : text);
  const re = /\{\s*"name"\s*:\s*"[^"]{1,80}"\s*,\s*"arguments"\s*:\s*\{/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const start = m.index;
    if (start < last) continue;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    out += s.slice(last, start);
    if (end > 0) { last = end; re.lastIndex = end; }
    else { last = s.length; break; }
  }
  out += s.slice(last);
  return out;
}

// 判断一个对象是否“看起来像工具调用”（用于删掉工具名不认识的残留）。
function looksLikeToolCall(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const hasName = typeof o.name === 'string' || typeof o.tool_name === 'string';
  const hasArgs = o.arguments !== undefined || o.parameters !== undefined || o.args !== undefined;
  return hasName && hasArgs;
}

// 从任意文本里挑出裸的 {"name":"工具","arguments":{...}} （DSML 残缺时常见）
function extractBareCalls(text, toolNames, stats) {
  let s = String(text == null ? '' : text);
  const calls = [];
  if (!toolNames || !toolNames.size) return { text: s, calls };
  for (let guard = 0; guard < 8; guard++) {
    const i1 = s.indexOf('{"name"');
    const i2 = s.indexOf('{ "name"');
    let start = -1;
    if (i1 >= 0 && i2 >= 0) start = Math.min(i1, i2);
    else start = i1 >= 0 ? i1 : i2;
    if (start < 0) break;
    const objStr = extractJsonObject(s.slice(start));
    if (!objStr) break;
    let parsed = null;
    try { parsed = JSON.parse(objStr); } catch { parsed = repairJson(objStr); }
    // 只有「像调用」（name + arguments）才往下走：正文里随手写的 {"name": "x"}
    // 没有 arguments，既不能执行也不能删掉。
    if (!looksLikeToolCall(parsed)) break;
    // lenient：名字认不出时也当成调用透传，绝不把它删成空正文
    const call = normalizeCall(parsed, toolNames, { lenient: true, stats });
    if (!call) {
      // 极端情况：形状像调用但连名字都取不出来 —— 从正文里删掉，避免协议泄露
      s = s.slice(0, start) + s.slice(start + objStr.length);
      continue;
    }
    calls.push(call);
    s = s.slice(0, start) + s.slice(start + objStr.length);
  }
  return { text: s, calls };
}

// <||DSML|| calls> ... </||DSML|| calls> 里直接放裸 JSON 的情况
function extractDsmlCallsBlock(text, toolNames) {
  const s = normBars(String(text == null ? '' : text));
  const m = /<\|+\s*DSML\s*\|+\s*calls>([\s\S]*?)<\/\|+\s*DSML\s*\|+\s*calls>/i.exec(s);
  if (!m) return { calls: [] };
  return { calls: extractBareCalls(m[1], toolNames).calls };
}


// 按工具 JSON Schema 收敛参数：
// 1) 非法顶层键不丢，优先推进 params（否则丢弃）
// 2) params 是 JSON 字符串时自动解成对象
// 3) 按 schema 类型做基础强转，避免 "1" vs 1 / 字符串 vs 对象 造成的客户端校验失败
function coerceArgs(args, schema) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const props = schema && schema.properties;
  if (!props || typeof props !== 'object') return args;

  const out = {};
  const extra = {};
  const paramsSchema = props.params;
  const paramsIsObject = !!paramsSchema && (!paramsSchema.type || paramsSchema.type === 'object');

  for (const key of Object.keys(args)) {
    const val = args[key];
    if (Object.prototype.hasOwnProperty.call(props, key)) {
      out[key] = castValue(val, props[key]);
    } else if (paramsIsObject) {
      extra[key] = val;
    }
    // 既不在 schema 里、又没有 params 兜底：丢弃
  }

  if (paramsIsObject) {
    let base = out.params;
    if (typeof base === 'string') {
      const parsed = repairJson(base);
      base = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    }
    if (!base || typeof base !== 'object' || Array.isArray(base)) base = {};
    if (Object.keys(extra).length) base = Object.assign({}, extra, base);
    out.params = base;
  }
  return out;
}

function castValue(val, spec) {
  if (!spec || val == null) return val;
  const type = spec.type;
  if (type === 'object' || (spec.properties && !type)) {
    if (typeof val === 'string') {
      const parsed = repairJson(val);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    }
    return val;
  }
  if (type === 'string') {
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
  }
  if (type === 'number' || type === 'integer') {
    const n = Number(val);
    return Number.isFinite(n) ? (type === 'integer' ? Math.trunc(n) : n) : val;
  }
  if (type === 'boolean') {
    if (typeof val === 'string') return /^(true|1|yes|on)$/i.test(val.trim());
    return !!val;
  }
  return val;
}

function parseToolCalls(text, tools, opts) {
  // stats 用于统计"这一轮模型有没有用非标准格式"，好在下一轮明确告诉它格式错了
  const stats = (opts && opts.stats) || null;
  const toolNames = new Set((tools || []).map(fnOf).filter(Boolean).map(f => f.name));
  const calls = [];
  let rest = String(text || '');

  const patterns = [
    /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi,
    /<tool_calls>\s*([\s\S]*?)\s*<\/tool_calls>/gi,
    /<\|tool_call_begin\|>\s*([\s\S]*?)\s*<\|tool_call_end\|>/gi,
    /```tool_call\s*([\s\S]*?)```/gi,
  ];

  // 全部解析/清洗都在「非围栏段」上做：代码块和行内代码里的标记只是示例，
  // 既不能当成真实调用（否则围栏里的示例会被执行），也不能被当残留删掉。
  rest = mapUnfenced(rest, seg => {
    let s = seg;
    const callsBefore = calls.length;

    for (const re of patterns) {
      s = s.replace(re, (_, inner) => {
        const parsed = repairJson(inner);
        const list = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of list) {
          const call = normalizeCall(item, toolNames, { stats });
          if (call) calls.push(call);
        }
        return '';
      });
    }

    // 原生 DSML 格式（模型偶尔绕开约定协议，直接吐上游格式）
    if (calls.length === callsBefore) {
      const dsml = parseDsml(s, toolNames);
      if (dsml.length) {
        calls.push(...dsml);
        if (stats) stats.dialect = (stats.dialect || 0) + 1;
      } else {
        const inBlock = extractDsmlCallsBlock(s, toolNames);
        if (inBlock.calls.length) {
          calls.push(...inBlock.calls);
          if (stats) stats.dialect = (stats.dialect || 0) + 1;
        }
      }
    }

    // 自创的 XML 方言（<tool_xxx name><param>、<invoke name>、<tool_call name>）
    // 以前这类完全不认：调用不执行、标记原样进正文。
    const x = extractXmlDialect(s, toolNames);
    if (x.calls.length) {
      calls.push(...x.calls);
      if (stats) stats.dialect = (stats.dialect || 0) + 1;
    }
    s = x.text;

    // 残缺调用抢救：名字+JSON 参数都在、只是标签没写完的，还原成真调用，
    // 而不是当垃圾删掉（删掉的后果是整轮变成 content=0/tools=0，看起来就是「自己停了」）。
    if (calls.length === callsBefore) {
      const salv = salvageDanglingCall(s, toolNames);
      if (salv) {
        calls.push(salv.call);
        if (stats) stats.salvaged = (stats.salvaged || 0) + 1;
        s = s.slice(0, salv.start) + s.slice(salv.end);
      }
    }

    // 无条件清除 DSML 残留：残缺块解析不出调用，绝不能留在正文里
    s = stripDsmlLoose(s);

    if (toolNames.size) {
      const bare = extractBareCalls(s, toolNames, stats);
      if (bare.calls.length) calls.push(...bare.calls);
      s = bare.text;
    }
    return s;
  });

  let content = sanitizeAssistantText(rest, stats)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();


  // 没有标签但整段就是一个 JSON 调用（常见于 tool_choice=required）
  // 注意：这里必须严格判定「整条回复就是一个 JSON 对象」，不能在正文里随便找一个
  // JSON 就当成调用 —— 否则回复里只要举一个 {"name":..,"arguments":..} 的例子
  // （哪怕放在代码块里），整条正文都会被清空，看起来就是“话被吞了”。
  if (!calls.length && content) {
    const trimmed = content.trim();
    if (/^[\[{]/.test(trimmed) && !trimmed.includes('```')) {
      const objStr = extractJsonObject(trimmed);
      if (objStr) {
        const at = trimmed.indexOf(objStr);
        const leftover = (trimmed.slice(0, at) + trimmed.slice(at + objStr.length)).replace(/\s+/g, '');
        if (leftover.length <= 4) {
          const maybe = repairJson(objStr);
          const list = Array.isArray(maybe) ? maybe : [maybe];
          const found = list.map(x => normalizeCall(x, toolNames, { lenient: true, stats })).filter(Boolean);
          if (found.length && found.length === list.length) {
            calls.push(...found);
            content = '';
          }
        }
      }
    }
  }

  // 最后一道闸：按每个工具的 JSON Schema 收敛参数，裁掉一切非法键
  if (calls.length) {
    const defs = (tools || []).map(fnOf).filter(Boolean);
    for (const c of calls) {
      const def = defs.find(d => d.name === c.name);
      c.arguments = coerceArgs(c.arguments, def && def.parameters);
    }
  }
  return { content, calls };
}

function makeCallId() {
  return 'call_' + require('crypto').randomBytes(12).toString('hex');
}

module.exports = { buildToolPrompt, parseToolCalls, makeCallId, sanitizeAssistantText };
