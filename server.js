#!/usr/bin/env node
'use strict';
/*
 * DeepSeek Free Proxy for Forvex / RikkaHub
 * 把 DeepSeek 网页端 / App 端（chat.deepseek.com/api/v0）反代为 OpenAI 兼容接口。
 * 零第三方依赖，Node >= 18。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { DeepSeekClient, DeepSeekError } = require('./lib/deepseek');
const { buildRequest, newId, completionResponse, usageFrom } = require('./lib/openai');
const { parseToolCalls, makeCallId } = require('./lib/tools');

const ROOT = __dirname;
const CONFIG_PATH = process.env.DS_PROXY_CONFIG || path.join(ROOT, 'config.json');
const STATE_PATH = process.env.DS_PROXY_STATE || path.join(ROOT, 'state.json');
const VERSION = '1.0.0';

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,
  token: '',
  cookie: '',
  clientOs: 'android',
  deviceId: '',
  defaultModel: 'deepseek-chat',
  maxContextChars: 60000,
  maxSessionChars: 4000000,
  maxTurnsPerSession: 80,
  reuseMatchMode: 'anywhere',
  reusePrependMaxChars: 60000,
  sessionReuse: false,
  // 把模型吐出的协议标记（DSML / <invoke> / 裸调用 JSON）从正文里洗掉。
  // 绝大多数 OpenAI 兼容客户端会把 content 当 markdown 直接渲染，不洗就会看到协议泄露；
  // 但如果客户端自己会解析这些方言，可以设成 false，避免把它需要的标记删掉。
  stripProtocolResidue: true,
  sessionTtlMs: 1800000,
  minRequestGapMs: 1500,
  maxContextTokens: 1000000,
  baseUrl: 'https://chat.deepseek.com/api/v0',
  hifUrl: 'https://hif-leim.deepseek.com/query',
  wasmUrl: 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm',
  wasmCachePath: path.join(ROOT, 'sha3.wasm'),
  requestTimeoutMs: 300000,
};

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function saveJson(p, obj) {
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

let config = { ...DEFAULTS, ...loadJson(CONFIG_PATH, {}) };
if (process.env.DS_BASE_URL) config.baseUrl = process.env.DS_BASE_URL;
if (process.env.DS_HIF_URL) config.hifUrl = process.env.DS_HIF_URL;
if (process.env.DS_WASM_PATH) config.wasmCachePath = process.env.DS_WASM_PATH;
if (process.env.DS_TOKEN) config.token = process.env.DS_TOKEN;
if (!config.deviceId) config.deviceId = crypto.randomUUID();
saveJson(CONFIG_PATH, config);

let state = loadJson(STATE_PATH, { sessions: {} });
if (!state.sessions) state.sessions = {};
if (!state.images) state.images = {};

const client = new DeepSeekClient({
  baseUrl: config.baseUrl,
  token: config.token,
  cookie: config.cookie,
  clientOs: config.clientOs,
  deviceId: config.deviceId,
  hifUrl: config.hifUrl,
  wasmUrl: config.wasmUrl,
  wasmCachePath: config.wasmCachePath,
  timeoutMs: config.requestTimeoutMs,
});

function refreshClient() {
  client.setToken(config.token, config.cookie);
  client.clientOs = config.clientOs === 'web' ? 'web' : 'android';
  client.hifUrl = config.hifUrl;
}

// ---------- 会话锁 ----------
const locks = new Map();
// 全局请求间隔：所有上游请求共用一个节流器，避免高频触发风控。
let lastUpstreamAt = 0;
async function throttleUpstream() {
  const gap = Number(config.minRequestGapMs || 0);
  if (!gap) return;
  const wait = gap - (Date.now() - lastUpstreamAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastUpstreamAt = Date.now();
}

async function acquire(key) {
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const cur = new Promise(r => { release = r; });
  locks.set(key, prev.then(() => cur));
  await prev;
  return () => {
    release();
    if (locks.get(key) === cur) locks.delete(key);
  };
}

// ---------- 工具函数 ----------
function json(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  });
  res.end(body);
}
function errorJson(res, status, message, code = 'proxy_error') {
  json(res, status, { error: { message, type: 'invalid_request_error', code } });
}
function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('JSON 解析失败: ' + e.message)); }
    });
    req.on('error', reject);
  });
}
function saveStateDebounced() {
  clearTimeout(saveStateDebounced.t);
  saveStateDebounced.t = setTimeout(() => saveJson(STATE_PATH, state), 300);
}
function pruneSessions() {
  const now = Date.now();
  const ttl = 24 * 3600 * 1000;
  for (const [k, raw] of Object.entries(state.sessions)) {
    // 一个桶里挂的是「候选会话数组」，不是单个对象。
    // 旧写法直接读 v.updatedAt，数组上永远是 undefined，
    // 于是每次启动 / 每 10 分钟都会把所有会话记录整桶删掉 ——
    // 下一次请求必然 fresh + 全量重传，这才是 429 的主要来源。
    const arr = (Array.isArray(raw) ? raw : (raw ? [raw] : []))
      .filter(e => e && Array.isArray(e.segments) && (now - (e.updatedAt || 0)) <= ttl);
    if (arr.length) state.sessions[k] = arr;
    else delete state.sessions[k];
  }
}

// ---------- 流式写出 ----------
function sseHead(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',
    'access-control-allow-origin': '*',
  });
}
function sseData(res, obj) {
  if (!res || res.writableEnded || res.destroyed) return;
  try {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  } catch (e) {
    logLine({ event: 'sse_write_error', code: e.code || '-', msg: e.message });
  }
}
function chunk(delta, finish = null, extra = {}) {
  return {
    id: extra.id,
    object: 'chat.completion.chunk',
    created: extra.created || Math.floor(Date.now() / 1000),
    model: extra.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(extra.usage ? { usage: extra.usage } : {}),
  };
}

// ---------- 主处理 ----------
async function handleChat(req, res, body) {
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return errorJson(res, 400, 'messages 不能为空');
  }
  if (!config.token) {
    return errorJson(res, 401, '尚未配置 DeepSeek Token。请打开 http://127.0.0.1:' + config.port + '/ 导入网页版 Token。', 'missing_token');
  }

  const messages = (Array.isArray(body.messages) ? body.messages : []).filter(m => m && typeof m === 'object');
  if (!messages.length) {
    return errorJson(res, 400, 'messages 不能为空', 'bad_request');
  }
  body = { ...body, messages };

  let r;
  try {
    r = buildRequest(body, config);
    // 上一轮模型用了非标准格式（方言/缩写名/残缺标签）：这一轮在系统提示里明确纠正它。
    // 只纠正一次 —— 本轮没再犯错就会清掉，否则会变成每轮都念的噪音。
    const pendingNudge = lastFormatNudge(r.sessionKey);
    if (pendingNudge) {
      r = buildRequest(body, config, { formatNudge: renderFormatNudge(pendingNudge) });
      try { logLine({ event: 'format_nudge', kinds: pendingNudge.kinds.join('+'), times: pendingNudge.times }); } catch (_) {}
    }
  } catch (e) {
    // 请求体异常也要给客户端一个明确错误：以前这里在 try 之外抛，客户端会
    // 一直挂着等（界面上就是“正在处理”停不下来），比报错难查得多。
    logLine({ event: 'bad_request', msg: e.message });
    return errorJson(res, 400, '请求格式错误: ' + e.message, 'bad_request');
  }
  try { logLine({ event: 'seg', n: r.segments.length, head: r.segments.slice(0,3).map(x => x.role.charAt(0) + ':' + String(x.text).slice(0,50).replace(/\s+/g,' ')).join(' ~ '), tail: r.segments.slice(-3).map(x => x.role.charAt(0) + ':' + String(x.text).slice(0,50).replace(/\s+/g,' ')).join(' ~ ') }); } catch (_) {}
  const stream = r.stream;
  const id = newId();
  const created = Math.floor(Date.now() / 1000);

  // 图片：上传到上游文件服务，拿到 file_id 后随请求一起发。
  // 按图片内容哈希缓存，同一张图只上传一次（复用轮次不会重复上传）。
  let refFileIds = [];
  if (Array.isArray(r.images) && r.images.length) {
    for (const img of r.images.slice(0, 6)) {
      try {
        const buf = Buffer.from(img.base64, 'base64');
        const digest = crypto.createHash('sha256').update(buf).digest('hex');
        const cacheKey = digest.slice(0, 32);
        let fid = state.images[cacheKey];
        if (!fid) {
          await throttleUpstream();
          const up = await client.uploadImage(buf, 'image.' + (img.mime.split('/')[1] || 'png'), img.mime);
          await client.waitFileReady(up.id);
          fid = up.id;
          state.images[cacheKey] = fid;
          saveStateDebounced();
          logLine({ event: 'image_uploaded', id: fid, bytes: buf.length, mime: img.mime });
        }
        refFileIds.push(fid);
      } catch (e) {
        logLine({ event: 'image_upload_failed', msg: e.message });
      }
    }
  }

  const release = await acquire(r.sessionKey);
  let aborted = false;
  res.on('close', () => { if (!res.writableEnded) aborted = true; });

  try {
    // 复用匹配用的“骨架”：只含 user/tool 消息，且必须是本次真正发给上游的那几条。
    // 上下文被截断时，前面被砍掉的消息从未进过上游会话，不能算“上游已覆盖”，
    // 否则会拿一个不存在的锚点去续聊，模型那边就悄悄丢了开头。
    const spine = Array.isArray(r.sentSegments) ? r.sentSegments : r.segments;
    const hashes = spine.map(s => s.hash);
    const isTool = spine.map(s => !!s.isTool);
    const ttl = Number(config.sessionTtlMs || 1800000);
    const matchMode = config.reuseMatchMode === 'head' ? 'head' : 'anywhere';
    const turnsCap = Number(config.maxTurnsPerSession || 80);
    const charsCap = Number(config.maxSessionChars || 4000000);
    const prependCap = Number(config.reusePrependMaxChars || 60000);

    let entry = null;
    let matchedKey = null;
    let match = null;
    let missReason = 'disabled';
    let sawCapped = false;
    if (config.sessionReuse) {
      for (const [k, raw] of Object.entries(state.sessions)) {
        const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
        for (const e of arr) {
          if (!e || !Array.isArray(e.segments)) continue;
          if (Date.now() - (e.updatedAt || 0) > ttl) continue;
          if (e.segments.length < 2) continue;
          const m = findTailMatch(hashes, e.segments, isTool, matchMode);
          if (!m) continue;
          if ((e.turns || 0) >= turnsCap) { sawCapped = true; continue; }
          if ((e.sentChars || 0) >= charsCap) { sawCapped = true; continue; }
          if (!match || m.len > match.len || (m.len === match.len && m.end > match.end)) {
            entry = e; matchedKey = k; match = m;
          }
        }
      }
      if (!entry) missReason = sawCapped ? 'capped' : 'no-match';
    }

    let sessionId, parentMessageId, prompt, mode, prependChars = 0;
    if (entry && match) {
      const built = buildReusePrompt(spine, match, prependCap);
      if (built) {
        sessionId = entry.sessionId;
        parentMessageId = entry.parentMessageId ?? null;
        prompt = built.text;
        prependChars = built.prependChars;
        mode = 'reuse';
      }
    }
    if (mode !== 'reuse') {
      await throttleUpstream();
      sessionId = await client.createSession();
      parentMessageId = null;
      prompt = r.fullPrompt;
      mode = 'fresh';
      logLine({ event: 'reuse_miss', reason: missReason, n: hashes.length, trunc: r.truncated ? 1 : 0, sent: prompt.length });
    }

    const startedAt = Date.now();
    let started = false;
    const ensureStart = () => {
      if (started || !stream) return;
      started = true;
      sseHead(res);
      sseData(res, chunk({ role: 'assistant', content: null }, null, { id, model: r.model, created }));
    };

    let contentSeen = '';
    let thinkSeen = '';
    let cs = null;
    let final = null;
    for (let attempt = 1; final === null; attempt++) {
      try {
        await throttleUpstream();
        const once = await client.startCompletion({
      sessionId,
      parentMessageId,
      prompt,
      thinkingEnabled: r.thinking,
      modelType: r.modelType,
      refFileIds,
      onDelta: d => {
        if (aborted) return;
        if (d.type === 'think') {
          thinkSeen += d.text;
          if (stream) {
            ensureStart();
            sseData(res, chunk({ reasoning_content: d.text }, null, { id, model: r.model, created }));
          }
        } else if (d.type === 'content') {
          contentSeen += d.text;
          // 有工具时先缓冲，避免把 <tool_call> 片段漏给客户端
          if (stream && !r.tools.length) {
            ensureStart();
            sseData(res, chunk({ content: d.text }, null, { id, model: r.model, created }));
          }
        }
      },
        });
        cs = once.stream;
        final = await once.done;
      } catch (err) {
        const st = err.status || 0;
        const msg = String(err.message || '');
        // 429 / 5xx 是可重试的限流或瞬时故障：原地等待后重试同一会话，
        // 绝不能降级成“新建会话 + 全量重发”，那既慢又最容易触发风控。
        const retryable = st === 429 || st === 503 || st === 502 || /频繁|rate limit/i.test(msg);
        // DeepSeek 的「消息发送过于频繁」是按分钟级冷却的，3s/6s/9s 的浅重试会在冷却结束前
        // 就放弃，把 429 直接抛给客户端。改为指数退避（5s → 10s → 20s → 40s → 60s），
        // 最多 6 次，整体耗时仍在 requestTimeoutMs 预算内。
        if (retryable && !started && attempt < 7) {
          const wait = Math.min(60000, 5000 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 1500);
          logLine({ event: 'upstream_retry', status: st, attempt, waitMs: wait });
          await new Promise(r => setTimeout(r, wait));
          lastUpstreamAt = Date.now();
          continue;
        }
        // 复用会话失效（过期/被上游清掉）时，自动回退到新会话重发一次
        if (mode === 'reuse' && !started && attempt === 1) {
          try {
            sessionId = await client.createSession();
            parentMessageId = null;
            prompt = r.fullPrompt;
            mode = 'fresh';
            contentSeen = '';
            thinkSeen = '';
            continue;
          } catch (e2) { throw err; }
        }
        throw err;
      }
    }
    // usage 里的 prompt_tokens 要按“整段上下文”报，不能只报本次增量：
    // Operit 靠它算上下文占用，报小了它的自动压缩永远不触发，上下文就会一路涨到被截断。
    const usage = usageFrom(final, r.fullPrompt.length, contentSeen.length + thinkSeen.length, r.fullPrompt);
    let content = final.content || contentSeen;
    let reasoning = final.thinking || thinkSeen;
    let toolCalls = [];
    const recoverStats = {};
    if (r.tools.length && r.toolChoice !== 'none') {
      const rawContent = content;
      const parsed = parseToolCalls(content, r.tools, { stats: recoverStats });
      if (config.stripProtocolResidue !== false) content = parsed.content;
      else content = rawContent;
      toolCalls = parsed.calls.map(c => ({ id: makeCallId(), name: c.name, arguments: c.arguments }));
    }
    const finishReason = toolCalls.length ? 'tool_calls' : 'stop';
    // 模型用了非标准格式（方言 / 缩写的工具名 / 残缺标签）→ 下一轮明确告诉它，
    // 否则它会一直沿用错误格式（我们照单全收，在它眼里就是"格式没错"）。
    const recoverKinds = ['salvaged', 'dialect', 'renamed'].filter(k => recoverStats[k]);

    // 更新会话状态
    if (matchedKey && matchedKey !== r.sessionKey && state.sessions[matchedKey]) {
      const oldArr = (Array.isArray(state.sessions[matchedKey]) ? state.sessions[matchedKey] : []).filter(e => e !== entry);
      if (oldArr.length) state.sessions[matchedKey] = oldArr; else delete state.sessions[matchedKey];
    }
    const kept = (Array.isArray(state.sessions[r.sessionKey]) ? state.sessions[r.sessionKey] : []).filter(e => e !== entry);
    const priorNudge = mode === 'reuse' && entry && entry.formatNudge ? entry.formatNudge : null;
    const nextFormatNudge = recoverKinds.length
      ? { kinds: recoverKinds, times: (priorNudge ? (priorNudge.times || 0) : 0) + 1 }
      : null;
    state.sessions[r.sessionKey] = [...kept, {
      sessionId,
      parentMessageId: final.messageId ?? parentMessageId,
      segments: hashes,
      turns: (mode === 'reuse' && entry ? (entry.turns || 0) : 0) + 1,
      promptChars: r.fullPrompt.length,
      // 同一个上游会话累计推了多少字符 —— 上限看这个，而不是看客户端上下文长度
      sentChars: (mode === 'reuse' && entry ? (entry.sentChars || 0) : 0) + String(prompt || '').length,
      // 一次性：本轮没再用错格式就清掉，避免每轮都念一遍
      ...(nextFormatNudge ? { formatNudge: nextFormatNudge } : {}),
      updatedAt: Date.now(),
    }].slice(-4);
    saveStateDebounced();

    const rawContent = String(final.content || contentSeen || '');
    const doneLog = {
      id, model: r.model, mode, stream, ms: Date.now() - startedAt,
      prompt: prompt.length, think: reasoning.length, content: content.length,
      raw: rawContent.length, tools: toolCalls.length, reason: finishReason,
      ...(mode === 'reuse'
        ? { match: `${match.len}@${match.off}`, prepend: prependChars, turns: (mode === 'reuse' && entry ? (entry.turns || 0) : 0) + 1 }
        : { n: hashes.length, trunc: r.truncated ? 1 : 0 }),
      ...(recoverKinds.length ? { recover: recoverKinds.join('+') } : {}),
    };
    // 诊断：上游明明产出了内容，最终正文和工具调用却都是空 —— 说明解析/清洗层把它吃掉了。
    // 不打原始文本就只能看到 content=0，无从下手（真实事故：59 个输出 token 消失）。
    if (!content.length && !toolCalls.length && rawContent.length) {
      doneLog.rawHead = JSON.stringify(rawContent.slice(0, 240));
      doneLog.empty = 1;
    } else if (rawContent.length && rawContent.length !== content.length) {
      doneLog.stripped = rawContent.length - content.length;
    }

    if (!stream) {
      logLine(doneLog);
      return json(res, 200, completionResponse({
        id, model: r.model, content, reasoning, toolCalls, finishReason,
        cs: final, promptChars: r.fullPrompt.length, promptText: r.fullPrompt,
      }));
    }

    ensureStart();
    if (r.tools.length) {
      if (content) sseData(res, chunk({ content }, null, { id, model: r.model, created }));
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i];
        sseData(res, chunk({
          tool_calls: [{
            index: i,
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments || {}) },
          }],
        }, null, { id, model: r.model, created }));
      }
    }
    sseData(res, chunk({}, finishReason, { id, model: r.model, created, usage }));
    res.write('data: [DONE]\n\n');
    res.end();

    logLine(doneLog);
  } catch (e) {
    const status = e.status || 502;
    logLine({ id, error: e.message, status });
    if (stream && res.headersSent) {
      sseData(res, { error: { message: e.message, type: 'upstream_error', code: e.code || 'upstream_error' } });
      res.write('data: [DONE]\n\n');
      res.end();
    } else if (!res.headersSent) {
      errorJson(res, status, e.message, e.code || 'upstream_error');
    } else {
      res.end();
    }
  } finally {
    release();
  }
}

const LOG_PATH = process.env.DS_PROXY_LOG || path.join(ROOT, 'proxy.log');
let logBroken = false;
const RING = [];
function logLine(obj) {
  const t = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const parts = Object.entries(obj).map(([k, v]) => `${k}=${v}`).join(' ');
  const line = `[${t}] ${parts}\n`;
  try { RING.push(line.trimEnd()); if (RING.length > 800) RING.shift(); } catch (_) {}
  try { process.stdout.write(line); } catch (_) {}
  // 直接落盘，避免 stdout 被管道缓冲导致日志延迟或丢失
  if (!logBroken) {
    try {
      fs.appendFileSync(LOG_PATH, line);
    } catch (_) {
      // 首选路径不可写时回退到 /tmp，保证日志确实能落盘
      try { fs.appendFileSync('/tmp/dsx-proxy.log', line); }
      catch (__) { logBroken = true; }
    }
  }
}

// 取这个会话最近一次记录里的“格式纠正待办”
function lastFormatNudge(sessionKey) {
  const bucket = state.sessions && state.sessions[sessionKey];
  if (!Array.isArray(bucket) || !bucket.length) return null;
  const entry = bucket[bucket.length - 1];
  return entry && entry.formatNudge ? entry.formatNudge : null;
}

// 把“上一轮格式不对”变成一条系统提示。措辞要具体到可执行，否则模型只是道歉。
function renderFormatNudge(nudge) {
  const kinds = (nudge && nudge.kinds) || [];
  const why = [];
  if (kinds.includes('salvaged')) why.push('标签没有闭合或缺少 `>`（残缺的工具调用）');
  if (kinds.includes('dialect')) why.push('用了 DSML / <invoke> / <parameter> 等非约定写法');
  if (kinds.includes('renamed')) why.push('工具名与声明不完全一致（缩写、大小写或命名空间不对）');
  return [
    '# 工具调用格式纠正',
    '',
    `你上一轮的工具调用格式不规范：${why.join('；') || '未按约定协议输出'}。`,
    '本轮已按你的意图代你修正，但请**从现在起严格使用唯一的标准格式**：',
    '',
    '```',
    '<tool_call>{"name":"工具名","arguments":{...}}</tool_call>',
    '```',
    '',
    '要求：',
    '1. 工具名必须与工具声明逐字一致（不要缩写、不要改大小写、不要省略命名空间）。',
    '2. 一个调用一个 `<tool_call>` 块，必须完整闭合；不要使用 DSML、`<invoke>`、`<parameter>` 等其他写法。',
    '3. 不要把这些标记写进正文或代码块里。',
  ].join('\n');
}

// ---------- 页面 ----------
function authPage() {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DeepSeek Free Proxy</title>
<style>
body{font-family:system-ui,-apple-system,"PingFang SC",sans-serif;margin:0;padding:20px;background:#0f1115;color:#e6e6e6}
.card{max-width:720px;margin:0 auto;background:#171a21;border:1px solid #2a2f3a;border-radius:14px;padding:20px}
h1{font-size:20px;margin:0 0 6px} .sub{color:#8b93a3;font-size:13px;margin-bottom:18px}
label{display:block;font-size:13px;color:#aab2c0;margin:14px 0 6px}
input,textarea{width:100%;box-sizing:border-box;background:#0f1218;border:1px solid #2c3340;color:#e6e6e6;border-radius:9px;padding:10px;font-size:13px;font-family:ui-monospace,Menlo,monospace}
textarea{min-height:90px;resize:vertical}
button{margin-top:14px;background:#2f6fed;border:0;color:#fff;padding:10px 16px;border-radius:9px;font-size:14px}
pre{background:#0f1218;border:1px solid #2c3340;border-radius:9px;padding:12px;overflow:auto;font-size:12px;line-height:1.6}
.ok{color:#45c486}.bad{color:#ff6b6b}.tip{font-size:12px;color:#8b93a3;line-height:1.7}
</style>
<div class="card">
<h1>DeepSeek Free Proxy</h1>
<div class="sub">把 DeepSeek 网页端 / App 端转成 OpenAI 兼容接口 · Forvex 专用</div>
<div id="status" class="tip">读取状态中…</div>
<label>DeepSeek Token（localStorage 里的 userToken.value）</label>
<textarea id="token" placeholder="粘贴 token，不需要 Bearer 前缀"></textarea>
<label>Cookie（可选，Cloudflare/WAF 风控时再填）</label>
<textarea id="cookie" placeholder="可留空"></textarea>
<button onclick="save()">保存并校验</button>
<div class="tip" style="margin-top:14px">
获取方式：在已登录 chat.deepseek.com 的浏览器里执行
<code>JSON.parse(localStorage.getItem("userToken")).value</code>，
或在开发者工具 Network 里复制请求头 <code>authorization</code> 去掉 <code>Bearer </code>。
</div>
<label>Forvex 配置</label>
<pre>Base URL: http://127.0.0.1:${config.port}/v1
API Key:  任意值（如 sk-free）
模型:     deepseek-chat / deepseek-reasoner
路径:     /chat/completions（默认）</pre>
</div>
<script>
async function load(){
  const r=await fetch('/auth/status?check=1'); const j=await r.json();
  const el=document.getElementById('status');
  el.innerHTML = j.hasToken
    ? 'Token: <span class="ok">已配置（'+j.tokenLength+' 字符）</span>'+(j.user?' · 账号: '+j.user+'':'')
    : 'Token: <span class="bad">未配置</span>';
  if(j.lastError) el.innerHTML += '<br><span class="bad">最近错误: '+j.lastError+'</span>';
}
async function save(){
  const token=document.getElementById('token').value.trim();
  const cookie=document.getElementById('cookie').value.trim();
  const r=await fetch('/auth/token',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token,cookie})});
  const j=await r.json();
  alert(j.ok?('已保存'+(j.user?'，账号: '+j.user:'')):('失败: '+(j.error&&j.error.message||JSON.stringify(j))));
  load();
}
load();
</script></html>`;
}

// ---------- HTTP 服务 ----------
const server = http.createServer(async (req, res) => {
  res.on('error', e => { try { logLine({ event: 'res_error', code: e.code || '-' }); } catch (_) {} });
  req.on('error', e => { try { logLine({ event: 'req_error', code: e.code || '-' }); } catch (_) {} });
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const p = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
    return res.end();
  }

  try {
    if (req.method === 'GET' && p === '/logs') {
      const n = Number(url.searchParams.get('n') || 200);
      const text = RING.slice(-Math.max(1, Math.min(800, n))).join('\n') + '\n';
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(text);
    }
    if (req.method === 'GET' && (p === '/' )) {
      const html = authPage();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (req.method === 'GET' && p === '/health') {
      return json(res, 200, { ok: true, version: VERSION, hasToken: !!config.token, sessions: Object.keys(state.sessions).length, uptime: Math.floor(process.uptime()) });
    }
    if (req.method === 'GET' && p === '/auth/status') {
      refreshClient();
      const out = { hasToken: !!config.token, tokenLength: (config.token || '').length, clientOs: config.clientOs, lastError: client.lastHifError || null };
      if (url.searchParams.get('check') === '1' && config.token) {
        try {
          const u = await client.currentUser();
          out.user = u?.email || u?.mobile || u?.name || (u?.id ? 'id:' + u.id : 'ok');
        } catch (e) { out.lastError = e.message; out.tokenValid = false; }
      }
      return json(res, 200, out);
    }
    if (req.method === 'POST' && p === '/auth/token') {
      const remote = req.socket.remoteAddress || '';
      if (!/^(127\.|::1|::ffff:127\.)/.test(remote)) return errorJson(res, 403, '仅允许本机导入 Token');
      const body = await readBody(req);
      const token = String(body.token || '').replace(/^Bearer\s+/i, '').trim();
      if (!token) return errorJson(res, 400, 'token 不能为空');
      config.token = token;
      if (body.cookie !== undefined) config.cookie = String(body.cookie || '').trim();
      saveJson(CONFIG_PATH, config);
      refreshClient();
      state = { sessions: {} };
      saveJson(STATE_PATH, state);
      let user = null;
      try { const u = await client.currentUser(); user = u?.email || u?.mobile || (u?.id ? 'id:' + u.id : 'ok'); }
      catch (e) {
        return json(res, 400, { ok: false, error: { message: e.message, code: e.code || 'invalid_token' } });
      }
      logLine({ event: 'token_imported', user });
      return json(res, 200, { ok: true, user });
    }
    if (req.method === 'GET' && (p === '/v1/models' || p === '/models')) {
      const created = Math.floor(Date.now() / 1000);
      const models = ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v3', 'deepseek-r1'].map(id => ({ id, object: 'model', created, owned_by: 'deepseek' }));
      return json(res, 200, { object: 'list', data: models });
    }
    if (req.method === 'POST' && (p === '/v1/chat/completions' || p === '/chat/completions' || p === '/v1/v1/chat/completions')) {
      const body = await readBody(req);
      return handleChat(req, res, body).catch(e => {
        // 兜底：任何逃到这里的异常都必须给客户端一个响应，否则客户端会一直挂着
        try { logLine({ event: 'handle_crash', msg: e && e.message }); } catch (_) {}
        if (!res.headersSent) { try { errorJson(res, 500, '代理内部错误: ' + (e && e.message), 'proxy_crash'); } catch (_) {} }
        else { try { res.end(); } catch (_) {} }
      });
    }
    if (req.method === 'POST' && (p === '/v1/responses' || p === '/responses')) {
      return errorJson(res, 501, '本代理只实现了 Chat Completions。请在 Forvex 里关闭 “Use Responses API / 使用 Responses 接口”。', 'not_implemented');
    }
    return errorJson(res, 404, `未知路径: ${req.method} ${p}`);
  } catch (e) {
    if (!res.headersSent) return errorJson(res, 500, e.message);
    try { res.end(); } catch {}
  }
});

server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;

pruneSessions();
setInterval(() => { pruneSessions(); saveJson(STATE_PATH, state); }, 10 * 60 * 1000).unref();

server.listen(config.port, config.host, () => {
  console.log(`DeepSeek Free Proxy v${VERSION}`);
  console.log(`  监听: http://${config.host}:${config.port}`);
  console.log(`  Forvex Base URL: http://127.0.0.1:${config.port}/v1`);
  console.log(`  Token: ${config.token ? '已配置' : '未配置（打开 http://127.0.0.1:' + config.port + '/ 导入）'}`);
  console.log(`  身份: ${config.clientOs}`);
});

process.on('uncaughtException', e => { try { logLine({ event: 'uncaught', code: (e && e.code) || '-', msg: (e && e.message) || String(e) }); } catch (_) {} });
process.on('unhandledRejection', e => { try { logLine({ event: 'unhandled', msg: (e && e.message) || String(e) }); } catch (_) {} });

// ---------------------------------------------------------------------------
// 复用匹配
//
// stored = 上一轮已经推给上游的骨架哈希（按顺序）
// cur    = 这一轮客户端发来的骨架哈希
//
// 目标：找到「stored 的最长后缀」在 cur 里连续出现的那一段。
//   - 头部被客户端丢掉（窗口裁剪）        → 匹配落在 cur 头部（off=0），只发新增
//   - 头部被改写（连续消息合并 / 摘要压缩）→ 匹配落在 cur 中段（off>0），
//     此时前面那几条“被改写过的头”要一起回贴，否则用户的新指令会静默丢失
//   - 只要中间有一条被改写，旧版「已存尾部 == 本次头部」就会整段失配，
//     于是每次都退化成“新建会话 + 全量重传”，这才是 429 的真正来源
// ---------------------------------------------------------------------------
function findTailMatch(cur, stored, curIsTool, mode) {
  const n = cur.length, m = stored.length;
  if (!n || !m) return null;
  const lastHash = stored[m - 1];
  const anywhere = mode !== 'head';
  let best = null;
  for (let p = 0; p < n; p++) {
    if (cur[p] !== lastHash) continue;      // 只有和 stored 末位同哈希才可能是锚点结尾
    let len = 0;
    while (len < m && p - len >= 0 && stored[m - 1 - len] === cur[p - len]) len++;
    if (len < 2) continue;
    const off = p - len + 1;
    if (!anywhere && off !== 0) continue;
    // 锚点在头部时按旧行为放宽（>=2）；不在头部时要求更长。
    if (off === 0 ? len < 2 : len < 6) continue;
    // 命中区间里必须含一条真实 user 段：tool 段的哈希是常量 '[tool]'，
    // 成片的 tool 段能在不同对话之间凑出假匹配 → 会串话。
    let hasUser = false;
    for (let i = off; i <= p; i++) {
      if (curIsTool && curIsTool[i] === false) { hasUser = true; break; }
    }
    if (!hasUser) continue;
    if (!best || len > best.len || (len === best.len && p > best.end)) {
      best = { len, off, end: p };
    }
  }
  return best;
}

// 拼这一轮要发给上游的提示词：先回贴“被改写过的头”（如果有），再接真正的新增。
function buildReusePrompt(segments, match, prependMax) {
  const tail = [];
  for (let i = match.end + 1; i < segments.length; i++) tail.push(segments[i].text);
  let prefix = '';
  if (match.off > 0) {
    const head = [];
    for (let i = 0; i < match.off; i++) head.push(segments[i].text);
    prefix = head.join('\n\n');
    if (prefix.length > prependMax) prefix = prefix.slice(-prependMax);
  }
  let text = [prefix, tail.join('\n\n')].filter(Boolean).join('\n\n');
  if (!text) {
    // 客户端把同一份历史又发了一遍（重试）：只重发最后一条，别新建会话全量重传
    const last = segments[segments.length - 1];
    if (!last) return null;
    text = last.text;
  }
  return { text, prependChars: prefix.length };
}
