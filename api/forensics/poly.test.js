"use strict";
const test = require("node:test");
const assert = require("node:assert");
const poly = require("./poly.js");

// txMapFromTrades recovers the entry-tx hash for bets that come from the /positions
// summary feed (which has no per-trade hash). The rule must match buildUserRecord:
// the EARLIEST BUY for a (market, outcome), sells ignored, no-hash rows skipped.
test("txMapFromTrades: earliest BUY wins, sells ignored, hashless skipped", () => {
  const trades = [
    { conditionId: "0xAAA", side: "BUY", outcome: "Yes", timestamp: 200, transactionHash: "0xlate" },
    { conditionId: "0xAAA", side: "BUY", outcome: "Yes", timestamp: 100, transactionHash: "0xentry" },
    { conditionId: "0xAAA", side: "SELL", outcome: "Yes", timestamp: 50, transactionHash: "0xsell" },
    { conditionId: "0xBBB", side: "BUY", outcomeIndex: 1, timestamp: 300, transactionHash: "0xno" },
    { conditionId: "0xCCC", side: "BUY", outcome: "Yes", timestamp: 10 }, // no hash → not mapped
  ];
  const m = poly.txMapFromTrades(trades);
  assert.equal(m.byKey["0xAAA|YES"], "0xentry", "earliest BUY tx, not the later add or the sell");
  assert.equal(m.byKey["0xBBB|NO"], "0xno", "NO outcome resolved via outcomeIndex");
  assert.equal(m.byKey["0xCCC|YES"], undefined, "rows without a hash are not mapped");
  assert.equal(m.byCond["0xAAA"], "0xentry", "cond-only fallback also picks earliest BUY");
  assert.equal(m.byCond["0xCCC"], undefined, "cond-only fallback skips hashless markets too");
});

test("txMapFromTrades: empty / nullish input is safe", () => {
  assert.deepEqual(poly.txMapFromTrades(null), { byKey: {}, byCond: {} });
  assert.deepEqual(poly.txMapFromTrades([]), { byKey: {}, byCond: {} });
});

// Field-name robustness: Polymarket exposes the hash under several keys across its
// /trades and /activity endpoints; all must be honoured so the backfill works
// regardless of which path produced the rows.
test("txMapFromTrades: accepts transaction_hash and txHash aliases", () => {
  const m = poly.txMapFromTrades([
    { conditionId: "0xD", side: "BUY", outcome: "Yes", timestamp: 1, transaction_hash: "0xsnake" },
    { conditionId: "0xE", side: "BUY", outcome: "No", timestamp: 1, txHash: "0xcamel" },
  ]);
  assert.equal(m.byKey["0xD|YES"], "0xsnake");
  assert.equal(m.byKey["0xE|NO"], "0xcamel");
});

// ---------------------------------------------------------------------------
// aggregateMarket NET P&L. The reconstruction must report the money a wallet
// actually KEPT (proceeds from sells + $1 per winning share still HELD − total
// buy cost), and the bet size must be NET capital carried into the event (gross
// buys minus sells pulled back out) — never gross churn turnover. This is the
// fix that stops a high-volume scalper (e.g. @greenfia: $831k turnover, $191
// real all-time P&L) from reading as a giant out-profiting insider bet.
test("aggregateMarket: NET realized P&L and NET stake, not gross held-to-resolution", () => {
  const market = { cond: "0xM", tokenId: "t", question: "Q", url: "#", category: "World", eventGroup: "ev", winner: "YES", resolvedMs: 2000000 };
  const T = (w, side, size, price, ts) => ({ proxyWallet: w, side, size, price, outcome: "Yes", timestamp: ts, transactionHash: "0x" + w.slice(2) + ts });
  const trades = [
    // HOLDER: buys 100k @ $0.10 ($10k), never sells, holds YES to resolution.
    T("0xhold", "BUY", 100000, 0.10, 100),
    // CHURNER: buys 100k @ $0.10 ($10k), sells all 100k @ $0.12 ($12k) BEFORE resolution.
    T("0xchurn", "BUY", 100000, 0.10, 100), T("0xchurn", "SELL", 100000, 0.12, 150),
    // PARTIAL: buys 100k @ $0.10 ($10k), sells 40k @ $0.15 ($6k), holds 60k to resolution.
    T("0xpart", "BUY", 100000, 0.10, 120), T("0xpart", "SELL", 40000, 0.15, 160),
  ];
  const out = poly.aggregateMarket(market, trades);

  // HOLDER: 100k winning shares × $1 − $10k cost = +$90k; net invested = full $10k.
  assert.equal(out["0xhold"].pnl, 90000, "holder net P&L = +$90k");
  assert.equal(out["0xhold"].stakeUsd, 10000, "holder net stake = $10k (no sells)");
  assert.equal(out["0xhold"].grossBuyUsd, 10000, "holder gross = $10k");

  // CHURNER: $12k proceeds + $0 held payout − $10k cost = +$2k NET (not the gross +$90k);
  // net invested = max(0, $10k − $12k) = $0, so it cannot trip the outsized-bet signal.
  assert.equal(out["0xchurn"].pnl, 2000, "churner net P&L = +$2k, NOT the gross held-to-resolution +$90k");
  assert.equal(out["0xchurn"].stakeUsd, 0, "churner net stake = $0 (sold more than it sank in)");
  assert.equal(out["0xchurn"].grossBuyUsd, 10000, "churner gross buy still recorded = $10k");
  assert.equal(out["0xchurn"].hz, null, "churner below the $500 net-stake floor → not Harvard-scored");

  // PARTIAL: $6k proceeds + 60k held × $1 − $10k cost = +$56k; net invested = $4k.
  assert.equal(out["0xpart"].pnl, 56000, "partial-seller net P&L = +$56k");
  assert.equal(out["0xpart"].stakeUsd, 4000, "partial net stake = $10k − $6k = $4k");
});

// betPL must consume the NET pnl that aggregateMarket now attaches, so the
// published profit equals the money kept rather than a buy-and-hold fiction.
test("aggregateMarket → betPL: the published P&L is the NET pnl", () => {
  const build = require("./build.js");
  const market = { cond: "0xM2", winner: "YES", url: "#", question: "Q", category: "World", resolvedMs: 2000000 };
  const T = (w, side, size, price, ts) => ({ proxyWallet: w, side, size, price, outcome: "Yes", timestamp: ts, transactionHash: "0x" + ts });
  const out = poly.aggregateMarket(market, [
    T("0xa", "BUY", 50000, 0.20, 100), T("0xa", "SELL", 50000, 0.25, 150),  // +$2.5k net
    T("0xb", "BUY", 50000, 0.20, 100),                                       // holds → +$40k net
    T("0xc", "BUY", 50000, 0.20, 100),
  ]);
  assert.equal(build.betPL(out["0xa"]), 2500, "betPL returns the net +$2.5k (uses pnl, not stake·(1/p−1))");
  assert.equal(build.betPL(out["0xb"]), 40000, "holder betPL = 50k×$1 − $10k = +$40k");
});

// ---------------------------------------------------------------------------
// category() SCOPE — the keyword classifier decides which markets are even
// eligible for insider scoring. These cases come from documented real insider
// episodes that the old filter wrongly excluded (Nobel, Google Year-in-Search,
// OpenAI browser, Taylor Swift engagement, the $131M Khamenei market), plus the
// "Gemini 3.0" → crypto misclassification. Exclusions (sports/price/weather)
// must still hold so broadening scope didn't open the floodgates.
test("category(): documented insider markets are IN scope, with the right bucket", () => {
  const C = (q) => poly.category([], q);
  // newly-included surfaces (were null before)
  assert.ok(C("US strikes Iran by February 28, 2026?"), "Iran strike must be in scope"); // World (via "iran")
  assert.equal(C("Khamenei out as Supreme Leader by Feb. 28?"), "Military & Defense"); // $131M market, was excluded
  assert.equal(C("Maduro out by January 31, 2026?"), "Politics");
  assert.equal(C("Nobel Peace Prize Winner 2025"), "World");                            // Nobel leak case
  assert.equal(C("Will Maria Corina Machado win the Nobel Peace Prize in 2025?"), "World");
  assert.equal(C("#1 Searched Person on Google This Year"), "Tech & Announcements");    // AlphaRaccoon case
  assert.equal(C("OpenAI browser by October 31?"), "Tech & Announcements");             // OpenAI browser case
  assert.equal(C("Taylor Swift and Travis Kelce engaged in 2025?"), "Culture");         // romanticpaul case
  // the "Gemini 3.0" misclassification: Google's AI model, NOT the crypto exchange
  assert.equal(C("What day will Gemini 3.0 be released?"), "Tech & Announcements");
});

test("category(): exclusions still hold + real crypto listings unaffected", () => {
  const C = (q) => poly.category([], q);
  assert.equal(C("Will the Lakers win the game tonight?"), null);          // sports — public skill
  assert.equal(C("Will Bitcoin hit $100,000 by 2026?"), null);            // price target — public discovery
  assert.equal(C("Hottest day in NYC in July?"), null);                   // weather — nature
  assert.equal(C("How many times will Trump tweet this week?"), null);    // count market
  assert.equal(C("Will Coinbase list a new token in 2026?"), "Crypto Events"); // genuine crypto event still routed right
});

// ---------------------------------------------------------------------------
// FAVORITE-ODDS single-market episode (the OpenAI $40K-at-85% archetype). The
// long-shot path (won/longshot/conviction) only fires ≤35% odds, so the honest
// question is whether the HARVARD episode engine catches an outsized bet at
// FAVORITE odds. It must: z_bet_cross is odds-agnostic. This proves the gap was
// SCOPE (fixed in category()), not a missing detector — so no redundant,
// false-positive-prone favorite-odds detector is needed.
test("aggregateMarket: outsized FAVORITE-odds single-market bet is Harvard-eligible", () => {
  const market = { cond: "0xFAV", winner: "YES", url: "#", question: "OpenAI browser by October 31?", category: "Tech & Announcements", resolvedMs: 2000000 };
  const T = (w, sz, ts) => ({ proxyWallet: w, side: "BUY", size: sz, price: 0.82, outcome: "Yes", timestamp: ts, transactionHash: "0x" + w + ts });
  // one whale puts ~$41k on at 82% (a favorite); a realistic crowd of 40 small bettors (~$820 each).
  // NOTE: z_bet_cross damps below 2 in a THIN market (few buyers) because the whale inflates its own
  // SD — a real limitation of the cross-sectional approach in illiquid markets. With a normal crowd
  // the insider stands out clearly.
  const trades = [T("0xwhale", 50000, 100)];
  for (let i = 0; i < 40; i++) trades.push(T("0xsmall" + i, 1000, 90));
  const out = poly.aggregateMarket(market, trades);
  const w = out["0xwhale"];
  assert.ok(w.entryPrice > 0.8, "entered at favorite odds (~0.82), NOT a long-shot");
  assert.ok(w.hz, "Harvard cross-section computed (market cleared ≥3 buyers + ≥$10k)");
  assert.ok(w.hz.zBetCross > 2, "outsized vs peers (z_bet_cross > 2) at favorite odds → Harvard-eligible, got " + w.hz.zBetCross);
  // RAW dollar evidence behind the z (so a card can show "you made $X; market avg $Y ± $Z"):
  assert.equal(typeof w.hz.profitUsd, "number", "hz carries this wallet's net profit $");
  assert.equal(typeof w.hz.mktMeanProfit, "number", "hz carries the peer mean profit $");
  assert.equal(typeof w.hz.mktSdProfit, "number", "hz carries the peer profit SD $");
  assert.equal(typeof w.hz.mktMeanStake, "number", "hz carries the peer mean stake $");
});
