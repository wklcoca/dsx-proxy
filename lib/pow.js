'use strict';
// DeepSeek PoW (DeepSeekHashV1) 求解器
// 使用官方前端同一份 sha3 WASM，Node 内置 WebAssembly，无需第三方依赖。

const fs = require('fs');
const path = require('path');

let modulePromise = null;

async function loadWasmModule(opts = {}) {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    const { wasmPath, wasmUrl, cachePath } = opts;
    let bytes = null;
    for (const p of [wasmPath, cachePath]) {
      if (p && fs.existsSync(p)) { bytes = fs.readFileSync(p); break; }
    }
    if (!bytes) {
      if (!wasmUrl) throw new Error('缺少 wasmPath / wasmUrl');
      const resp = await fetch(wasmUrl, { signal: AbortSignal.timeout(20000) });
      if (!resp.ok) throw new Error(`下载 PoW WASM 失败: HTTP ${resp.status}`);
      bytes = Buffer.from(await resp.arrayBuffer());
      if (cachePath) {
        try { fs.mkdirSync(path.dirname(cachePath), { recursive: true }); fs.writeFileSync(cachePath, bytes); } catch {}
      }
    }
    return WebAssembly.compile(bytes);
  })();
  modulePromise.catch(() => { modulePromise = null; });
  return modulePromise;
}

function solveWithModule(mod, ch) {
  const inst = new WebAssembly.Instance(mod, { wbg: {} });
  const e = inst.exports;
  const enc = new TextEncoder();
  const prefix = `${ch.salt}_${ch.expire_at}_`;
  const cBytes = enc.encode(ch.challenge);
  const pBytes = enc.encode(prefix);

  const cp = e.__wbindgen_export_0(cBytes.length, 1) >>> 0;
  const pp = e.__wbindgen_export_0(pBytes.length, 1) >>> 0;
  new Uint8Array(e.memory.buffer, cp, cBytes.length).set(cBytes);
  new Uint8Array(e.memory.buffer, pp, pBytes.length).set(pBytes);

  const sp = e.__wbindgen_add_to_stack_pointer(-16);
  try {
    e.wasm_solve(sp, cp, cBytes.length, pp, pBytes.length, ch.difficulty);
    const dv = new DataView(e.memory.buffer);
    const code = dv.getInt32(sp, true);
    const answer = dv.getFloat64(sp + 8, true);
    if (code === 0 || !Number.isFinite(answer) || answer < 0) {
      throw new Error('PoW 无解（difficulty 过高或 challenge 非法）');
    }
    return Math.floor(answer);
  } finally {
    e.__wbindgen_add_to_stack_pointer(16);
  }
}

/**
 * @param {object} challenge create_pow_challenge 返回的 challenge 对象
 * @param {object} opts { wasmPath, wasmUrl, cachePath }
 * @returns {Promise<string>} base64(x-ds-pow-response)
 */
async function solveChallenge(challenge, opts = {}) {
  const mod = await loadWasmModule(opts);
  const answer = solveWithModule(mod, challenge);
  const payload = {
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: challenge.target_path,
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

module.exports = { solveChallenge, loadWasmModule };
