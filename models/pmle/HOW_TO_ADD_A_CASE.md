# How to add or edit a case (Prediction Market Litigation Explorer)

Everything the explorer shows comes from **one array** in
[`data.js`](./data.js). The five lenses, the search, the filters, and the
simulator all read from it. There is **no case data anywhere else**, you never
touch UI code to add a matter.

This folder is the data layer:

| File | What it is | Do you edit it? |
| --- | --- | --- |
| `data.js` | The matters (the cases). | **Yes, this is the file.** |
| `constants.js` | The controlled vocabularies: outcomes, postures, forums, contract types, platforms, doctrine gates, the US tile map. | Only to add a new *category* or *state*. |
| `validate.js` | Dev safety net, warns in the browser console if a record is malformed. | No. |
| `app.js` | The UI. | No. |

---

## Add one case (the 30-second version)

1. Open `data.js`.
2. Copy any existing `{ … }` object inside `PMLE.matters`.
3. Paste it at the **top** of the array (right after `PMLE.matters = [`).
4. Edit the fields. Give it a new, unique `id`.
5. Save. Reload the model page. Open the browser console; if anything is
   wrong, the validator prints `• <id>: <what's wrong>`. If it's silent, you're
   good.

That's it. The new matter immediately appears in every lens, the filters, the
search, the command palette (Cmd/Ctrl-K), and the simulator's analog matching.

---

## The fields

Every field is required unless noted. Allowed enum values are listed below;
anything else triggers a console warning naming the `id`.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Stable, unique slug (e.g. `"kalshi-cftc-2024"`). Never reuse. |
| `caption` | string | Short title shown everywhere. |
| `platform` | enum | `Kalshi` · `Polymarket` · `PredictIt` · `Other` |
| `parties` | array | `[{ name, role }, …]`, e.g. `{ name: "CFTC", role: "Regulator" }`. |
| `contractType` | enum | `Election` · `Sports` · `Economic indicator` · `Cultural` · `Other` |
| `forum` | enum | `CFTC` · `SEC` · `State gaming regulator` · `Federal court` · `State court` |
| `states` | array | USPS codes, e.g. `["NJ","NY"]`. Use `[]` for a purely federal matter. Every code must exist in `TILES` (see below) or it will not show on the map. |
| `statutes` | array | Strings, e.g. `["CEA §5c(c)", "7 U.S.C. §7a-2"]`. |
| `gate` | enum | The doctrine gate the matter turned on, see **Gates** below. |
| `doctrinalQuestion` | string | The one-line legal question it posed. |
| `posture` | enum | Current procedural stance: `Enjoined` · `Regulator action` · `Pending` · `Permitted` · `Settled` · `Dismissed`. Drives the **map** color. |
| `outcome` | enum | How it resolved: `Pending` · `Enjoined` · `Permitted` · `Settled` · `Dismissed`. Drives **timeline / network / doctrine** color. |
| `filedDate` | string | ISO `YYYY-MM-DD`. |
| `decidedDate` | string \| null | ISO `YYYY-MM-DD`, or `null` if ongoing. |
| `summary` | string | One to three sentences. |
| `sources` | array | Strings: citations, docket numbers, or links. Shown under "Reading & sources". |

> **Posture vs. outcome.** `posture` is *where the matter stands now* (used to
> paint the map); `outcome` is *how it came out* (used to color the dots and
> flows). A matter can be `posture: "Regulator action"` while `outcome:
> "Pending"`.

---

## Gates: how the `gate` field maps to the Doctrine Flow lens

The Doctrine lens lays out four classification gates left to right. Set `gate`
to the one where the matter **actually turned**:

| `gate` | Question it represents | Use when… |
| --- | --- | --- |
| `swap` | *Is it a swap under the CEA / within CFTC jurisdiction?* | The fight was about unregistered swaps / event contracts offered off a designated exchange. |
| `special` | *Does the special rule on enumerated / "gaming" activity bar it?* | The fight was the gaming / election-contract / state-wagering question (the most common bucket). |
| `cleared` | *Cleared / permitted to list.* | It got past the gates, e.g. a downstream disclosure / consumer claim, not a classification fight. |

---

## Add a new state to the map

States are placed on a tile cartogram in `constants.js` → `TILES`, as
`USPS: [row, col]`. To make a new state appear, add one line, e.g.:

```js
PR: [8, 9],   // pick an empty [row, col] slot
```

Until a state is in `TILES`, any matter using it will be flagged by the
validator and will not appear on the map (it still appears in every other lens).

## Add a new category (forum, contract type, platform, outcome…)

All controlled vocabularies live in `constants.js`:

- new **forum** → add to `FORUMS`
- new **contract type** → add to `CTYPES`
- new **platform** → add to `PLATFORMS`
- new **outcome / posture** → add an entry to `OUT` / `POSTURE` with a color
  `c`, a soft glow `g` (for `OUT`), and a single-letter glyph `l` (so the UI
  never relies on color alone)

The filters, validation enums, and legends all read from these lists, so one
edit keeps everything in sync.

---

## Go live: replace all sample data

The 12 matters in `data.js` are clearly-marked **placeholders**. When your real
data is ready:

1. In `data.js`, delete every object inside `PMLE.matters = [ … ]` and paste in
   your real ones.
2. Change `PMLE.SAMPLE_DATA = true;` to `PMLE.SAMPLE_DATA = false;`.

That second step makes the yellow **"SAMPLE DATA"** banner on the page
disappear on its own, no other change needed.

---

## Scale & performance

The current implementation re-renders the active lens on each interaction and
runs the network graph with a lightweight force simulation, comfortable into
the low hundreds of matters. If you grow well beyond that and notice the
timeline or network getting heavy, the place to optimize first is
**virtualizing the timeline** and **capping / clustering network nodes**;
filtering and the map/matrix scale fine because they aggregate. This is noted in
`app.js` near the network code.
