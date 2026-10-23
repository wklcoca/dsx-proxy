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

  // 把某个 fragment 里「还没发过」的内容补发出去
  _emitFresh(i) {
    const frag = this.fragments[i];
    const text = frag && typeof frag.content === 'string' ? frag.content : '';
    if (!text) return;
    const already = this.emitted[i] || 0;
    if (text.length > already) {
      this.emitted[i] = text.length;
      this._emitFragment(i, text.slice(already), frag.type);
    }
  }

  _snapshot(resp) {
    const prevFrags = this.fragments;
    const prevEmitted = this.emitted;
    this.fragments = [];
    this.emitted = [];
    if (!isObj(resp)) return;
    if (resp.message_id != null) this.messageId = resp.message_id;
    if (Array.isArray(resp.fragments)) {
      for (const f of resp.fragments) this._pushFragment(f);
    }
    // 快照常常就是整段回答的唯一载体：短回答上游只发一份快照就 FINISHED，
    // 一个增量 patch 都没有（真实事故：content 有值，客户端却收到空正文）。
    // 断线重连时快照会重发已经发过的内容，所以只补「还没发过的尾巴」，
    // 不能整段重发，否则客户端会把同一句话看两遍。
    for (let i = 0; i < this.fragments.length; i++) {
      const frag = this.fragments[i];
      const text = typeof frag.content === 'string' ? frag.content : '';
      if (!text) continue;
      const before = typeof prevEmitted[i] === 'number' ? prevEmitted[i] : 0;
      const prevText = prevFrags[i] && typeof prevFrags[i].content === 'string' ? prevFrags[i].content : '';
      const already = prevText.slice(0, before);
      const tail = already && text.startsWith(already) ? text.slice(already.length) : text;
      this.emitted[i] = text.length;
      if (tail) this._emitFragment(i, tail, frag.type);
    }
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

    // BATCH：v 是子补丁数组，子补丁里的 p 是相对父路径的
    // （{"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":38}]}）。
    // 以前把子补丁原样丢给 _apply，'accumulated_token_usage' 永远拼不上 'response/' 前缀，
    // 于是上游上报的真实 token 用量和 quasi_status 全被丢掉。
    if (d.o === 'BATCH' && Array.isArray(d.v)) {
      const base = String(d.p || '').replace(/\/+$/, '');
      for (const item of d.v) {
        if (!isObj(item)) continue;
        if (base && typeof item.p === 'string' && !item.p.startsWith('response')) {
          this._apply({ ...item, p: `${base}/${item.p}` });
        } else {
          this._apply(item);
        }
      }
      return;
    }

    const p = this.lastPath || '';
    const v = d.v;

    // status / quasi_status / 用量 的值是字符串或数字，必须排在「字符串按正文处理」之前，
    // 否则会先被下面的 string 分支吞掉，cs.done 永远是 false。
    if (p === 'response/status' || p === 'response/quasi_status') {
      if (p.endsWith('quasi_status')) this.quasiStatus = String(v);
      else this.status = String(v);
      return;
    }

    if (p === 'response/accumulated_token_usage') {
      if (typeof v === 'number') this.usageTokens = v;
      return;
    }

    if (typeof v === 'string') {
      if (p.endsWith('/content')) this._appendContent(this._fragIndex(p), v);
      else if (p === 'response/content' || p === '') this._appendLegacy(v);
      else if (p === 'response/thinking_content') this._appendThinking(v);
      return;
    }

    if (v === undefined) return;

    // fragments 整体追加/替换。SET 语义和快照一样会整体换掉片段列表，
    // 所以走 _snapshot 才能把新内容补发出去（否则同样会静默丢正文）。
    if (p === 'response/fragments') {
      if (Array.isArray(v)) {
        if (this.lastOp === 'APPEND') { for (const f of v) this._pushFragment(f); }
        else this._snapshot({ message_id: this.messageId, fragments: v });
      } else if (isObj(v)) {
        this._pushFragment(v);
        this._emitFresh(this.fragments.length - 1);
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
          if (this.lastOp === 'APPEND' || idx < 0) {
            this._pushFragment(v);
          } else if (this.fragments[idx]) {
            // SET 是覆盖语义：字段逐个合并，但 content 必须走 _setContent，
            // 否则正文进了 fragments 却一个 delta 都没发出去。
            // 真实事故：短回答上游只发一次 {"p":"response/fragments/0","o":"SET","v":{"content":"通了"}}，
            // 旧代码这里直接替换 fragment，日志记到 content=2、客户端收到空正文。
            const frag = this.fragments[idx];
            for (const k of Object.keys(v)) if (k !== 'content') frag[k] = v[k];
            if (typeof v.content === 'string') this._setContent(idx, v.content);
          } else {
            this._pushFragment(v);
          }
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
async function consumeSSE(resp, onEvent, shouldStop) {
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
    // 上层要提前收手（例如发现模型在复读）时，取消读取即可中断这次上游请求，
    // 而不是等它把几万字吐完。
    if (typeof shouldStop === 'function' && shouldStop()) {
      try { await reader.cancel(); } catch (_) {}
      return;
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
