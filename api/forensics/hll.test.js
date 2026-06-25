"use strict";
const test = require("node:test");
const assert = require("node:assert");
const H = require("./hll.js");

test("HLL estimates distinct cardinality within ~3%", () => {
  const reg = H.create();
  const N = 50000;
  for (let i = 0; i < N; i++) H.add(reg, "0xwallet" + i);
  const est = H.estimate(reg);
  const err = Math.abs(est - N) / N;
  assert.ok(err < 0.03, "estimate " + est + " vs " + N + " (err " + (err * 100).toFixed(1) + "%)");
});

test("HLL ignores duplicates (adding the same 1000 keys 5× ≈ 1000)", () => {
  const reg = H.create();
  for (let r = 0; r < 5; r++) for (let i = 0; i < 1000; i++) H.add(reg, "addr" + i);
  const est = H.estimate(reg);
  assert.ok(Math.abs(est - 1000) / 1000 < 0.05, "estimate " + est + " ≈ 1000");
});

test("HLL survives a base64 round-trip (state.json persistence)", () => {
  const reg = H.create();
  for (let i = 0; i < 2000; i++) H.add(reg, "w" + i);
  const back = H.fromB64(H.toB64(reg));
  assert.equal(H.estimate(back), H.estimate(reg));
});

test("empty sketch estimates ~0", () => {
  assert.ok(H.estimate(H.create()) <= 1);
});
