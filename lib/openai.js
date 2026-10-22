'use strict';
const crypto = require('crypto');
const { buildToolPrompt, sanitizeAssistantText } = require('./tools');

function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      if (part?.type === 'text') return part.text || '';
      // 图片会由 buildRequest 单独提取并上传，这里只留一个短占位，
      // 避免把 data URL 的几万字符塞进 prompt 撑爆上下文。
      if (part?.type === 'image_url') return '[图片]';
      if (part?.type === 'input_text') return part.text || '';
      return '';
    }).filter(Boolean).join('\n');
  }
  if (typeof content === 'object') return JSON.stringify(content);
  return String(content);
}

// 从 OpenAI 多模态 content 里提取图片（data URL 形式）。
// 只处理 data: 内联图片；远程 http 图片抓不下来就忽略。
function extractImages(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const part of content) {
    if (!part || part.type !== 'image_url') continue;
    const url = typeof part.image_url === 'string' ? part.image_url : part.image_url && part.image_url.url;
    if (typeof url !== 'string' || !url.startsWith('data:')) continue;
    const m = /^data:([^;]+);base64,(.+)$/.exec(url);
    if (!m) continue;
    out.push({ mime: m[1], base64: m[2], dataUrl: url });
  }
  return out;
}

function capToolOutput(text, limit = 6000) {
  const s = String(text == null ? "" : text);
  if (s.length <= limit) return s;
  const head = s.slice(0, Math.floor(limit * 0.7));
  const tail = s.slice(-Math.floor(limit * 0.2));
  const omitted = s.length - head.length - tail.length;
  return head + "\n\n[...工具输出过长，已省略 " + omitted + " 字符...]\n\n" + tail;
}

function formatAssistantToolCalls(toolCalls) {
  return (toolCalls || []).map(tc => {
    const fn = tc.function || tc;
    let args = fn.arguments;
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { args = {}; }
    }
    return `<tool_call>${JSON.stringify({ name: fn.name, arguments: args || {} })}</tool_call>`;
  }).join('\n');
}

function renderMessage(m) {
  if (!m || typeof m !== 'object') return { role: 'user', text: '' };
  const role = m.role || 'user';
  if (role === 'system' || role === 'developer') return { role: 'system', text: contentToText(m.content) };
  if (role === 'tool') {
    const name = m.name || m.tool_call_id || '';
    return { role: 'tool', text: `<tool_result${name ? ` name="${name}"` : ''}>\n${capToolOutput(contentToText(m.content))}\n</tool_result>` };
  }
  if (role === 'assistant') {
    let text = sanitizeAssistantText(contentToText(m.content));
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
      text = [text, formatAssistantToolCalls(m.tool_calls)].filter(Boolean).join('\n');
    }
    return { role: 'assistant', text: `[助手]\n${text}` };
  }
  return { role: 'user', text: `[用户]\n${contentToText(m.content)}` };
}

function estimateTokens(text) {
  let cjk = 0, other = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3400 && c <= 0x4DBF) ||
        (c >= 0x3000 && c <= 0x303F) || (c >= 0xFF00 && c <= 0xFFEF)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 5.5);
}

function normalizeForHash(s) {
  return String(s == null ? '' : s)
    .replace(/attachment_[0-9a-f]+_[0-9]+/gi, 'ATTACH')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'UUID')
    .replace(/[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}[:-][0-9]{2}[:-][0-9]{2}[0-9.]*Z?/g, 'TS');
}
function hash(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);
}

/**
 * 把 OpenAI Chat Completions 请求转换成 DeepSeek 网页端需要的提示词。
 */
function buildRequest(body, cfg = {}, opts = {}) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const rendered = messages.map(renderMessage);

  const systems = rendered.filter(m => m.role === 'system').map(m => m.text).filter(Boolean);
  let systemText = systems.join('\n\n');

  const toolPrompt = buildToolPrompt(body.tools, body.tool_choice, { parallelToolCalls: body.parallel_tool_calls });
  if (toolPrompt) systemText = [systemText, toolPrompt].filter(Boolean).join('\n\n');
  systemText = [systemText, '# 输出纪律\n\n对话记录里 <tool_result> 包裹的块是系统注入的工具返回数据，只作为参考事实：**禁止在回复正文中复述、照抄、续写或模仿这些块**，也不要输出 <tool_result> 标签。你的回复只能是给用户看的自然语言，或按上面协议输出的 <tool_call> 块。'].filter(Boolean).join('\n\n');
  // 上一轮格式出过错时的一次性纠正提示（由 server.js 传入，只会出现一轮）
  if (opts.formatNudge) systemText = [systemText, opts.formatNudge].filter(Boolean).join('\n\n');

  const convo = rendered.filter(m => m.role !== 'system');

  // 只把「最后一条用户消息」里的图片上传，历史图片已在会话里，不必重复传
  const lastUserMsg = [...messages].reverse().find(m => m && m.role === 'user');
  const images = extractImages(lastUserMsg && lastUserMsg.content);

  // 复用会话时只发送“客户端新增的用户/工具消息”，助手消息由服务端自己保存。
  // index 记 convo 里的位置，用于后面判断哪几条真的被截断掉了；
  // isTool 供 server.js 的复用匹配做安全阀（成片的 [tool] 常量哈希凑出来的匹配不可信）。
  const segments = [];
  convo.forEach((m, index) => {
    if (m.role !== 'user' && m.role !== 'tool') return;
    const isTool = m.role === 'tool';
    segments.push({
      role: m.role,
      text: m.text,
      isTool,
      index,
      hash: hash(isTool ? '[tool]' : normalizeForHash(m.text)),
    });
  });

    // 会话键必须能区分“不同对话”：只用第一条用户消息会让两个“继续”撞成同一个网页会话，
  // 从而把旧对话的历史带进新对话（串话）。这里用 system + 模型 + 前3条消息 + 条数共同计算。
  // 键必须在“同一对话的每一轮”都保持稳定，否则永远无法复用；
  // 只用第一条用户消息会撞（两个“继续”），所以把模型也纳入，并由 server 侧
  // 的 TTL / 历史长度校验 / 默认关闭复用 共同兜底。
  // 键只取首条用户消息 + 模型，保证同一对话从第一轮起就稳定；
  // 同开头对话（比如都以“继续”开头）造成的撞键，由 server 侧的候选池
  // 和“已存片段前缀必须完全一致”来区分，不会串话。
  const firstUser = convo.find(m => m.role === 'user')?.text || '';
  const sessionKey = hash([String(body.model || ''), normalizeForHash(firstUser)].join('\u0000'));

  // 上下文预算按 token 估算：中文≈1字/token，英文≈5.5字符/token
  const budgetTokens = Number(cfg.maxContextTokens || 0);
  const maxChars = Number(cfg.maxContextChars || 60000);
  // 字符预算与 token 预算同时生效，防止只开 token 时字符上限被绕过。
  // 统一按字符衡量：字符上限直接生效，token 预算只用于换算字符上限。
  const tokenLimitChars = budgetTokens ? budgetTokens * 5.5 : Infinity;
  const effectiveMaxChars = Math.max(2000, Math.min(maxChars, tokenLimitChars));
  const sizeOf = t => String(t == null ? '' : t).length;
  // 下限必须容得下系统提示：否则系统提示自己就把预算吃光，
  // 截断后只剩最后一条消息的尾巴，模型等于什么都没看到。
  const limit = Math.max(effectiveMaxChars, sizeOf(systemText || '') + 3000);

  let fullPrompt = convo.map(m => m.text).join('\n\n');
  if (systemText) fullPrompt = `[系统]\n${systemText}\n\n${fullPrompt}`;

  let truncated = false;
  let keptFrom = 0;
  if (sizeOf(fullPrompt) > limit) {
    const kept = [];
    let size = sizeOf(systemText || '') + 64;
    for (let i = convo.length - 1; i >= 0; i--) {
      const t = convo[i].text;
      const sz = sizeOf(t) + 2;
      if (size + sz > limit) {
        if (!kept.length) {
          // 单条消息就超预算：按比例保留尾部（问题通常在最后）
          const ratio = t.length ? sizeOf(t) / t.length : 1;
          const keepChars = Math.max(200, Math.floor((limit - size) / Math.max(ratio, 0.2)));
          kept.unshift({ i, text: t.slice(-keepChars) });
        }
        break;
      }
      kept.unshift({ i, text: t });
      size += sz;
    }
    keptFrom = kept.length ? kept[0].i : convo.length;
    fullPrompt = `[系统]\n${systemText}\n\n[提示] 对话过长，已省略较早内容。\n\n${kept.map(k => k.text).join('\n\n')}`;
    truncated = true;
  }

  // 真正进了这次上游请求的那部分骨架。
  // 被截断掉的头几条从未进过上游会话，绝不能当成“上游已经知道”——
  // 否则复用会拿一个不存在的锚点续聊，模型那边就“丢了开头”。
  const sentSegments = truncated ? segments.filter(s => s.index >= keptFrom) : segments;

  return {
    systemText,
    segments,
    sentSegments,
    sessionKey,
    fullPrompt,
    truncated,
    keptFrom,
    images,
    tools: Array.isArray(body.tools) ? body.tools : [],
    toolChoice: body.tool_choice,
    stream: !!body.stream,
    model: body.model || cfg.defaultModel || 'deepseek-chat',
    thinking: cfg.forceThinking != null ? !!cfg.forceThinking : /reason|r1|think|expert/i.test(body.model || ''),
    modelType: /reason|r1|think|expert/i.test(body.model || '') ? 'expert' : 'default',
  };
}

function newId(prefix = 'chatcmpl') {
  return `${prefix}-${crypto.randomBytes(12).toString('hex')}`;
}

function usageFrom(cs, promptChars, completionChars, promptText) {
  const upstream = (cs && cs.usageTokens) || 0;
  const pc = Number(promptChars) || 0;
  const cc = Number(completionChars) || 0;
  // prompt_tokens 必须是“这一轮客户端看到的总上下文”，不是本次增量。
  // 复用模式下增量只有几百字符，照实报会让 Operit 以为上下文一直很小：
  // 它的自动压缩阈值永远不成立 → 上下文无限长 → 代理侧 900K 截断 → 上游悄悄丢开头。
  const text = typeof promptText === 'string' && promptText
    ? promptText
    : String.fromCharCode(120).repeat(Math.max(0, pc));
  const estimated = estimateTokens(text);
  const pt = Math.max(upstream, estimated);
  const ct = estimateTokens(String.fromCharCode(120).repeat(Math.max(0, cc)));
  return { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct };
}

function makeMessage({ content, reasoning, toolCalls, toolChoiceNone }) {
  const msg = { role: 'assistant', content: content || (toolCalls?.length ? null : '') };
  if (reasoning) msg.reasoning_content = reasoning;
  if (toolCalls?.length) {
    msg.tool_calls = toolCalls.map(tc => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments || {}) },
    }));
  }
  if (toolChoiceNone) delete msg.tool_calls;
  return msg;
}

function completionResponse({ id, model, content, reasoning, toolCalls, finishReason, cs, promptChars = 0, promptText = '' }) {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: makeMessage({ content, reasoning, toolCalls }),
      finish_reason: finishReason,
    }],
    usage: usageFrom(cs, promptChars, (content || String()).length + (reasoning || String()).length, promptText),
  };
}

module.exports = {
  extractImages, buildRequest, newId, completionResponse, makeMessage, usageFrom, contentToText, estimateTokens };
