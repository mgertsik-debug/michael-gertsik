/* ============================================================================
 *  forensics/hll.js — tiny HyperLogLog for an HONEST all-time distinct count.
 *  ---------------------------------------------------------------------------
 *  The funnel shows two real numbers: the wide "observed" universe (every
 *  distinct wallet seen across all sweeps) and the narrower "scored" set. Storing
 *  every address would bloat the committed state, so we estimate cardinality with
 *  a fixed ~4 KB sketch (p=12 → 4096 registers, ~1.6% standard error). Pure, no
 *  deps. Serialised to base64 so it rides in state.json.
 * ========================================================================== */
"use strict";

const P = 12;
const M = 1 << P;                       // 4096 registers
const BITS = 32 - P;

// FNV-1a 32-bit — fast, well-distributed enough for cardinality estimation.
function hash(str) {
  let h = 0x811c9dc5;
  str = String(str);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

function create() { return new Uint8Array(M); }

function add(reg, value) {
  const x = hash(value);
  const idx = x & (M - 1);
  const w = x >>> P;                    // remaining BITS bits
  let lz = 0;
  for (let b = BITS - 1; b >= 0; b--) { if (w & (1 << b)) break; lz++; }
  const rank = lz + 1;                  // position of the leftmost 1 (+1)
  if (rank > reg[idx]) reg[idx] = rank;
}

function estimate(reg) {
  let sum = 0, zeros = 0;
  for (let i = 0; i < M; i++) { sum += 1 / (1 << reg[i]); if (reg[i] === 0) zeros++; }
  const alpha = 0.7213 / (1 + 1.079 / M);
  let E = (alpha * M * M) / sum;
  if (E <= 2.5 * M && zeros > 0) E = M * Math.log(M / zeros);     // small-range correction
  return Math.round(E);
}

function toB64(reg) { return Buffer.from(reg).toString("base64"); }
function fromB64(s) {
  const reg = create();
  try { const b = Buffer.from(String(s || ""), "base64"); reg.set(b.subarray(0, M)); } catch (_) {}
  return reg;
}

module.exports = { create, add, estimate, toB64, fromB64, hash, P, M };
