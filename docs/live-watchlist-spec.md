# Live Watchlist — Complete Technical Specification

> The "Live Watchlist (BETA)" tab of **Polymarket Insider Forensics**. This document
> describes **every function, method, threshold, data shape, and purpose** in the tab's
> end-to-end pipeline, exactly as implemented. It is written to be usable as an
> implementation/specification prompt: a competent engineer (or model) could rebuild the
> feature from this alone.

---

## 0. What the tab is (and is NOT)

**Purpose.** An **early-warning** feed. It scores **outsized trades on OPEN (unresolved)
markets the instant they are placed**, before anyone knows the outcome. It is the
real-time complement to the "Suspect Wallets" tab (which is retrospective *proof* over
resolved records).

**Why it's BETA / noisier.** At trade time it CANNOT use the two strongest precision
anchors — "did it win" and "was it profitable." So a confident whale who is simply *wrong*
looks identical to an insider until the market resolves. Every entry therefore later
**hardens** into a forensic case (if it wins AND the wallet becomes a published suspect)
or **self-clears** (resolves without panning out).

**Scope guard.** Only markets that can turn on **material non-public information** are
watched. Sports, crypto-price targets, and weather are **excluded by design** (a betting
edge there is handicapping/luck, not secret info) — see `category()` §4.3.

**Isolation guarantee.** The watchlist is fully isolated from the resolved engine: it
persists in an **off-git Actions cache** (`state.watchlist`), is **deadline-gated**, and
wrapped in try/catch. The published `store.json` and the Suspect Wallets product never
depend on it — a watchlist failure can never freeze the main pipeline.

---

## 1. End-to-end data flow

```
                         (GitHub Actions cron / self-chain, every ~12 min)
                                          │
        scripts/forensics/scan.js  ──────►│ WATCHLIST STEP (§2)
                                          │   1. RECONCILE + SELF-CLEAN purge
          poly.recentTrades() ───────────►│   2. ADD candidates (open mkts, outsized buys)
          poly.openMarketMeta() ─────────►│        → category filter (drop sports/etc.)
          detectors.extractEntities() ───►│        → entity for news/reg lookups
          external.gdeltArticleCount() ──►│        → newsBlackout input
          external.fedRegisterMatches() ─►│        → fedRegister input
          detectors.watchlistScore() ────►│        → score + fired signals
                                          │   3. EMIT payload.watchlist + watchlistMeta
                                          ▼
                          data/forensics/store.json  (committed → Vercel deploy)
                                          │
        api/forensics/subjects.js  ──────►│ passes watchlist + watchlistMeta through (§6)
                                          ▼
        models/insider-forensics.html ───►│ load() fetch → renderWatch() table (§7)
```

State lives in two places:
- `state.watchlist` — the durable working set, **off-git** (Actions cache `state.json`),
  keyed by `cond|wallet`. Survives across ticks. This is the source of truth.
- `payload.watchlist` / `payload.watchlistMeta` — the **committed snapshot** emitted into
  `store.json` each tick (top 150), which the read API and UI consume.

---

## 2. Scanner — `scripts/forensics/scan.js` (WATCHLIST STEP)

Runs near the end of each scan tick, after the resolved-engine payload is published.
Bounded by a hard `INFO_DEADLINE` (≈ `min(env.INFO_BUDGET_S || 720, 760)` s after start)
and wrapped in `try/catch` (failure is logged non-fatal; the resolved store is untouched).

### 2.1 RECONCILE + SELF-CLEAN (runs every tick, ungated)

Loops over every entry id in `state.watchlist`:

1. **Self-clean purge** (correctness guard):
   ```js
   if (e.status === "watching" && !poly.category([], e.market || e.question || ""))
     { delete state.watchlist[id]; continue; }
   ```
   Re-classifies each watched market by its own question every tick. If `category()`
   returns `null` (sports / crypto-price / weather, or a stale entry from before the
   filter existed), the entry is **dropped immediately** — it never lingers.

2. **Resolution reconcile**: if the market is now resolved (`cat[e.cond].w != null`):
   - `won = (resolved winner === e.outcome)`
   - `flagged = the wallet is now in the published suspect set`
   - `status = (won && flagged) ? "promoted" : "cleared"`
   - records `e.won`, `e.walletFlagged`, `e.resolvedTs`.

3. **Retire stale**: delete if resolved > 7 days ago, OR first seen > 30 days ago.

### 2.2 ADD new candidates (deadline-gated)

Only runs while `Date.now() < INFO_DEADLINE`.

1. **Pull the live feed**: `poly.recentTrades({ pages: min(env.WATCH_PAGES||4, 6) })` (§4.1).
2. **Normalize + filter** each trade to candidates that are:
   - `side !== "SELL"` (buys only),
   - `sizeUsd > 0`, `ts > 0`,
   - **on an OPEN market** (`!(cat[cond] && cat[cond].w != null)` — drop already-resolved),
   - `outcome` normalized to `YES`/`NO`.
3. **Build the per-market size distribution** `byMarket[cond] = [sizeUsd…]` from the feed
   itself (no extra per-market fetches) — this is the peer set for the size z-score.
4. **Rank candidates** by `sizeUsd` desc, keep those `>= WATCH_MIN_USD` (default **$2,500**).
5. **Fetch open-market metadata** for the top ≤18 candidate conds in ONE batch:
   `poly.openMarketMeta(topConds)` (§4.2) → `{question, slug, category, closed}`.
6. **Per candidate** (until `INFO_DEADLINE` or `WATCH_TOP` (default 10, max 16) scored):
   - **Drop** if `!md || md.closed || !md.category` (unknown / resolved / sports-etc.).
   - Skip if already in `state.watchlist` or seen this tick.
   - `marketSizes` = peer trades in this market excluding this one.
   - `ents = extractEntities(md.question)` (§3.1).
   - If entities exist, query (short-timeout, best-effort):
     - `nb = (gdeltArticleCount(ents[0], ts−24h, ts) === 0)` → news-blackout flag (§5.1)
     - `fr = (fedRegisterMatches(ents).matches.length > 0)` → reg-match flag (§5.2)
   - `sc = watchlistScore({ sizeUsd, marketSizes, newsBlackout:nb, fedRegister:fr })` (§3.2).
   - If `sc.score >= WATCH_SCORE` (default **6**), insert an entry (shape in §8) with
     `status: "watching"`.

### 2.3 EMIT

```js
payload.watchlist = Object.values(state.watchlist)
  .sort(by status rank {promoted:3, watching:2, cleared:1}, then ts desc)
  .slice(0, 150);
payload.watchlistMeta = { total, watching, promoted };
```

### 2.4 Environment knobs (scanner)

| Env | Default | Meaning |
|---|---|---|
| `WATCH_PAGES` | 4 (max 6) | pages of the recent-trades feed to pull |
| `WATCH_MIN_USD` | 2500 | minimum trade size to be a candidate |
| `WATCH_TOP` | 10 (max 16) | max candidates scored per tick |
| `WATCH_SCORE` | 6 | minimum watchlistScore to be added |
| `INFO_BUDGET_S` | 720 (max 760) | hard wall-clock deadline for info/watchlist work |

---

## 3. Detectors — `api/forensics/detectors.js`

### 3.1 `extractEntities(question) → string[]`

Heuristic named-entity extractor (no NLP model). Tokenizes the market question and pulls:
- **multi-word Title-Case runs** (e.g. "Federal Reserve", "Kim Jong Un"), keeping internal
  connectors (`of/the/and/for/de/du/von/&/-`) when flanked by capitalized words;
- **standalone acronyms** (e.g. "SEC", "FDA", "NATO").
It trims leading/trailing stop-words (`ENTITY_STOP`) and connectors (`ENT_CONN`), drops
generic tokens, and returns the most specific entities first. Output feeds the GDELT and
Federal-Register lookups. Empty array ⇒ no news/reg query is made for that trade.

### 3.2 `watchlistScore(x, opts) → { score, fired[], sizeZ, whaleX, poolPct, p90 }`

The trade-time scorer. Philosophy: **being INFORMED/EARLY outweighs being BIG** — a
news-blackout under a big bet scores highest; raw size scores lowest.

Inputs `x = { sizeUsd, marketSizes:[usd…], poolUsd?, newsBlackout:bool, fedRegister:bool }`.

Computes over `marketSizes` (the peer trades in the same market):
- `mu` = mean, `sd` = sample std-dev, `p90` = 90th-percentile trade,
- `z = (sizeUsd − mu)/sd` (size anomaly vs this market),
- `whaleX = sizeUsd / p90`,
- `poolPct = sizeUsd / poolUsd` (if a pool size is known).

Signals fired and their weights (`WATCH_W`):

| Signal | Condition | Weight | UI label |
|---|---|---|---|
| `size` | `z >= 3` | **5** | "outsized vs market" |
| `whale` | `whaleX >= 10` | **4** | "lone whale" |
| `pool` | `poolPct >= 0.02` | **3** | "large % of pool" |
| `blackout` | `newsBlackout === true` | **6** (highest) | "news blackout" |
| `fedReg` | `fedRegister === true` | **3** (low; noisy) | "Federal Register" |

`score` = sum of fired weights. Added to the watchlist when `score >= WATCH_SCORE` (6).
(Example from the live screenshot: `outsized vs market` (5) + `lone whale` (4) = **9**.)

### 3.3 `newsBlackout(x, opts) → { fires, score, articleCount, … }`

Fires when **zero** public news matched the market's entity in the window before the bet
AND the bet was outsized:
- `blackout = articleCount <= newsBlackoutFloor` (floor default **0**),
- `outsized = x.outsized === true`,
- `fires = blackout && outsized`.
`hasData=false` if no count was obtained (so it degrades to "unknown," never a fake 0).
Window default 24 h. The interpretation: trading **ahead of** the public story, not
reacting to it.

### 3.4 `fedRegister(x, opts) → { fires, top, leadDays, … }`

Regulatory-insider **corroborator** (low weight). Fires only on a **precision-filtered**
match: the market's specific entity must appear in a Federal Register document's
title/abstract (not a fuzzy relevance hit). TIMING is the point — per matched doc it
computes `leadDays = (publication_date − betDate)`; it credits **only docs published
on/after the bet** (`leadDays >= 0`, i.e. the wallet bet *before* the filing). A doc
already public before the bet = reacting, not ahead → not credited. (In the watchlist this
is reduced to a boolean `fr`; the full timing/lead-days is used in the resolved dossier.)

---

## 4. Polymarket client — `api/forensics/poly.js`

### 4.1 `recentTrades(opts) → trade[]`

Paginates Polymarket's public Data-API `/trades` endpoint (`pages` × `limit`, default
12×500, watchlist uses ≤6 pages). Returns raw trade rows (wallet, conditionId, size,
price, timestamp, outcome, side, title/slug). This is the **live discovery feed**.

### 4.2 `openMarketMeta(conds, opts) → { [cond]: {question, slug, category, closed} }`

Batch Gamma lookup for OPEN markets. For each cond returns:
- `question` — the real market title,
- `slug` — the event slug → a **working market link** (`polymarket.com/event/<slug>`),
- `category` — via `category(tags, question)` (null ⇒ excluded class),
- `closed` — resolution flag.
Used both to DROP publicly-decided markets and to give each row a real link.

### 4.3 `category(tags, question) → string | null`

The scope gate. Lower-cases `tags + question` and:
- **Returns `null`** (excluded) for **sports** (incl. "exact score", bare "score",
  scoreline/league/cup terms, fifa/uefa/olympic, knockout/semi-final, cricket/rugby/
  nascar/F1), **crypto-price targets** (price of/hit $/ATH/market-cap), **weather**, and
  social-mention count markets.
- **Returns a category** (included) for insider-tradeable surfaces: Military & Defense,
  Elections, Economics, Legal & Regulatory, Corporate & M&A, Politics, Crypto Events,
  Tech & Announcements, Culture, World/Geopolitics.
- Unmatched ⇒ `null` (excluded).

This single function is what keeps sports off the watchlist (and is re-run by the §2.1
self-clean purge to evict anything that slips through or predates a filter change).

---

## 5. External data — `api/forensics/external.js` (scanner-only, network)

Both keyless, timeout-bounded, and return safe null/empty on any failure (detectors then
degrade to no-data rather than fabricating a flag). Never imported by the read APIs.

### 5.1 `gdeltArticleCount(entity, fromSec, toSec, opts) → int | null`

GDELT DOC 2.0 query for the count of global news articles matching the exact-phrase
`entity` in `[fromSec,toSec]`. An HTTP-200 with an **empty body** is GDELT's way of saying
"zero matching articles" → resolved to `0` (a genuine blackout), not null. Network failure
→ `null` (unknown). Note: GDELT's index is shallow for old dates, so the scanner only
news-queries bets inside a recent window (≈90 days) to avoid fabricating a blackout.

### 5.2 `fedRegisterMatches(entities, opts) → { matches:[{title,agency,date,url}], entity }`

Federal Register v1 query, **precision-filtered**: the entity must appear as a substring in
the document title/abstract. Window is anchored on the bet (`back = windowDays||14`,
`forward = forwardDays||120`) because a regulatory action can be published weeks/months
after a wallet positions for it. `matches` is `[]` on failure or no precise hit.

---

## 6. Read API — `api/forensics/subjects.js`

`GET /api/forensics/subjects` reads the committed `store.json` and passes through:
- `watchlist`: `Array.isArray(store.watchlist) ? store.watchlist : []`
- `watchlistMeta`: `store.watchlistMeta || { total, watching, promoted }`
Edge cache is short (`s-maxage=20, stale-while-revalidate=40`) so a refresh shows the
newest deployed scan quickly. The watchlist is **not** affected by the `type/tier/sort`
query params (those filter the Suspect-Wallets `subjects` array only).

---

## 7. Frontend — `models/insider-forensics.html` (Live Watchlist view)

The tab is plain vanilla JS (no framework). Module-level state: `WL = []` (watchlist
array), `WMETA = {}` (meta). `SIGNAME` maps signal keys → human labels.

### 7.1 `show(which)`
Toggles between the two views. `show('watch')` reveals `#view-watch`, marks the tab active,
and lazy-loads the Suspect-Wallets iframe only when needed. Persists the choice in
`location.hash`.

### 7.2 `load(initial)` + auto-refresh
`fetch('/api/forensics/subjects', {cache:'no-store'})` then:
- sets the wallet count + `stamp` ("· N wallets · last scan HH:MM ET · auto-refreshing"),
- `WL = d.watchlist; WMETA = d.watchlistMeta`, then `renderWatch()`.
A `setInterval(load, 60000)` polls every 60 s; when `generatedAt` advances (a newer scan
deployed) it also reloads the dossier iframe so the whole page reflects the new scan
without a manual refresh.

### 7.3 `renderWatch()`
- Sets the `LIVE WATCHLIST · N` tab count from `WL.length`.
- Renders the three stat cards (§7.5): WATCHING / HARDENED (promoted) / TOTAL TRACKED.
- Renders the table (top 150), one `<tr>` per entry with columns:

| Column | Source | Notes |
|---|---|---|
| WHEN | `ago(e.ts)` | "43m ago" / "2h ago" / "3d ago" |
| MARKET | `e.market` + `e.url` | title + ↗ link to `polymarket.com/event/<slug>` |
| WALLET | `e.wallet` | shortened `0x…`, links to Polygonscan |
| BET | `e.outcome` @ `e.price` | YES green / NO red, "@94¢" |
| SIZE | `usd(e.sizeUsd)` | "$6K" / "$191K" |
| SIGNALS | `e.signals[]` → `SIGNAME` | chips; blackout/fedReg styled as "info", others "hot" |
| SCORE | `e.score` | the watchlistScore sum |
| STATUS | `e.status` | `watching` / `promoted (· won)` / `cleared` pill |
| ON-CHAIN | `e.cond` | "market ↗" link |

Empty state: a friendly "No live flags right now…" row.

### 7.4 Helpers
- `esc(s)` — HTML-escape.
- `usd(n)` — compact currency ($6K, $1.2M).
- `ago(ts)` — relative time from a unix-seconds timestamp.
- `profileUrl(e)` — `polygonscan.com/address/<wallet>`.
- `stat(k,v,s)` — renders a dashboard stat card.

### 7.5 Stat cards
- **WATCHING** = count `status === "watching"` (open trades watched live).
- **HARDENED** = count `status === "promoted"` (resolved in the bettor's favour AND wallet
  is now a flagged suspect).
- **TOTAL TRACKED** = `WL.length` (incl. self-cleared).

### 7.6 Real-time header (above the tabs)
A seconds-ticking America/New_York clock (`Intl.DateTimeFormat`, auto EST/EDT) + a pulsing
"● NEW YORK · LIVE FEED" indicator (`tickClock()` on a 1 s `setInterval`). Decorative
liveness; does not duplicate the per-tab counts.

### 7.7 Signals legend ("WHAT THE TRADE-TIME SIGNALS MEAN")
Collapsible `<details>` explaining each signal (outsized/whale/pool/blackout/fedReg) and
the status state machine.

---

## 8. Data shapes

**Watchlist entry** (`state.watchlist[id]`, id = `"<cond>|<wallet-lowercase>"`):
```js
{
  id, cond, wallet,
  market,            // open-market question
  category,          // poly.category() result (non-null)
  url,               // polymarket.com/event/<slug> | null
  outcome,           // "YES" | "NO"
  price,             // entry price 0..1 (3dp)
  sizeUsd,           // rounded USD size
  ts,                // trade unix-seconds
  firstSeen,         // "Mon DD" added
  status,            // "watching" | "promoted" | "cleared"
  score,             // watchlistScore sum
  signals,           // fired keys: ["size","whale","pool","blackout","fedReg"]
  sizeZ, whaleX,     // diagnostics from watchlistScore
  newsBlackout, fedRegister,  // booleans
  // added on resolution:
  won, walletFlagged, resolvedTs
}
```

**`watchlistMeta`**: `{ total, watching, promoted }`.

---

## 9. Lifecycle state machine

```
            placed (open market, outsized, score≥6)
                          │
                          ▼
                     ┌─────────┐   market resolves
                     │ watching│──────────────┐
                     └─────────┘               │
                          │                     ▼
        category()==null  │            won AND wallet flagged?
        (self-clean purge) │            ┌────────┴─────────┐
                          ▼            yes                no
                       DELETED      ┌────────┐         ┌────────┐
                                    │promoted│         │cleared │
                                    └────────┘         └────────┘
                                         │                 │
                            retire >7d after resolve, or >30d after firstSeen → DELETED
```

---

## 10. Honest limitations (by design)

- **No outcome/profit at trade time** → intentionally noisier than Suspect Wallets; a
  wrong-but-confident whale is indistinguishable from an insider until resolution.
- **fedReg is a corroborator**, low weight, precision-gated; **newsBlackout** is only
  reliable for recent bets (GDELT's historical index is shallow), so it is restricted to a
  ~90-day recent window in the scanner.
- **Coverage is bounded per tick** (`WATCH_TOP`, `WATCH_PAGES`, the info deadline) so the
  watchlist can never overrun the budget and freeze the main pipeline; it accumulates
  across ticks instead.
- **Sports/crypto-price/weather are excluded**, so genuine information-asymmetry in those
  classes is intentionally out of scope.
