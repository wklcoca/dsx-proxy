'use strict';
// 重复输出守卫：模型偶尔会陷入复读 —— 同一段话、同一行、甚至同一个字一遍遍往外吐，
// 一口气几万字。等它生成完再判断已经太晚：用户已经看了几万字垃圾，token 也烧掉了。
// 这里在流式过程中按「尾部周期重复」判定，命中就立刻让上层停止读取上游。
//
// 判据只有一条：结尾处有一小段文本，连续原样重复了很多次，且重复总量足够大。
// 不做通用压缩/相似度判断 —— 那样一定会误伤正常的长列表、表格和排比句。

const DEFAULT_OPTIONS = {
  // 只看尾部这么多字符：复读一定发生在结尾
  windowChars: 4000,
  // 允许的最长重复单元（一句话、一行、一个表格行）
  maxPeriod: 200,
  // 至少连续重复多少次
  minRepeats: 6,
  // 重复的总长度至少这么多字符才判（正常文本几乎不可能原样重复 800 字）
  minRunChars: 800,
};

/**
 * 在 text 的尾部寻找周期重复。
 * @returns {{period:number, repeats:number, chars:number}|null}
 */
function findRunawayRepetition(text, options) {
  const opts = Object.assign({}, DEFAULT_OPTIONS, options || {});
  const s = String(text == null ? '' : text);
  const window = s.slice(-opts.windowChars);

  for (let period = 1; period <= opts.maxPeriod; period += 1) {
    // 连这个周期都凑不出最小重复次数，更长的周期也不可能
    if (period * opts.minRepeats > window.length) break;

    const unit = window.slice(-period);
    if (!unit) continue;

    let repeats = 1;
    let at = window.length - period * 2;
    while (at >= 0 && window.slice(at, at + period) === unit) {
      repeats += 1;
      at -= period;
    }
    if (repeats < opts.minRepeats) continue;

    const chars = period * repeats;
    if (chars < opts.minRunChars) continue;
    return { period, repeats, chars, unit };
  }
  return null;
}

// 流式用的增量检查：每累积一段新内容才判一次，避免每个 delta 都做全量扫描。
class RunawayGuard {
  constructor(options) {
    this.options = Object.assign({}, DEFAULT_OPTIONS, options || {});
    // 每多出这么多字符才判一次
    this.stepChars = this.options.stepChars || 200;
    this.hit = null;
    this.lastCheckedLength = 0;
  }

  /** 传入累积文本；命中后一直返回同一个结果。 */
  check(text) {
    if (this.hit) return this.hit;
    const s = String(text == null ? '' : text);
    if (s.length - this.lastCheckedLength < this.stepChars) return null;
    this.lastCheckedLength = s.length;
    this.hit = findRunawayRepetition(s, this.options);
    return this.hit;
  }
}

module.exports = { findRunawayRepetition, RunawayGuard, DEFAULT_OPTIONS };
