# CourtListener → Tracker ingestion pipeline

Keeps the **Prediction Market Litigation Explorer** Tracker live by pulling new
Kalshi / Polymarket dockets from CourtListener and turning them into
review-pending draft matters. It conforms to **`models/pmle/DATA_CONTRACT.md`**,
never fabricates a legal fact, and never publishes without a human approving.

> **Design in one sentence:** the pipeline *discovers, drafts, and (in `--auto`)
> publishes autonomously*. Docket metadata (caption, court, dates, parties,
> docket URL) is auto-filled; every legal judgment (outcome, posture, gate,
> contract type, statutes, narrative) gets an honest *pending/unreviewed*
> default that the summary stub discloses — **never a guessed fact**. A human
> can later enrich any matter; the pipeline won't clobber those edits.

> **Mode:** per the owner's directive this runs with **no human-approval gate**
> (`--auto`). The daily Action publishes new cases straight to `data.js` and
> commits to the deploy branch, so the live Tracker updates itself. The manual
> review commands below still work for hand-curation.

## Layout

```
scripts/ingest/
  ingest.js            CLI: fetch → relevance-gate → transform → diff → stage → approve
  lib/relevance.js     precision-first filter (drops "mentions Kalshi" noise)
  lib/transform.js     pure docket → draft-matter functions (no I/O)
  lib/courts.js        court_id → {state, forum, label} map (data, extend freely)
  lib/repo.js          loads the live data.js/constants.js so the repo is the schema
data/ingest/
  fixtures/            captured CL responses for offline dry-runs
  pending/<id>.json    staged drafts awaiting human review (created by a real run)
  held.json            in-window dockets the relevance gate rejected, with reasons
  seen.json            dedupe ledger (published docket_ids)
  watermark.json       last run + last filed_after window
.github/workflows/ingest.yml   daily scheduler → opens a review PR (never edits main)
```

## The token

Live fetching needs a CourtListener API token, **only** from the environment —
never hard-coded, never committed:

```bash
export COURTLISTENER_API_TOKEN=********        # local
# or: repo Settings → Secrets → Actions → COURTLISTENER_API_TOKEN  (for CI)
```

Free tier is fine: REST polling (this pipeline) plus up to 5 email alerts. There
are no webhooks on the free tier, so the scheduler polls daily.

## Commands

```bash
# See what a 60-day backfill would do — writes NOTHING (uses the captured fixture,
# so it runs with no token):
node scripts/ingest/ingest.js --dry-run --backfill --days 60 \
  --fixture data/ingest/fixtures/backfill-2026-06-24.json

# Same, live from CourtListener (needs the token):
node scripts/ingest/ingest.js --dry-run --backfill --days 60

# Incremental run — stages drafts into data/ingest/pending/ (still no data.js write):
node scripts/ingest/ingest.js

# Review what's staged and exactly which fields still need a human:
node scripts/ingest/ingest.js --review

# Publish into data.js (house style, then re-validates). Refuses if a draft still
# has un-reviewed judgment fields unless you pass --allow-stub:
node scripts/ingest/ingest.js --approve <matter-id>
node scripts/ingest/ingest.js --approve-all
```

The diff legend: **INSERT** = new matter, **UPSERT** = refresh auto fields on an
existing matter (e.g. a newly-set `decidedDate`), **SKIP** = already present /
unchanged, **HELD** = failed the relevance gate (logged, recoverable).

## How a new case actually goes live

1. Scheduler (or a manual run) stages drafts and opens a **review PR**.
2. A human opens each `data/ingest/pending/<id>.json` and fills the flagged
   fields — `outcome`, `posture`, `gate`, `contractType`, `statutes`,
   `summary`, party `role`s — from the docket / news. **This is the only place
   legal judgment enters; the pipeline never invents it.**
3. `node scripts/ingest/ingest.js --approve-all` splices the reviewed matters
   into `models/pmle/data.js` (one line each, newest first) and re-runs the
   validator. A failing validator blocks the publish.
4. Merge → Vercel deploys → the matter appears in Tracker and every lens.

## Idempotency & dedupe

Keyed on the CourtListener `docket_id`, carried in each id tail (`-cl<docketId>`)
and recorded in `seen.json`. A docket already in `data.js` — detected either by
that tail **or** by a `courtlistener.com/docket/<id>/` URL in an existing
matter's `sources` — is an upsert candidate, never a duplicate. Human edits to
judgment fields are sticky: upserts only ever touch auto-derivable fields.

## Relevance gate (why some real-looking cases are HELD)

A full-text search for "Kalshi"/"Polymarket" surfaces noise (a docket that
merely cites a news story, an unrelated `Robinhood` suit, a `Securities/
Commodities` case with no named platform). The gate accepts a docket only when a
target entity (Kalshi/KalshiEX, Polymarket/Blockratize, PredictIt) is a **named
party or in the caption**. Everything else is held in `held.json` with a reason,
so a human can rescue a false negative — the gate favors precision (a clean
dataset) over recall (a logged, recoverable miss).

## Why Node scripts and not npm

The site is a static, no-build deploy (no `package.json`). The pipeline is
dependency-free vanilla Node (≥18) precisely so it can never introduce a build
step that breaks the Vercel deploy. Run files directly with `node`.
