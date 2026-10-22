'use strict';
// DeepSeek /api/v0/chat/completion 的 SSE 增量解析器
// 官方格式是 "路径 + 操作符" 的补丁流（p / o / v），也兼容早期 response/content。

function isObj(v) { return v !== null && typeof v === 'object'; }

class CompletionStream {
  constructor(onDelta) {
    this.onDelta = onDelta || (() => {});
    this.fragments = [];      // [{type:'THINK'|'RESPONSE'|'SEARCH'|..., content}]
    this.emitted = [];        // 每个 fragment 已向客户端发出的字符数
    this.lastPath = '';
    this.lastOp = 'SET';
    this.messageId = null;
    this.requestMessageId = null;
    this.status = '';
    this.quasiStatus = '';
    this.usageTokens = 0;
    this.error = null;
    this.finishReason = null;
    this.legacyContent = '';
    this.legacyThinking = '';
    this.rawEvent = '';
  }

  _fragIndex(p) {
    const m = /^response\/fragments\/(\d+)/.exec(p || '');
    if (m) {
      const i = Number(m[1]);
      return i < 0 ? this.fragments.length - 1 : i;
    }
    return this.fragments.length - 1;
  }

  _emitFragment(i, text, type) {
    if (!text) return;
    const kind = (type || 'RESPONSE').toUpperCase();
    if (kind === 'THINK') this.onDelta({ type: 'think', text });
    else if (kind === 'SEARCH' || kind === 'TOOL_SEARCH' || kind === 'TOOL_OPEN') this.onDelta({ type: 'search', text });
    else this.onDelta({ type: 'content', text });
  }

  _appendContent(i, text) {
    if (i < 0 || i >= this.fragments.length) return;
    const frag = this.fragments[i];
    const prev = typeof frag.content === 'string' ? frag.content : '';
    const next = prev + text;
    frag.content = next;
    const already = this.emitted[i] || 0;
    if (next.length > already) {
      this.emitted[i] = next.length;
      this._emitFragment(i, next.slice(already), frag.type);
    }
  }

  _setContent(i, text) {
    if (i < 0 || i >= this.fragments.length) return;
    const frag = this.fragments[i];
    const prev = typeof frag.content === 'string' ? frag.content : '';
    frag.content = text;
    const already = this.emitted[i] || 0;
    if (text.length > already) {
      this.emitted[i] = text.length;
      this._emitFragment(i, text.slice(already), frag.type);
    }
  }

  _pushFragment(f) {
    if (!isObj(f)) return;
    this.fragments.push({ ...f, content: typeof f.content === 'string' ? f.content : '' });
    this.emitted.push(0);
  }

  _snapshot(resp) {
    this.fragments = [];
    this.emitted = [];
    if (isObj(resp)) {
      if (resp.message_id != null) this.messageId = resp.message_id;
      if (Array.isArray(resp.fragments)) {
        for (const f of resp.fragments) this._pushFragment(f);
      }
    }
    // 快照是初始状态，内容通常为空；不重复发给客户端，避免重复输出。
  }

  _apply(d) {
    if (!isObj(d)) return;

    // hint / error
    if (d.type === 'error' && typeof d.content === 'string') {
      this.error = { message: d.content, finishReason: d.finish_reason || null };
      return;
    }

    // 完整快照 {"v":{"response":{...}}}
    if (isObj(d.v) && isObj(d.v.response)) {
      this._snapshot(d.v.response);
      return;
    }

    if (typeof d.p === 'string') this.lastPath = d.p;
    if (typeof d.o === 'string') this.lastOp = d.o;

    // BATCH：v 是子补丁数组
    if (d.o === 'BATCH' && Array.isArray(d.v)) {
      for (const item of d.v) this._apply(item);
      return;
    }

    const p = this.lastPath || '';
    const v = d.v;

    if (typeof v === 'string') {
      if (p.endsWith('/content')) this._appendContent(this._fragIndex(p), v);
      else if (p === 'response/content' || p === '') this._appendLegacy(v);
      else if (p === 'response/thinking_content') this._appendThinking(v);
      return;
    }

    if (v === undefined) return;

    if (p === 'response/status' || p === 'response/quasi_status') {
      if (p.endsWith('quasi_status')) this.quasiStatus = String(v);
      else this.status = String(v);
      return;
    }

    if (p === 'response/accumulated_token_usage') {
      if (typeof v === 'number') this.usageTokens = v;
      return;
    }

    // fragments 整体追加/替换
    if (p === 'response/fragments') {
      if (Array.isArray(v)) {
        if (this.lastOp === 'APPEND') { for (const f of v) this._pushFragment(f); }
        else { this.fragments = []; this.emitted = []; for (const f of v) this._pushFragment(f); }
      } else if (isObj(v)) {
        this._pushFragment(v);
      }
      return;
    }

    // 单个 fragment
    const fm = /^response\/fragments\/(-?\d+)(?:\/(.+))?$/.exec(p);
    if (fm) {
      const idx = Number(fm[1]) < 0 ? this.fragments.length - 1 : Number(fm[1]);
      const sub = fm[2] || '';
      if (!sub) {
        if (isObj(v)) {
          if (this.lastOp === 'APPEND' || idx < 0) this._pushFragment(v);
          else this.fragments[idx] = { ...v, content: v.content || '' };
        }
        return;
      }
      if (sub === 'content') {
        if (typeof v === 'string') this._appendContent(idx, v);
      } else if (sub === 'type') {
        if (this.fragments[idx]) this.fragments[idx].type = v;
      }
      return;
    }

    // 某些版本直接给 {"v":"..."} 续写上一路径
    if (typeof v === 'string' && !p) this._appendLegacy(v);
  }

  _appendLegacy(text) {
    // 无路径的纯文本：优先追加到最后一个 RESPONSE fragment；没有则进入 legacy 缓冲
    for (let i = this.fragments.length - 1; i >= 0; i--) {
      const t = (this.fragments[i].type || '').toUpperCase();
      if (t === 'RESPONSE' || t === 'SEARCH') { this._appendContent(i, text); return; }
    }
    this.legacyContent += text;
    this.onDelta({ type: 'content', text });
  }

  _appendThinking(text) {
    for (let i = this.fragments.length - 1; i >= 0; i--) {
      if ((this.fragments[i].type || '').toUpperCase() === 'THINK') { this._appendContent(i, text); return; }
    }
    this.legacyThinking += text;
    this.onDelta({ type: 'think', text });
  }

  feedEvent(eventName, dataText) {
    let d;
    try { d = JSON.parse(dataText); } catch { return; }
    this.rawEvent = eventName || '';
    if (eventName === 'ready') {
      if (d.request_message_id != null) this.requestMessageId = d.request_message_id;
      if (d.response_message_id != null) this.messageId = d.response_message_id;
      return;
    }
    this._apply(d);
  }

  get content() {
    const s = this.fragments
      .filter(f => ['RESPONSE', 'SEARCH'].includes((f.type || '').toUpperCase()))
      .map(f => f.content || '').join('');
    return s || this.legacyContent;
  }

  get thinking() {
    const s = this.fragments
      .filter(f => (f.type || '').toUpperCase() === 'THINK')
      .map(f => f.content || '').join('');
    return s || this.legacyThinking;
  }

  get done() {
    return this.status === 'FINISHED' || this.quasiStatus === 'FINISHED';
  }
}

/** 逐行读取 SSE 流（fetch Response.body） */
async function consumeSSE(resp, onEvent) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let eventName = '';
  let dataLines = [];

  const flush = () => {
    if (!dataLines.length) { eventName = ''; return; }
    const data = dataLines.join('\n');
    dataLines = [];
    const name = eventName;
    eventName = '';
    if (data.trim() === '[DONE]') return;
    try { onEvent(name, data); } catch (e) { /* 单个事件解析失败不影响后续 */ }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      const line = raw.replace(/\r$/, '');
      if (line === '') { flush(); continue; }
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) { eventName = line.slice(6).trim(); continue; }
      if (line.startsWith('data:')) { dataLines.push(line.slice(5).trimStart()); continue; }
    }
  }
  buf += decoder.decode();
  if (buf.trim()) {
    const line = buf.replace(/\r$/, '');
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  flush();
}

module.exports = { CompletionStream, consumeSSE };
