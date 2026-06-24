# DATA_CONTRACT.md — Prediction Market Litigation Explorer

This is the **authoritative schema** the CourtListener ingestion pipeline writes
against. The repo is the source of truth; the pipeline conforms to *this*, not the
other way around. If a future model/prompt disagrees with this file, this file wins
until a human updates it.

Generated during pipeline discovery. Reconciles the original ingest prompt's assumed
contract against what the repo actually is.

---

## 1. Where the data lives

One array, one file: **`models/pmle/data.js`** → `PMLE.matters = [ … ]`.

Every lens (Tracker, Map, Timeline, Network, Matrix, Doctrine), the search, the
filters, the command palette, and the Simulate analog-matcher read from this single
array. There is **no case data anywhere else.** The pipeline's only data write target
is this array (via the review/publish flow in §9 — never a blind append).

Serialization house style (must be preserved so diffs stay reviewable):

- The IIFE wrapper, `PMLE.SAMPLE_DATA = false;`, and `PMLE.matters = [` / `];` lines
  are **never** touched by the pipeline.
- **One matter object per line**, `JSON.stringify`'d (no pretty-printing), indented
  four spaces, trailing comma after each. This keeps `git diff` to exactly one line
  per changed/added matter.
- New matters are inserted at the **top** of the array (newest first), matching how
  the file is already ordered and how `HOW_TO_ADD_A_CASE.md` instructs humans.

## 2. The matter object — every field

Required unless marked. Enum values are defined in `models/pmle/constants.js`
(`PMLE.constants`), which is the single source of truth for controlled vocabularies —
the pipeline imports them, it does not hard-code them.

| Field | Type | Auto-derivable from CourtListener? | Notes |
| --- | --- | --- | --- |
| `id` | string | **yes** | Stable unique slug. Scheme in §4. Never reused, never mutated. |
| `caption` | string | **yes** | `caseName` from the docket, lightly normalized (§5). |
| `platform` | enum | partial | `Kalshi` · `Polymarket` · `PredictIt` · `Other`. Derived from the matched query + party scan; ambiguous → `needsReview`. |
| `parties` | `[{name,role}]` | **name yes, role no** | Names from the docket `party` list. **Role (Plaintiff/Defendant/Regulator/…) is NOT in docket metadata** → roles left `"Unknown"` and flagged. |
| `contractType` | enum | **no** | `Election` · `Sports` · `Economic indicator` · `Cultural` · `Other`. Legal/factual judgment → `needsReview`. |
| `forum` | enum | partial | `CFTC` · `SEC` · `State gaming regulator` · `Federal court` · `State court`. Federal district/appellate dockets → `Federal court`; everything else flagged. |
| `courtForum` | string | **yes** | Human court label from `court_id` (§6), e.g. `"S.D.N.Y."`. Appeal chains (`→ 9th Cir.`) are added by a human on review. |
| `docketNumber` | string | **yes** | `docketNumber` verbatim. Multi-court chains appended by a human. |
| `states` | `[USPS]` | **yes** | Derived from `court_id` (§6). Must exist in `TILES` or the validator rejects it. `[]` for a purely federal-agency matter. |
| `statutes` | `[string]` | **no** | Free-text legal citations. Not in docket metadata → `[]` + flagged. |
| `gate` | enum | **no** | `swap` · `special` · `cleared` (Howey **removed** — see §3). The doctrinal gate the matter turned on. Pure legal judgment → `needsReview`. |
| `doctrinalQuestion` | string | **no** | One-line legal question. Judgment → `needsReview`. |
| `posture` | enum | **no** | `Enjoined` · `Regulator action` · `Pending` · `Permitted` · `Settled` · `Dismissed`. Drives map color. Judgment → defaults to `Pending` **only** with a flag. |
| `outcome` | enum | **no** | `Pending` · `Enjoined` · `Permitted` · `Settled` · `Dismissed`. Drives timeline/network/doctrine color. New filings default `Pending` (the one safe default — an open docket with no termination genuinely is pending). |
| `filedDate` | ISO date | **yes** | `dateFiled`. |
| `decidedDate` | ISO date \| null | **yes** | `dateTerminated` (null while open). NB: termination ≠ a merits outcome; it only sets the date, never the `outcome` enum. |
| `lastUpdate` | string | **yes** | `YYYY-MM-DD` of the ingest run that last touched the matter from CL. |
| `summary` | string | **no** | 1–3 sentence narrative. **Never auto-written from metadata.** New matters get a neutral, factual stub (§7) until a human writes the real summary. |
| `sources` | `[string]` | **yes** | **Plain URL strings** (NOT `{label,url}` objects — the prompt assumed objects; the repo uses bare strings). Always seeded with the absolute CourtListener docket URL. |

### Fields the original prompt assumed but that DO NOT exist here
- `sources` as `{label, url}` objects → repo uses **plain URL strings**.
- a `howey` gate → **removed** from the model (§3).
- `jurisdiction`/`court` as separate top-level fields → repo splits this into
  `forum` (enum) + `courtForum` (string label) + `states` (USPS array).

## 3. Controlled vocabularies (frozen at time of contract)

Imported live from `constants.js`; reproduced here for review. The pipeline must
**reject** any value outside these and route the matter to `needsReview` rather than
inventing a new enum member.

- `platform`: `Kalshi`, `Polymarket`, `PredictIt`, `Other`
- `contractType`: `Election`, `Sports`, `Economic indicator`, `Cultural`, `Other`
- `forum`: `CFTC`, `SEC`, `State gaming regulator`, `Federal court`, `State court`
- `gate`: `swap`, `special`, `cleared` — **`howey` is intentionally absent** and must
  never be emitted (it was removed from the doctrine + simulate tabs by request).
- `posture`: `Enjoined`, `Regulator action`, `Pending`, `Permitted`, `Settled`, `Dismissed`
- `outcome`: `Pending`, `Enjoined`, `Permitted`, `Settled`, `Dismissed`
- `states`: any USPS code present in `constants.js` → `TILES` (the tile cartogram).
  A `court_id` mapping to a state not in `TILES` is flagged, not dropped.

## 4. ID scheme

`slug(caption)` truncated to a stable stem, plus a numeric suffix that is the matter's
1-based position when first added, e.g. `kalshiex-llc-v-flaherty-new-jersey-2`. For
pipeline-created matters the suffix is the **CourtListener `docket_id`** instead of a
position, guaranteeing global uniqueness and stability across runs:

```
<slug(caseName, max 6 words)>-cl<docket_id>
e.g.  roberts-v-kalshi-cl73481299
```

The `cl<docket_id>` tail is also the **dedupe key** (§8). An id is assigned once and
never changes, even if the caption is later edited by a human.

## 5. Caption normalization

- Title-case ALL-CAPS captions (`DOUGLAS v. NATIONAL PARK SERVICE` → `Douglas v.
  National Park Service`) but preserve known entity casing (`KalshiEX`, `LLC`, `CFTC`,
  `SEC`, `NGCB`).
- Collapse whitespace; normalize ` v ` / ` vs. ` → ` v. `.
- Never alter the legal substance of the name.

## 6. court_id → (state, forum, courtForum)

Derived from CourtListener's `court_id`. Federal district courts map to their state;
circuit courts and agency dockets map to `[]` states + a human-added chain. The map
lives in `scripts/ingest/lib/courts.js` and is data, not code — extend it there.

Examples:
- `nysd` → state `NY`, forum `Federal court`, courtForum `"S.D.N.Y."`
- `cand` → state `CA`, forum `Federal court`, courtForum `"N.D. Cal."`
- `dcd`  → state `DC`, forum `Federal court`, courtForum `"D.D.C."`
- `ca9`  → states `[]`, forum `Federal court`, courtForum `"9th Cir."`

Any `court_id` not in the map → `courtForum` = the raw id, `states` = `[]`, **flagged**.

## 7. Stub summary for un-reviewed matters

New matters never get a fabricated narrative. They get a factual, provenance-only stub
that is obviously a placeholder:

```
NEW FILING — auto-detected from CourtListener on <ingest date>. Filed <filedDate> in
<courtForum> (docket <docketNumber>). Merits, posture, and doctrinal gate not yet
reviewed. See source docket.
```

This contains **only** facts pulled verbatim from the docket. No outcome, no
prediction, no characterization.

## 8. Dedupe & idempotency

- **Primary key:** CourtListener `docket_id`, carried in the id tail (`-cl<docket_id>`)
  and recorded in the ledger `data/ingest/seen.json`.
- A docket already in the ledger or already present in `data.js` (by id tail) is an
  **upsert candidate**, never a duplicate insert.
- Upsert rule: the pipeline may refresh **only the auto-derivable fields** of an
  existing matter (`decidedDate`, `lastUpdate`, `caption` if still un-reviewed,
  `sources` if the URL changed). It must **never** overwrite a human-reviewed
  judgment field (`gate`, `outcome`, `posture`, `summary`, `contractType`,
  `doctrinalQuestion`, `statutes`, party `role`s). Human edits are sticky.
- A matter carries `_review` metadata (a non-rendered field, see §9) the pipeline uses
  to know which fields are still safe to touch.

## 9. Publish flow

> **Owner directive: autonomous publishing — no human-approval gate.** The
> scheduled pipeline runs with `--auto`: it stages drafts and immediately
> publishes them into `data.js` so new cases reach the live Tracker without a
> review step. This is safe *only because* auto-published matters contain no
> invented legal facts — every judgment field carries an honest pending/
> unreviewed default and the summary stub discloses it (see §2/§7). The
> `needsReview` list is still recorded in the ledger/provenance so a human can
> later enrich a matter (set the real `outcome`, `gate`, `summary`, etc.); an
> upsert never clobbers those human edits (§8).

The manual review path below still exists for hand-curation; `--auto` simply
collapses it. With `--auto`, publish refuses nothing (it implies `--allow-stub`).

A non-`--auto` run writes nothing to `data.js`. Instead:

1. Drafts land in `data/ingest/pending/<id>.json` (one file per new/updated matter),
   each with a `_review` block: `{status:"pending", needsReview:[…fields…],
   provenance:{docketId, docketUrl, query, ingestedAt}}`.
2. `node scripts/ingest/ingest.js --review` prints a human-readable summary of every
   pending draft and exactly which fields need a human.
3. `node scripts/ingest/ingest.js --approve <id>` (or `--approve-all`) merges approved
   drafts into `data.js` in house style, strips the `_review` block from rendered
   output (kept in the ledger), updates the watermark, and re-runs the validator.
4. Only `--approve` writes to `data.js`. `--auto` collapses 1→3 for a fully reviewed
   batch but is opt-in per run and never the scheduled default.

Nothing is committed that fails `node scripts/ingest/validate.js` or that leaves a
`needsReview` field unresolved (publish refuses unless `--allow-stub` is passed for
the provenance-only stub case).

## 10. Provenance

Every pipeline-touched matter records, in the ledger and in its `_review.provenance`:
`docketId`, absolute CourtListener `docketUrl`, the `query` that surfaced it, the
`court_id`, and the ISO `ingestedAt` timestamp. The rendered matter always carries the
docket URL in `sources[0]`.

## 11. Relevance gate (critical — see discovery finding)

Full-text `q="Kalshi"` / `q="Polymarket"` is **noisy** (it surfaced CNN v. Perplexity,
Collar v. Robinhood, etc.). A docket is accepted only if it passes
`scripts/ingest/lib/relevance.js`:

- a target entity (`Kalshi`, `KalshiEX`, `Polymarket`, `PredictIt`, and known
  affiliates) appears in `caseName` **or** the `party` list, **or**
- `suitNature` is `850 Securities/Commodities` **and** a prediction-market entity
  appears in parties, **or**
- the docket is on a curated allow-list of known docket_ids (the existing 48 matters'
  dockets are seeded here).

Everything else is **held**, not published — logged to `data/ingest/held.json` with the
reason, so a human can rescue a false-negative. The gate is tuned to favor *precision*
(don't pollute the dataset) over recall (a missed case is a logged, recoverable miss).

## 12. Non-negotiables (operating principles, restated)

1. Repo schema is source of truth — this file conforms to it.
2. **No fabrication of legal facts.** Unknown → flag, never guess. Outcome/posture/
   gate/summary are never invented from metadata.
3. Idempotent upsert keyed on `docket_id`. Never duplicate.
4. Review-before-publish by default (`--auto` off).
5. Never write data that fails the validator or the static build.
6. Provenance trail on every matter (CourtListener URL + docket_id + query + timestamp).
