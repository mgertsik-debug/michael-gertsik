/* ============================================================================
 *  forensics/chain.js — Polygon on-chain layer for the wallet-forensics job.
 *  ---------------------------------------------------------------------------
 *  Polymarket settles in USDC.e on Polygon. The funding trace behind each
 *  proxy wallet is what powers three detectors the Data API alone can't feed:
 *    • fresh   — funding block → first-bet block (wallet age) + prior_tx = 0
 *    • cluster — shared funder address across wallets (Meiklejohn linkage)
 *    • conceal — rapid post-resolution cash-out to an exchange deposit address
 *
 *  Two backends, picked at runtime, both behind one interface:
 *    1. Etherscan v2 multichain API (chainid=137) when POLYGONSCAN_API_KEY /
 *       ETHERSCAN_API_KEY is set — reliable full ERC-20 history with timestamps.
 *    2. Public JSON-RPC (POLYGON_RPC, default https://polygon-rpc.com) via
 *       eth_getLogs over a bounded window — keyless fallback.
 *
 *  HONESTY: every call is guarded and returns null / hasData-style emptiness on
 *  failure or when a public RPC caps the range. A missing funding trace means
 *  the fresh / conceal / cluster-funder inputs are EXCLUDED, never fabricated.
 *  We never invent a funder, an exchange label, or a timestamp.
 * ========================================================================== */
"use strict";

const USDC = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";              // USDC.e on Polygon
const USDC_NATIVE = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";       // native USDC on Polygon
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
// Keyless public Polygon RPCs. Free nodes rate-limit and cap getLogs ranges, so we
// ROTATE across several reliable ones — if one 429s or caps, the next answers. A
// configured POLYGON_RPC (or a Polygonscan key, preferred) takes priority.
const RPCS = (process.env.POLYGON_RPC ? [process.env.POLYGON_RPC] : []).concat([
  "https://polygon-bor-rpc.publicnode.com",
  "https://polygon.llamarpc.com",
  "https://1rpc.io/matic",
  "https://polygon-rpc.com",
  "https://rpc.ankr.com/polygon",
]);
const RPC = RPCS[0];
const SCAN_KEY = process.env.POLYGONSCAN_API_KEY || process.env.ETHERSCAN_API_KEY || "";
const SCAN_BASE = "https://api.etherscan.io/v2/api?chainid=137";

const num = (x) => { const n = Number(x); return isFinite(n) ? n : 0; };
const lc = (a) => String(a || "").toLowerCase();

/* Known Polygon exchange withdrawal/hot wallets. ONLY these get an exchange
 * label; any other funder is shown as its raw address (never guessed). This set
 * is deliberately small and conservative — wrong labels are worse than none. */
const EXCHANGE_LABELS = {
  "0xe7804c37c13166ff0b37f5ae0bb07a3aebb6e245": "Binance",
  "0xf977814e90da44bfa03b6295a0616a897441acec": "Binance",
  "0x290275e3db66394c52272398959845170e4dcb88": "Binance",
  "0x9696f59e4d72e237be84ffd425dcad154bf96976": "Binance",
  "0x0d0707963952f2fba59dd06f2b425ace40b492fe": "Gate.io",
  "0x1fbe9c1f93b0bc81934b2b41e2bd0e0a09b7d391": "Bybit",
  "0xf89d7b9c864f589bbf53a82105107622b35eaa40": "Bybit",
  "0x8894e0a0c962cb723c1976a4421c95949be2d4e3": "Bybit",
  "0x4b4e14a3773ee558b6597070797fd51eb48606e5": "OKX",
  "0x06959153b974d0d5fdfd87d561db6d8d4fa0bb0b": "OKX",
  "0xa910f92acdaf488fa6ef02174fb86208ad7722ba": "Kraken",
  "0x267be1c1d684f78cb4f6a176c4911b741e4ffdc0": "Kraken",
  "0x46340b20830761efd32832a74d7169b29feb9758": "Crypto.com",
  "0xe93685f3bba03016f02bd1828badd6195988d950": "Crypto.com",
};
function exchangeLabel(addr) { return EXCHANGE_LABELS[lc(addr)] || null; }

/* ----------------------------------------------------------------- fetch -- */
function withTimeout(ms) { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); return { signal: c.signal, done: () => clearTimeout(t) }; }
async function getJSON(url, opts) {
  const to = withTimeout((opts && opts.timeout) || 9000);
  try {
    const r = await fetch(url, { method: (opts && opts.method) || "GET", headers: (opts && opts.headers) || {}, body: opts && opts.body, signal: to.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { to.done(); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------- pure helpers -- */
const padAddr = (a) => "0x000000000000000000000000" + lc(a).replace(/^0x/, "");
const unpadAddr = (topic) => "0x" + String(topic || "").slice(-40);
const hexToNum = (h) => { try { return parseInt(h, 16); } catch (_) { return 0; } }
const usdcAmount = (hexData) => { try { return parseInt(hexData, 16) / 1e6; } catch (_) { return 0; } };

/* ------------------------------------------------- Etherscan v2 (preferred) */
async function scanTokenTx(wallet) {
  if (!SCAN_KEY) return null;
  const url = SCAN_BASE + "&module=account&action=tokentx&address=" + wallet +
    "&page=1&offset=300&sort=asc&apikey=" + SCAN_KEY;
  const d = await getJSON(url, { timeout: 9000 }).catch(() => null);
  if (!d || d.status === "0" || !Array.isArray(d.result)) return null;
  return d.result
    .filter((t) => lc(t.contractAddress) === USDC || lc(t.contractAddress) === USDC_NATIVE)
    .map((t) => ({ from: lc(t.from), to: lc(t.to), value: num(t.value) / Math.pow(10, num(t.tokenDecimal) || 6), ts: num(t.timeStamp), block: num(t.blockNumber), hash: t.hash }));
}
async function scanTxCount(wallet, beforeTs) {
  if (!SCAN_KEY) return null;
  const url = SCAN_BASE + "&module=account&action=txlist&address=" + wallet +
    "&startblock=0&endblock=99999999&page=1&offset=50&sort=asc&apikey=" + SCAN_KEY;
  const d = await getJSON(url, { timeout: 9000 }).catch(() => null);
  if (!d || !Array.isArray(d.result)) return null;
  const before = d.result.filter((t) => !beforeTs || num(t.timeStamp) < beforeTs && lc(t.from) === lc(wallet));
  return before.length;
}

/* ----------------------------------------------------- JSON-RPC fallback -- */
let _rpcId = 1;
let _rpcGood = 0;                                         // remember the endpoint that last worked
async function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: _rpcId++, method, params });
  for (let i = 0; i < RPCS.length; i++) {
    const url = RPCS[(_rpcGood + i) % RPCS.length];
    const d = await getJSON(url, { method: "POST", headers: { "content-type": "application/json" }, body, timeout: 9000 }).catch(() => null);
    if (d && !d.error && d.result !== undefined) { _rpcGood = (_rpcGood + i) % RPCS.length; return d.result; }
  }
  return null;                                            // all endpoints failed → caller excludes the input
}
async function latestBlock() { const r = await rpc("eth_blockNumber", []); return r ? hexToNum(r) : null; }
async function blockTime(block) {
  const r = await rpc("eth_getBlockByNumber", ["0x" + Number(block).toString(16), false]);
  return r && r.timestamp ? hexToNum(r.timestamp) : null;
}
// Polygon mints a block ~every 2.1s. Estimate the block at a unix timestamp from
// the chain head so the keyless RPC path can window getLogs without a block index.
const POLY_BLOCK_SECS = 2.1;
async function estimateBlock(ts) {
  const head = await latestBlock(); if (!head) return null;
  const headTs = await blockTime(head); if (!headTs) return null;
  return Math.max(1, Math.round(head - (headTs - ts) / POLY_BLOCK_SECS));
}
// inbound USDC transfers to `wallet` within [fromBlock,toBlock]. Public RPCs cap
// ranges/result size; on failure we return null so the caller excludes the input.
async function inboundLogs(wallet, fromBlock, toBlock) {
  const params = [{
    fromBlock: "0x" + Number(Math.max(0, fromBlock)).toString(16),
    toBlock: toBlock ? "0x" + Number(toBlock).toString(16) : "latest",
    address: [USDC, USDC_NATIVE],
    topics: [TRANSFER_TOPIC, null, padAddr(wallet)],
  }];
  const r = await rpc("eth_getLogs", params);
  if (!Array.isArray(r)) return null;
  return r.map((l) => ({ from: unpadAddr(l.topics[1]), to: unpadAddr(l.topics[2]), value: usdcAmount(l.data), block: hexToNum(l.blockNumber), hash: l.transactionHash }));
}

/* ============================================================================
 *  PUBLIC INTERFACE — all guarded, all degrade to null.
 * ========================================================================== */

// Earliest USDC funding of a proxy wallet: { funder, block, ts, label, inboundCount }.
// firstBetTs bounds the RPC window so a public node isn't asked for full history.
async function walletFunding(wallet, firstBetTs, firstBetBlock) {
  if (!wallet) return null;
  // 1. preferred: full token history with timestamps
  const hist = await scanTokenTx(wallet).catch(() => null);
  if (hist && hist.length) {
    const inbound = hist.filter((t) => t.to === lc(wallet) && t.value > 0).sort((a, b) => a.ts - b.ts);
    if (inbound.length) {
      const f = inbound[0];
      return { funder: f.from, block: f.block, ts: f.ts, label: exchangeLabel(f.from), inboundCount: inbound.length, source: "etherscan" };
    }
  }
  // 2. fallback: keyless public RPC. Estimate the first-bet block from its
  // timestamp, then sweep ~14 days of inbound USDC in chunks (public nodes cap
  // getLogs ranges), returning the EARLIEST inbound transfer found.
  let endBlock = firstBetBlock;
  if (!endBlock && firstBetTs) endBlock = await estimateBlock(firstBetTs).catch(() => null);
  if (endBlock) {
    const WINDOW = 600000;                                  // ~14d of Polygon blocks
    const CHUNK = 90000;                                    // conservative getLogs range for public nodes
    for (let from = Math.max(1, endBlock - WINDOW); from <= endBlock; from += CHUNK) {
      const to = Math.min(endBlock, from + CHUNK - 1);
      const logs = await inboundLogs(wallet, from, to).catch(() => null);
      if (logs && logs.length) {
        const first = logs.slice().sort((a, b) => a.block - b.block)[0];
        const ts = await blockTime(first.block).catch(() => null);
        return { funder: first.from, block: first.block, ts, label: exchangeLabel(first.from), inboundCount: logs.length, source: "rpc" };
      }
    }
  }
  return null;
}

// prior on-chain tx count for the wallet before its first bet (0 ⇒ purpose-built).
// Etherscan when keyed; otherwise the keyless nonce at the estimated first-bet
// block via eth_getTransactionCount (outbound tx count = sender nonce).
async function priorTxCount(wallet, firstBetTs) {
  const c = await scanTxCount(wallet, firstBetTs).catch(() => null);
  if (c != null) return c;
  if (!firstBetTs) return null;
  const blk = await estimateBlock(firstBetTs).catch(() => null);
  if (!blk) return null;
  const r = await rpc("eth_getTransactionCount", [lc(wallet), "0x" + Number(Math.max(1, blk - 1)).toString(16)]).catch(() => null);
  return r == null ? null : hexToNum(r);
}

// outbound USDC after `sinceTs` (post-resolution cash-out). Returns the fastest
// transfer to a known exchange: { ts, to, label, latencyHours } or null.
async function cashoutAfter(wallet, sinceTs) {
  const hist = await scanTokenTx(wallet).catch(() => null);
  if (!hist || !hist.length || !sinceTs) return null;
  const out = hist.filter((t) => t.from === lc(wallet) && t.ts >= sinceTs && t.value > 0)
    .map((t) => ({ ts: t.ts, to: t.to, label: exchangeLabel(t.to) }))
    .sort((a, b) => a.ts - b.ts);
  const toCex = out.find((t) => t.label) || out[0] || null;
  if (!toCex) return null;
  return { ts: toCex.ts, to: toCex.to, label: toCex.label, latencyHours: +((toCex.ts - sinceTs) / 3600).toFixed(1) };
}

// FUND-FLOW NETWORK — the Bubblemaps-style ring tracer, but scored. From a subject
// wallet we (1) find who funded it (inbound USDC), (2) for each funder expand to
// EVERY OTHER wallet that funder also seeded (the ring), and (3) flag the common
// funder as the HUB. A single funder seeding many fresh wallets that each won the
// same surprise is the coordinated-insider / drainer signature (Iran ring, the
// $3M frontend hack). Needs the scan key (the keyless RPC can't walk the tx graph).
async function fundingNetwork(wallet, opts) {
  const o = Object.assign({ maxFunders: 3, maxSiblings: 30, minSeed: 1 }, opts);
  if (!SCAN_KEY) return { error: "needs POLYGONSCAN_API_KEY", nodes: [], edges: [] };
  const subj = lc(wallet);
  const txs = await scanTokenTx(subj);
  if (!txs) return { error: "no transfer history", nodes: [], edges: [] };
  const inbound = txs.filter((t) => t.to === subj && t.from !== subj && t.value > 0);
  const funderTotal = {}, funderFirst = {};
  for (const t of inbound) { funderTotal[t.from] = (funderTotal[t.from] || 0) + t.value; if (funderFirst[t.from] == null || t.ts < funderFirst[t.from]) funderFirst[t.from] = t.ts; }
  const funders = Object.keys(funderTotal).sort((a, b) => funderTotal[b] - funderTotal[a]).slice(0, o.maxFunders);

  const nodes = {}; const edges = [];
  const add = (a, role) => { const k = lc(a); const ex = exchangeLabel(k); const r = ex ? "exchange" : role; if (!nodes[k]) nodes[k] = { addr: k, role: r, label: ex || null }; return nodes[k]; };
  add(subj, "subject");
  let hub = null, hubSeeded = -1;
  for (const f of funders) {
    add(f, "funder");
    edges.push({ from: f, to: subj, value: Math.round(funderTotal[f]), ts: funderFirst[f] });
    if (exchangeLabel(f)) continue;                          // a CEX hot wallet isn't a "ring hub"
    const ftx = await scanTokenTx(f).catch(() => null);
    if (!ftx) continue;
    const out = ftx.filter((t) => t.from === lc(f) && t.to !== lc(f) && t.value > 0);
    const seededTotal = {}, seededFirst = {};
    for (const t of out) { seededTotal[t.to] = (seededTotal[t.to] || 0) + t.value; if (seededFirst[t.to] == null || t.ts < seededFirst[t.to]) seededFirst[t.to] = t.ts; }
    const seeded = Object.keys(seededTotal).filter((a) => a !== subj && !exchangeLabel(a));
    if (seeded.length > hubSeeded) { hubSeeded = seeded.length; hub = lc(f); }
    seeded.sort((a, b) => seededTotal[b] - seededTotal[a]).slice(0, o.maxSiblings).forEach((s) => {
      add(s, "sibling");
      edges.push({ from: lc(f), to: s, value: Math.round(seededTotal[s]), ts: seededFirst[s] });
    });
  }
  if (hub && nodes[hub]) nodes[hub].role = "hub";
  return { subject: subj, hub, funders, nodes: Object.values(nodes), edges, ringSize: hubSeeded >= 0 ? hubSeeded + 1 : 1 };
}

module.exports = {
  walletFunding, priorTxCount, cashoutAfter, exchangeLabel, fundingNetwork, scanTokenTx,
  // exposed for tests / reuse
  padAddr, unpadAddr, usdcAmount, hexToNum, EXCHANGE_LABELS, latestBlock, blockTime,
  USDC, RPC, hasScanKey: () => !!SCAN_KEY,
};
