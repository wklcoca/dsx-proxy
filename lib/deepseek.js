'use strict';
// DeepSeek 官方客户端（网页端 / App 端共用 chat.deepseek.com/api/v0）
const crypto = require('crypto');
const { solveChallenge } = require('./pow');
const { CompletionStream, consumeSSE } = require('./sse');

class DeepSeekError extends Error {
  constructor(message, { status = 502, code = 'upstream_error', bizCode = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.bizCode = bizCode;
  }
}

const ANDROID_UA = 'DeepSeek/2.5.0 Android/35';
const WEB_UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

class DeepSeekClient {
  constructor(cfg = {}) {
    this.baseUrl = (cfg.baseUrl || 'https://chat.deepseek.com/api/v0').replace(/\/+$/, '');
    this.origin = cfg.origin || 'https://chat.deepseek.com';
    this.token = cfg.token || '';
    this.cookie = cfg.cookie || '';
    this.clientOs = cfg.clientOs === 'web' ? 'web' : 'android';
    this.deviceId = cfg.deviceId || crypto.randomUUID();
    this.locale = cfg.locale || 'zh_CN';
    this.timezoneOffset = String(cfg.timezoneOffset ?? 28800);
    this.hifUrl = cfg.hifUrl || 'https://hif-leim.deepseek.com/query';
    this.powOpts = {
      wasmPath: cfg.wasmPath,
      wasmUrl: cfg.wasmUrl || 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm',
      cachePath: cfg.wasmCachePath,
    };
    this.hif = '';
    this.hifExpireAt = 0;
    this.timeoutMs = cfg.timeoutMs || 300000;
  }

  setToken(token, cookie) {
    this.token = token || '';
    if (cookie !== undefined) this.cookie = cookie || '';
  }

  headers({ auth = true, pow = null, hif = false } = {}) {
    const h = {
      'accept': '*/*',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'content-type': 'application/json',
      'origin': this.origin,
      'referer': `${this.origin}/`,
      'x-client-locale': this.locale,
      'x-client-timezone-offset': this.timezoneOffset,
    };
    if (this.clientOs === 'android') {
      Object.assign(h, {
        'user-agent': ANDROID_UA,
        'x-client-platform': 'android',
        'x-client-version': '2.5.0',
        'x-app-version': '2.5.0',
        'x-client-bundle-id': 'com.deepseek.chat',
        'x-device-id': this.deviceId,
        'x-device-model': '',
      });
    } else {
      Object.assign(h, {
        'user-agent': WEB_UA,
        'x-client-platform': 'web',
        'x-client-version': '2.0.0',
        'x-app-version': '2.0.0',
      });
    }
    if (auth && this.token) h['authorization'] = `Bearer ${this.token}`;
    if (this.cookie) h['cookie'] = this.cookie;
    if (pow) h['x-ds-pow-response'] = pow;
    if (hif && this.hif) h['x-hif-leim'] = this.hif;
    return h;
  }

  _unwrap(json) {
    if (!json || typeof json !== 'object') throw new DeepSeekError('上游返回非 JSON');
    if (json.code !== 0 && json.code !== undefined) {
      if (json.code === 40003) throw new DeepSeekError('DeepSeek Token 已失效，请重新导入', { status: 401, code: 'invalid_token', bizCode: 40003 });
      if (json.code === 40002) throw new DeepSeekError('缺少 DeepSeek Token', { status: 401, code: 'missing_token', bizCode: 40002 });
      throw new DeepSeekError(json.msg || '上游返回错误', { status: 502, code: 'upstream_error', bizCode: json.code });
    }
    const data = json.data || {};
    if (data.biz_code && data.biz_code !== 0) {
      const msg = data.biz_msg || '上游业务错误';
      if (data.biz_code === 11) throw new DeepSeekError(`设备风控拦截（RISK_DEVICE_DETECTED）：${msg}`, { status: 403, code: 'risk_device', bizCode: 11 });
      if (data.biz_code === 10) throw new DeepSeekError('账号被封禁（USER_IS_BANNED）', { status: 403, code: 'user_banned', bizCode: 10 });
      throw new DeepSeekError(msg, { status: 502, code: 'biz_error', bizCode: data.biz_code });
    }
    return data.biz_data;
  }

  async post(pathname, body, { pow = null, hif = false, timeout = 60000 } = {}) {
    const url = `${this.baseUrl}${pathname}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: this.headers({ pow, hif }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    const text = await resp.text();
    let json;
    try { json = JSON.parse(text); } catch {
      throw new DeepSeekError(`上游返回非 JSON（HTTP ${resp.status}）: ${text.slice(0, 200)}`, { status: resp.status === 200 ? 502 : resp.status });
    }
    return this._unwrap(json);
  }

  async get(pathname, { timeout = 30000 } = {}) {
    const resp = await fetch(`${this.baseUrl}${pathname}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(timeout),
    });
    const text = await resp.text();
    let json;
    try { json = JSON.parse(text); } catch {
      throw new DeepSeekError(`上游返回非 JSON（HTTP ${resp.status}）: ${text.slice(0, 200)}`, { status: resp.status === 200 ? 502 : resp.status });
    }
    return this._unwrap(json);
  }

  async currentUser() {
    return this.get('/users/current');
  }

  async createSession() {
    const data = await this.post('/chat_session/create', {});
    const id = data?.chat_session?.id;
    if (!id) throw new DeepSeekError('创建 DeepSeek 会话失败：缺少 chat_session.id');
    return id;
  }

  /**
   * 上传图片到 DeepSeek 文件服务，返回 file_id（供 ref_file_ids 使用）。
   * 注意：headers() 里硬编码了 content-type: application/json，
   * 走 multipart 时必须删掉，否则 boundary 被覆盖，上游直接 400。
   */
  async uploadImage(buffer, filename = 'image.png', mime = 'image/png') {
    const target = '/api/v0/file/upload_file';
    const challenge = await this.createPow(target);
    const pow = await solveChallenge(challenge, this.powOpts);
    const fd = new FormData();
    fd.append('file', new Blob([buffer], { type: mime }), filename);
    const h = this.headers({ pow });
    delete h['content-type'];
    const resp = await fetch(this.baseUrl + '/file/upload_file', {
      method: 'POST',
      headers: h,
      body: fd,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await resp.text();
    let json;
    try { json = JSON.parse(text); } catch {
      throw new DeepSeekError('图片上传返回非 JSON（HTTP ' + resp.status + '）: ' + text.slice(0, 200), { status: resp.status });
    }
    const data = this._unwrap(json);
    const id = data && data.id;
    if (!id) throw new DeepSeekError('图片上传失败：缺少 file id');
    return { id, modelKind: data.model_kind || null, size: data.file_size || 0 };
  }

  /**
   * 轮询文件状态直到 SUCCESS。上传后立刻用会得到 invalid ref file id。
   */
  async waitFileReady(fileId, { timeoutMs = 60000, intervalMs = 1000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const data = await this.get('/file/fetch_files?file_ids=' + encodeURIComponent(fileId));
      const f = data && Array.isArray(data.files) ? data.files[0] : null;
      if (f) {
        if (f.status === 'SUCCESS') return f;
        if (f.status === 'FAILED' || f.error_code) {
          throw new DeepSeekError('文件处理失败: ' + (f.error_code || f.status), { status: 502 });
        }
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
    throw new DeepSeekError('文件处理超时（' + fileId + '）', { status: 504 });
  }

  async createPow(targetPath = '/api/v0/chat/completion') {
    const data = await this.post('/chat/create_pow_challenge', { target_path: targetPath });
    const ch = data?.challenge;
    if (!ch) throw new DeepSeekError('获取 PoW challenge 失败');
    if (!ch.target_path) ch.target_path = targetPath;
    return ch;
  }

  async getHif(force = false) {
    if (!force && this.hif && Date.now() < this.hifExpireAt) return this.hif;
    try {
      const resp = await fetch(this.hifUrl, {
        headers: this.headers({ auth: false }),
        signal: AbortSignal.timeout(15000),
      });
      const ttl = Number(resp.headers.get('x-hif-ttl') || 600);
      const json = await resp.json();
      const value = json?.data?.biz_data?.value;
      if (typeof value === 'string' && value) {
        this.hif = value;
        // 留 30 秒余量，避免边界过期
        this.hifExpireAt = Date.now() + Math.max(30, ttl - 30) * 1000;
        return this.hif;
      }
    } catch (e) {
      // HIF 获取失败不阻塞主流程，仅记录
      this.lastHifError = e.message;
    }
    return this.hif || '';
  }

  /**
   * 发起一次 completion（SSE），立即返回流对象与完成 Promise。
   * @returns {Promise<{stream: CompletionStream, done: Promise<CompletionStream>}>}
   */
  async startCompletion({ sessionId, parentMessageId = null, prompt, thinkingEnabled = false, modelType = 'default', searchEnabled = false, refFileIds = [], onDelta = () => {}, shouldStop = null }) {
    if (!this.token) throw new DeepSeekError('未配置 DeepSeek Token', { status: 401, code: 'missing_token' });

    const challenge = await this.createPow('/api/v0/chat/completion');
    const pow = await solveChallenge(challenge, this.powOpts);
    await this.getHif();

    const body = {
      chat_session_id: sessionId,
      parent_message_id: parentMessageId,
      model_type: modelType || 'default',
      prompt,
      ref_file_ids: Array.isArray(refFileIds) ? refFileIds : [],
      thinking_enabled: !!thinkingEnabled,
      search_enabled: !!searchEnabled,
      source: 'default',
      action: null,
      preempt: false,
    };

    const resp = await fetch(`${this.baseUrl}/chat/completion`, {
      method: 'POST',
      headers: this.headers({ pow, hif: true }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const ct = resp.headers.get('content-type') || '';
    if (!resp.ok || ct.includes('application/json')) {
      const text = await resp.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      if (json) this._unwrap(json);
      throw new DeepSeekError(`completion 失败 HTTP ${resp.status}: ${text.slice(0, 300)}`, { status: resp.status });
    }

    const cs = new CompletionStream(onDelta);
    const done = consumeSSE(resp, (ev, data) => {
      if (ev === 'hint') {
        try {
          const h = JSON.parse(data);
          if (h?.type === 'error') {
            cs.error = { message: h.content || '上游提示错误', finishReason: h.finish_reason || null };
          }
        } catch {}
        return;
      }
      cs.feedEvent(ev, data);
    }, shouldStop).then(() => {
      if (cs.error) {
        const fr = cs.error.finishReason || '';
        if (fr.includes('rate_limit')) throw new DeepSeekError(cs.error.message, { status: 429, code: 'rate_limit' });
        if (fr.includes('input_exceeds')) throw new DeepSeekError(cs.error.message, { status: 400, code: 'context_too_long' });
        throw new DeepSeekError(cs.error.message, { status: 502, code: 'upstream_hint' });
      }
      return cs;
    });

    return { stream: cs, done };
  }

  /** 便捷方法：等待整段完成 */
  async complete(args) {
    const { done } = await this.startCompletion(args);
    return done;
  }
}

module.exports = { DeepSeekClient, DeepSeekError };
