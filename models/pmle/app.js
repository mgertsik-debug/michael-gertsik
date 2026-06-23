/* ============================================================================
 *  PREDICTION MARKET LITIGATION EXPLORER  ·  APP  (UI only)
 *  ---------------------------------------------------------------------------
 *  A faithful, dependency-free port of the Claude Design export. It reads ONLY
 *  from PMLE.matters + PMLE.constants - there is no case data in this file.
 *
 *  The original used React.createElement; this uses a tiny `h()` hyperscript
 *  that emits real DOM (SVG-aware). State lives in a plain object; mutating it
 *  through set()/setLens()/etc. re-renders. Two things are optimized to avoid
 *  full re-renders for smoothness: the force-graph animation (mutates SVG
 *  attributes in a rAF loop) and the hover tooltip (a single fixed element).
 * ========================================================================== */
(function () {
  "use strict";
  const C = window.PMLE.constants;
  const DATA = window.PMLE.matters;
  const yearOf = window.PMLE.yearOf;
  const {
    OUT, POSTURE, POST_PRIORITY, PLATFORMS, CTYPES, FORUMS,
    GATE_ORDER, DOCTRINE_STATIONS, TILES, YEAR_MIN, YEAR_MAX,
  } = C;

  const MONO = "var(--pmle-mono)";
  const SANS = "var(--pmle-sans)";

  /* ---------------------------------------------------------------- h() --- */
  const SVG_TAGS = new Set(["svg", "g", "rect", "circle", "line", "path", "text"]);
  const SVG_ATTR = {
    strokeWidth: "stroke-width", strokeOpacity: "stroke-opacity",
    fillOpacity: "fill-opacity", strokeDasharray: "stroke-dasharray",
    textAnchor: "text-anchor", strokeLinecap: "stroke-linecap",
  };
  const EVT = {
    onClick: "click", onChange: "input", onInput: "input",
    onMouseEnter: "mouseenter", onMouseMove: "mousemove", onMouseLeave: "mouseleave",
    onMouseDown: "mousedown", onMouseUp: "mouseup", onKeyDown: "keydown",
  };
  function appendKids(el, kids) {
    for (const c of kids) {
      if (c == null || c === false || c === true) continue;
      if (Array.isArray(c)) { appendKids(el, c); continue; }
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
  }
  function h(tag, props, ...kids) {
    const isSvg = SVG_TAGS.has(tag);
    const el = isSvg ? document.createElementNS("http://www.w3.org/2000/svg", tag) : document.createElement(tag);
    if (props) for (const k in props) {
      const v = props[k];
      if (v == null || v === false || k === "key") continue;
      if (k === "style" && typeof v === "object") { for (const s in v) if (v[s] != null) el.style[s] = v[s]; continue; }
      if (k in EVT) { el.addEventListener(EVT[k], v); continue; }
      if (k === "className") { el.setAttribute("class", v); continue; }
      if (k === "htmlFor") { el.setAttribute("for", v); continue; }
      if (k === "value") { el.value = v; continue; }
      if (k === "checked" || k === "disabled") { el[k] = !!v; if (v) el.setAttribute(k, ""); continue; }
      if (k === "autoFocus") { el.setAttribute("data-autofocus", "1"); continue; }
      el.setAttribute(isSvg ? (SVG_ATTR[k] || k) : k, v);
    }
    appendKids(el, kids);
    return el;
  }
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); };
  const mount = (el, node) => { clear(el); appendKids(el, [node]); };

  /* ------------------------------------------------------------- state --- */
  const S = {
    appMode: "explore", lens: "map",
    search: "", platform: [], contractType: [], forum: [], states: [], outcome: [],
    yearMin: YEAR_MIN, yearMax: YEAR_MAX, scrubberYear: YEAR_MAX, playing: false,
    selectedId: null,
    showFilters: false, showCoach: true, showPalette: false, sourcesOpen: false,
    simStep: 0, simC: null, simF: null, simS: null, simH: null, simReason: false,
  };
  let els = {};       // mounted region refs
  let _play = null;   // scrubber interval
  let _raf = null;    // network rAF
  let _net = null;    // network graph
  let _drag = null;   // dragged node
  let _lastCount = 0;
  let _scrub = null;  // in-place scrubber updater for map/timeline (crossfade, no re-mount)

  function set(patch) {
    Object.assign(S, typeof patch === "function" ? patch(S) : patch);
    render();
  }
  function toggle(facet, val) {
    const a = S[facet];
    set({ [facet]: a.includes(val) ? a.filter((x) => x !== val) : [...a, val] });
  }
  function clearAll() {
    set({ search: "", platform: [], contractType: [], forum: [], states: [], outcome: [], yearMin: YEAR_MIN, yearMax: YEAR_MAX });
  }
  function select(id) { set({ selectedId: id, sourcesOpen: false }); }

  /* ----------------------------------------------------------- filter --- */
  function filtered() {
    const q = S.search.trim().toLowerCase();
    return DATA.filter((m) => {
      if (q) {
        const hay = [m.caption, m.summary, m.doctrinalQuestion, ...m.statutes, ...m.parties.map((p) => p.name)].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (S.platform.length && !S.platform.includes(m.platform)) return false;
      if (S.contractType.length && !S.contractType.includes(m.contractType)) return false;
      if (S.forum.length && !S.forum.includes(m.forum)) return false;
      if (S.outcome.length && !S.outcome.includes(m.outcome)) return false;
      if (S.states.length && !m.states.some((x) => S.states.includes(x))) return false;
      const y = yearOf(m.filedDate);
      if (y < S.yearMin || y > S.yearMax) return false;
      return true;
    });
  }
  const revealed = (list) => list.filter((m) => yearOf(m.filedDate) <= S.scrubberYear);

  function activePills() {
    const p = [];
    ["platform", "contractType", "forum", "states", "outcome"].forEach((f) => S[f].forEach((v) => p.push({ f, v })));
    if (S.yearMin !== YEAR_MIN || S.yearMax !== YEAR_MAX) p.push({ f: "year", v: `${S.yearMin}–${S.yearMax}` });
    return p;
  }

  /* ===================================================================== */
  /*  RENDER                                                               */
  /* ===================================================================== */
  function render() {
    mount(els.mode, modeToggle());
    mount(els.body, S.appMode === "explore" ? explore() : simulate());
    mount(els.overlays, [S.showCoach ? coach() : null, S.showPalette ? palette() : null]);
    // restore caret on the text inputs after rebuild
    const af = els.root.querySelector("[data-autofocus]");
    if (af) { af.focus(); const n = af.value.length; try { af.setSelectionRange(n, n); } catch (e) {} }
  }

  /* ---------- mode toggle ---------- */
  function modeToggle() {
    const btn = (id, label) => h("button", {
      onClick: () => set({ appMode: id }), "aria-pressed": S.appMode === id ? "true" : "false",
      style: { font: `600 11px ${MONO}`, letterSpacing: ".12em", padding: "6px 13px", borderRadius: "8px", cursor: "pointer",
        border: "1px solid " + (S.appMode === id ? "rgba(52,211,153,.5)" : "rgba(255,255,255,.08)"),
        background: S.appMode === id ? "rgba(52,211,153,.14)" : "transparent",
        color: S.appMode === id ? "#6EE7B7" : "#9CA3AF", transition: "all .18s" },
    }, label);
    return h("div", { role: "tablist", "aria-label": "Mode", style: { display: "flex", gap: "6px", padding: "3px", borderRadius: "10px", background: "rgba(255,255,255,.025)", border: "1px solid rgba(255,255,255,.05)" } },
      btn("explore", "EXPLORE"), btn("simulate", "SIMULATE"));
  }

  /* ================= EXPLORE ================= */
  function explore() {
    const list = filtered();
    const reveal = revealed(list);
    const revIds = new Set(reveal.map((m) => m.id));
    const sel = DATA.find((m) => m.id === S.selectedId) || null;

    const lensbox = h("div", { id: "pmle-lensbox", role: "region", "aria-label": "Lens view",
      style: { position: "relative", borderRadius: "14px", border: "1px solid rgba(255,255,255,.06)", background: "rgba(17,22,21,.4)", padding: "16px", minHeight: "430px", overflow: "hidden" } });
    els.lensbox = lensbox;

    const grid = h("div", { style: { display: "grid", gridTemplateColumns: "minmax(0,1fr) 318px", gap: "16px", marginTop: "14px", alignItems: "start" }, className: "pmle-grid" },
      h("div", { style: { minWidth: "0" } },
        lensbox,
        (S.lens === "map" || S.lens === "timeline") ? scrubber(reveal) : null),
      context(sel));

    const node = h("div", { style: { padding: "18px 18px 22px" } },
      commandBar(list), facetPanel(), lensTabs(), grid);

    // fill the lens box now that it exists in the tree
    renderLens();
    if (S.lens === "network") startNet();
    return node;
  }

  function renderLens() {
    if (!els.lensbox) return;
    _scrub = null;
    const list = filtered();
    const reveal = revealed(list);
    const revIds = new Set(reveal.map((m) => m.id));
    const L = S.lens;
    const inner = L === "map" ? mapLens(reveal)
      : L === "timeline" ? timelineLens(list, revIds)
      : L === "matrix" ? matrixLens(list)
      : L === "network" ? networkLens()
      : doctrineLens(list);
    mount(els.lensbox, h("div", { key: L, style: { animation: "pmleFade .3s ease" } }, inner));
  }

  function commandBar(list) {
    const pills = activePills(), nF = pills.length;
    return h("div", { style: { display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" } },
      h("div", { style: { position: "relative", flex: "1 1 280px", minWidth: "240px" } },
        h("span", { "aria-hidden": "true", style: { position: "absolute", left: "13px", top: "50%", transform: "translateY(-50%)", color: "#4B5563", fontSize: "15px" } }, "⚲"),
        h("input", { value: S.search, "aria-label": "Search matters, parties, statutes",
          onInput: (e) => set({ search: e.target.value }), placeholder: "Search matters, parties, statutes…",
          ...(document.activeElement && document.activeElement.id === "pmle-search" ? { autoFocus: true } : {}),
          id: "pmle-search",
          style: { width: "100%", padding: "11px 13px 11px 34px", borderRadius: "10px", border: "1px solid rgba(255,255,255,.09)", background: "rgba(255,255,255,.025)", color: "#E5E7EB", font: `500 13.5px ${SANS}`, outline: "none" } })),
      h("button", { onClick: () => set({ showFilters: !S.showFilters }), "aria-pressed": S.showFilters ? "true" : "false",
        style: { display: "flex", alignItems: "center", gap: "8px", padding: "10px 14px", borderRadius: "10px", cursor: "pointer",
          border: "1px solid " + (S.showFilters ? "rgba(52,211,153,.4)" : "rgba(255,255,255,.09)"),
          background: S.showFilters ? "rgba(52,211,153,.1)" : "rgba(255,255,255,.025)", color: S.showFilters ? "#6EE7B7" : "#D1D5DB", font: `600 12px ${MONO}`, letterSpacing: ".08em" } },
        "FILTERS", nF ? h("span", { style: { background: "#34D399", color: "#06231A", borderRadius: "20px", padding: "1px 7px", fontSize: "11px" } }, nF) : null),
      h("div", { style: { marginLeft: "auto", font: `600 12px ${MONO}`, letterSpacing: ".1em", color: "#6B7280" } },
        "[ ", h("span", { id: "pmle-count", style: { color: "#6EE7B7" } }, list.length), " matter", list.length === 1 ? "" : "s", " ]"),
      pills.length ? h("div", { style: { flexBasis: "100%", display: "flex", gap: "7px", flexWrap: "wrap", marginTop: "2px" } },
        pills.map((p, i) => h("button", { key: i, "aria-label": "Remove filter " + p.v,
          onClick: () => p.f === "year" ? set({ yearMin: YEAR_MIN, yearMax: YEAR_MAX }) : toggle(p.f, p.v),
          style: { display: "inline-flex", alignItems: "center", gap: "6px", padding: "4px 9px", borderRadius: "20px", cursor: "pointer", border: "1px solid rgba(52,211,153,.45)", background: "rgba(52,211,153,.08)", color: "#A7F3D0", font: `500 11.5px ${MONO}` } },
          p.v, h("span", { style: { color: "#6EE7B7" } }, "×"))),
        h("button", { onClick: clearAll, style: { padding: "4px 8px", borderRadius: "20px", cursor: "pointer", border: "1px solid rgba(255,255,255,.08)", background: "transparent", color: "#6B7280", font: `500 11px ${MONO}` } }, "clear all")) : null);
  }

  function facetGroup(label, facet, opts) {
    return h("div", { key: facet, style: { minWidth: "0" } },
      h("div", { style: { font: `500 10px ${MONO}`, letterSpacing: ".16em", color: "#6B7280", marginBottom: "8px" } }, label),
      h("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px" } },
        opts.map((o) => {
          const on = S[facet].includes(o);
          return h("button", { key: o, onClick: () => toggle(facet, o), "aria-pressed": on ? "true" : "false",
            style: { padding: "5px 10px", borderRadius: "7px", cursor: "pointer", font: `500 11.5px ${SANS}`, transition: "all .15s",
              border: "1px solid " + (on ? "rgba(52,211,153,.5)" : "rgba(255,255,255,.08)"),
              background: on ? "rgba(52,211,153,.13)" : "rgba(255,255,255,.02)", color: on ? "#A7F3D0" : "#9CA3AF" } }, o);
        })));
  }
  function facetPanel() {
    if (!S.showFilters) return null;
    const stOpts = [...new Set(DATA.flatMap((m) => m.states))].sort();
    return h("div", { style: { marginTop: "13px", padding: "16px", borderRadius: "12px", border: "1px solid rgba(255,255,255,.07)", background: "rgba(255,255,255,.018)", display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: "18px", animation: "pmleUp .25s ease" } },
      facetGroup("PLATFORM", "platform", PLATFORMS),
      facetGroup("CONTRACT TYPE", "contractType", CTYPES),
      facetGroup("FORUM", "forum", FORUMS),
      facetGroup("OUTCOME", "outcome", Object.keys(OUT)),
      facetGroup("STATE", "states", stOpts),
      h("div", null,
        h("div", { style: { font: `500 10px ${MONO}`, letterSpacing: ".16em", color: "#6B7280", marginBottom: "8px" } }, `YEAR FILED · ${S.yearMin}–${S.yearMax}`),
        h("input", { type: "range", min: YEAR_MIN, max: YEAR_MAX, value: S.yearMin, "aria-label": "Earliest year filed",
          onInput: (e) => set({ yearMin: Math.min(+e.target.value, S.yearMax) }), style: { width: "100%", accentColor: "#34D399" } }),
        h("input", { type: "range", min: YEAR_MIN, max: YEAR_MAX, value: S.yearMax, "aria-label": "Latest year filed",
          onInput: (e) => set({ yearMax: Math.max(+e.target.value, S.yearMin) }), style: { width: "100%", accentColor: "#34D399" } })));
  }

  function lensTabs() {
    const tabs = [["map", "MAP", "◉"], ["timeline", "TIMELINE", "─"], ["matrix", "MATRIX", "▦"], ["network", "NETWORK", "⁂"], ["doctrine", "DOCTRINE", "⇉"]];
    return h("div", { role: "tablist", "aria-label": "Lens", style: { display: "flex", gap: "4px", marginTop: "14px", padding: "4px", borderRadius: "11px", background: "rgba(255,255,255,.022)", border: "1px solid rgba(255,255,255,.05)", width: "fit-content", maxWidth: "100%", flexWrap: "wrap" } },
      tabs.map(([id, label, ic]) => {
        const on = S.lens === id;
        return h("button", { key: id, role: "tab", "aria-selected": on ? "true" : "false", onClick: () => setLens(id),
          style: { display: "flex", alignItems: "center", gap: "7px", padding: "7px 12px", borderRadius: "8px", cursor: "pointer", font: `600 10.5px ${MONO}`, letterSpacing: ".07em", whiteSpace: "nowrap", transition: "all .2s",
            border: "1px solid " + (on ? "rgba(52,211,153,.4)" : "transparent"),
            background: on ? "rgba(52,211,153,.13)" : "transparent", color: on ? "#6EE7B7" : "#9CA3AF",
            animation: on ? "pmlePulse 2.2s ease-in-out infinite" : "none" } },
          h("span", { "aria-hidden": "true", style: { fontSize: "13px", opacity: ".85" } }, ic), label);
      }));
  }
  function setLens(l) { stopNet(); set({ lens: l }); }

  /* ---------- MAP ---------- */
  function stateAgg(reveal) {
    const agg = {};
    reveal.forEach((m) => m.states.forEach((st) => {
      if (!agg[st]) agg[st] = { count: 0, postures: new Set(), matters: [] };
      agg[st].count++; agg[st].postures.add(m.posture); agg[st].matters.push(m);
    }));
    return agg;
  }
  function postureOf(a) {
    if (!a) return null;
    for (const p of POST_PRIORITY) if (a.postures.has(p)) return p;
    return null;
  }
  function mapLens(reveal) {
    const sz = 34, gap = 5, ox = 10, oy = 8;
    const liveAgg = () => stateAgg(revealed(filtered()));
    const refs = {};
    const cells = Object.entries(TILES).map(([st, [r, c]]) => {
      const x = ox + c * (sz + gap), y = oy + r * (sz + gap);
      const selOn = S.states.includes(st);
      // Animatable presentation set via CSS (style) so fill / fill-opacity crossfade.
      const rect = h("rect", { x, y, width: sz, height: sz, rx: 6,
        stroke: selOn ? "#6EE7B7" : "rgba(255,255,255,.07)", strokeWidth: selOn ? 1.6 : 1,
        style: { fill: "#131816", fillOpacity: "1", transition: "fill .4s ease, fill-opacity .4s ease" } });
      const label = h("text", { x: x + sz / 2, y: y + sz / 2 + 4, textAnchor: "middle",
        style: { font: `600 10px ${MONO}`, fill: "#3a4441", pointerEvents: "none", transition: "fill .4s ease" } }, st);
      const count = h("text", { x: x + sz - 5, y: y + 10, textAnchor: "end",
        style: { font: `600 8px ${MONO}`, fill: "#131816", pointerEvents: "none", opacity: "0", transition: "opacity .4s ease" } }, "");
      const g = h("g", { key: st, "data-st": st, style: { cursor: "default", transition: "filter .15s" },
        onMouseEnter: (e) => { const a = liveAgg()[st]; if (!a) return; const post = postureOf(a); showTip(e, st, [`${a.count} matter${a.count > 1 ? "s" : ""}`, post ? POSTURE[post].label : ""]); },
        onMouseMove: moveTip, onMouseLeave: hideTip,
        onClick: () => { const a = liveAgg()[st]; if (!a) return; if (!S.states.includes(st)) toggle("states", st); else select(a.matters[0].id); } },
        rect, label, count);
      refs[st] = { g, rect, label, count };
      return g;
    });
    // paint to the current year, in place; reused for every scrub tick (no re-mount = no blink)
    const applyMap = () => {
      const agg = stateAgg(revealed(filtered()));
      for (const st in refs) {
        const ref = refs[st], a = agg[st], post = postureOf(a), col = post ? POSTURE[post].c : "#131816";
        ref.rect.style.fill = a ? col : "#131816";
        ref.rect.style.fillOpacity = a ? String(0.18 + Math.min(a.count, 3) * 0.24) : "1";
        ref.label.style.fill = a ? "#ECFDF5" : "#3a4441";
        ref.g.style.cursor = a ? "pointer" : "default";
        ref.g.setAttribute("aria-label", a ? `${st}, ${a.count} matter${a.count > 1 ? "s" : ""}, ${post ? POSTURE[post].label : ""}` : st);
        if (a) ref.g.classList.add("pmle-cell"); else ref.g.classList.remove("pmle-cell");
        if (a && a.count > 1) { ref.count.textContent = a.count; ref.count.style.fill = col; ref.count.style.opacity = "1"; }
        else ref.count.style.opacity = "0";
      }
    };
    applyMap();
    _scrub = applyMap;
    return h("div", null,
      lensHeader("UNITED STATES · POSTURE BY STATE", "This area of law is fought state-by-state. Color = current posture."),
      h("svg", { viewBox: "0 0 440 322", role: "img", "aria-label": "US cartogram colored by posture", style: { width: "100%", maxWidth: "560px", margin: "4px auto 0", display: "block" } }, cells),
      legend([["Permitted", "#34D399"], ["Pending", "#FBBF24"], ["Regulator action", "#FB923C"], ["Enjoined", "#F87171"], ["Settled", "#60A5FA"], ["Silent", "#1b211f"]]));
  }

  /* ---------- TIMELINE ---------- */
  function timelineLens(list, revIds) {
    const W = 680, padL = 120, padR = 20, y0 = 44, laneH = 58;
    const x = (y) => padL + ((y - YEAR_MIN) / (YEAR_MAX - YEAR_MIN)) * (W - padL - padR);
    const grid = [];
    for (let yr = YEAR_MIN; yr <= YEAR_MAX; yr += 2) grid.push(h("g", { key: yr },
      h("line", { x1: x(yr), y1: 30, x2: x(yr), y2: y0 + FORUMS.length * laneH - 18, stroke: "rgba(255,255,255,.05)" }),
      h("text", { x: x(yr), y: 22, textAnchor: "middle", style: { font: `500 10px ${MONO}`, fill: "#4B5563" } }, yr)));
    const nodeRefs = [];
    const lanes = FORUMS.map((f) => {
      const cy = y0 + FORUMS.indexOf(f) * laneH + laneH / 2;
      const nodes = list.filter((m) => m.forum === f).map((m) => {
        const on = revIds.has(m.id), oc = OUT[m.outcome], selOn = S.selectedId === m.id;
        // opacity lives in CSS (style) so it crossfades via the transition below instead of snapping
        const g = h("g", { key: m.id, className: "pmle-node", "data-sel": selOn ? "1" : null,
          style: { cursor: "pointer", transition: "opacity .4s ease", opacity: on ? "1" : "0.18" },
          onMouseEnter: (e) => showTip(e, m.caption, [oc.label + " · " + yearOf(m.filedDate)]),
          onMouseMove: moveTip, onMouseLeave: hideTip, onClick: () => select(m.id) },
          h("circle", { cx: x(yearOf(m.filedDate)), cy, r: 6, fill: oc.c, stroke: selOn ? "#fff" : "rgba(0,0,0,.3)", strokeWidth: selOn ? 1.5 : 1 }),
          h("text", { x: x(yearOf(m.filedDate)), y: cy + 3, textAnchor: "middle", style: { font: `700 7px ${MONO}`, fill: "#06120e", pointerEvents: "none" } }, oc.l));
        nodeRefs.push({ g, id: m.id });
        return g;
      });
      return h("g", { key: f },
        h("line", { x1: padL, y1: cy, x2: W - padR, y2: cy, stroke: "rgba(255,255,255,.04)" }),
        h("text", { x: 14, y: cy + 3, style: { font: `500 9.5px ${MONO}`, fill: "#9CA3AF", letterSpacing: ".04em" } }, f),
        nodes);
    });
    // crossfade matters in/out as the scrubber moves, in place (no re-mount = no blink)
    _scrub = () => {
      const rev = new Set(revealed(filtered()).map((m) => m.id));
      nodeRefs.forEach(({ g, id }) => { g.style.opacity = rev.has(id) ? "1" : "0.18"; });
    };
    return h("div", null,
      lensHeader("TIME SPINE · BY FORUM", "Each matter sits at its filing date, lane = forum, color = outcome."),
      h("svg", { viewBox: `0 0 ${W} ${y0 + FORUMS.length * laneH}`, role: "img", "aria-label": "Timeline of matters by forum", style: { width: "100%", marginTop: "2px" } }, grid, lanes),
      outcomeLegend());
  }

  /* ---------- MATRIX ---------- */
  function matrixLens(list) {
    const max = Math.max(1, ...CTYPES.flatMap((ct) => FORUMS.map((f) => list.filter((m) => m.contractType === ct && m.forum === f).length)));
    return h("div", null,
      lensHeader("HEAT GRID · CONTRACT × FORUM", "Cell intensity = matter volume. Click a cell to drill in."),
      h("div", { style: { overflowX: "auto", marginTop: "4px" } },
        h("table", { style: { borderCollapse: "separate", borderSpacing: "6px", margin: "0 auto" } },
          h("thead", null, h("tr", null, h("th", null), FORUMS.map((f) => h("th", { key: f, style: { padding: "0 4px 8px", font: `500 9.5px ${MONO}`, color: "#9CA3AF", letterSpacing: ".05em", verticalAlign: "bottom", maxWidth: "84px" } }, f)))),
          h("tbody", null, CTYPES.map((ct) => h("tr", { key: ct },
            h("td", { style: { font: `500 11px ${MONO}`, color: "#D1D5DB", paddingRight: "10px", textAlign: "right", whiteSpace: "nowrap" } }, ct),
            FORUMS.map((f) => {
              const cell = list.filter((m) => m.contractType === ct && m.forum === f);
              const n = cell.length, t = n / max, on = n > 0;
              const wins = cell.filter((m) => m.outcome === "Permitted").length, loses = cell.filter((m) => m.outcome === "Enjoined").length;
              const tilt = wins > loses ? "#34D399" : loses > wins ? "#F87171" : "#FBBF24";
              return h("td", { key: f, onClick: on ? () => { set({ contractType: [ct], forum: [f] }); if (cell[0]) select(cell[0].id); } : null,
                role: on ? "button" : null, "aria-label": on ? `${ct} in ${f}, ${n} matter${n > 1 ? "s" : ""}` : null,
                className: on ? "pmle-mcell" : "",
                style: { width: "74px", height: "54px", borderRadius: "9px", cursor: on ? "pointer" : "default", textAlign: "center", verticalAlign: "middle",
                  background: on ? `rgba(52,211,153,${0.08 + t * 0.34})` : "rgba(255,255,255,.015)",
                  border: "1px solid " + (on ? tilt + "66" : "rgba(255,255,255,.04)"), transition: "transform .15s" } },
                on ? h("div", null, h("div", { style: { font: `700 17px ${MONO}`, color: "#ECFDF5" } }, n),
                  h("div", { style: { width: "18px", height: "3px", borderRadius: "2px", background: tilt, margin: "3px auto 0" } })) : h("span", { style: { color: "#374151" } }, "·"));
            })))))));
  }

  /* ---------- NETWORK ---------- */
  function buildNet(list) {
    const map = {}, nodes = [], edges = [];
    const add = (id, type) => { if (!map[id]) { map[id] = { id, type, deg: 0, x: 330 + Math.cos(nodes.length) * 120, y: 170 + Math.sin(nodes.length * 1.7) * 100, vx: 0, vy: 0 }; nodes.push(map[id]); } return map[id]; };
    list.forEach((m) => { const a = add(m.platform, "platform"); const b = add(m.forum, "forum"); a.deg++; b.deg++; edges.push({ a, b, c: OUT[m.outcome].c, m }); });
    _net = { nodes, edges };
  }
  function networkLens() {
    buildNet(revealed(filtered()));
    const W = 660, H = 360;
    const svg = h("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Force-directed entity graph", style: { width: "100%", marginTop: "2px", cursor: "default" },
      onMouseMove: (e) => { if (!_drag) return; const r = e.currentTarget.getBoundingClientRect(); _drag.x = (e.clientX - r.left) * (W / r.width); _drag.y = (e.clientY - r.top) * (H / r.height); _drag.vx = 0; _drag.vy = 0; },
      onMouseUp: () => { _drag = null; }, onMouseLeave: () => { _drag = null; } });
    _net.edges.forEach((e) => { const ln = h("line", { x1: e.a.x, y1: e.a.y, x2: e.b.x, y2: e.b.y, stroke: e.c, strokeOpacity: 0.4, strokeWidth: 1.4 }); e._line = ln; svg.appendChild(ln); });
    _net.nodes.forEach((n) => {
      const plat = n.type === "platform", rad = 12 + Math.min(n.deg, 5) * 2.4;
      const circ = h("circle", { cx: n.x, cy: n.y, r: rad, fill: plat ? "rgba(52,211,153,.18)" : "rgba(251,191,36,.14)", stroke: plat ? "#34D399" : "#FBBF24", strokeWidth: 1.6 });
      const txt = h("text", { x: n.x, y: n.y - rad - 6, textAnchor: "middle", style: { font: `600 10px ${MONO}`, fill: plat ? "#6EE7B7" : "#FCD34D", pointerEvents: "none" } }, n.id);
      n._c = circ; n._t = txt; n._r = rad;
      const g = h("g", { key: n.id, style: { cursor: "grab" }, onMouseDown: () => { _drag = n; } }, circ, txt);
      svg.appendChild(g);
    });
    return h("div", null,
      lensHeader("FORCE GRAPH · ENTITIES & ACTIONS", "A list tells you which cases exist. This picture shows you the shape of the whole fight. In a single glance, you can spot which platform is most embattled. Just look for the biggest dot with the most lines running to it. You can also see which regulators are pressing hardest, and whether a given matchup tends to end in wins or losses. It answers \"who's tangled up with whom, and how is it going?\" far faster than reading every case one by one."),
      svg,
      h("div", { style: { display: "flex", gap: "18px", justifyContent: "center", marginTop: "6px", font: `500 10px ${MONO}`, color: "#6B7280" } },
        h("span", null, h("span", { style: { color: "#34D399" } }, "●"), " platform"),
        h("span", null, h("span", { style: { color: "#FBBF24" } }, "●"), " forum")));
  }
  function tick() {
    const net = _net; if (!net) return;
    const N = net.nodes, W = 660, H = 360, cx = W / 2, cy = H / 2;
    for (let i = 0; i < N.length; i++) {
      const a = N[i];
      for (let j = i + 1; j < N.length; j++) {
        const b = N[j];
        let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy || 1, d = Math.sqrt(d2);
        const rep = 2600 / d2, ux = dx / d, uy = dy / d;
        a.vx += ux * rep; a.vy += uy * rep; b.vx -= ux * rep; b.vy -= uy * rep;
      }
      a.vx += (cx - a.x) * 0.004; a.vy += (cy - a.y) * 0.004;
    }
    net.edges.forEach((e) => { const a = e.a, b = e.b; let dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1; const f = (d - 130) * 0.012, ux = dx / d, uy = dy / d; a.vx += ux * f; a.vy += uy * f; b.vx -= ux * f; b.vy -= uy * f; });
    N.forEach((n) => { if (n === _drag) return; n.vx *= 0.86; n.vy *= 0.86; n.x += n.vx; n.y += n.vy; n.x = Math.max(40, Math.min(W - 40, n.x)); n.y = Math.max(34, Math.min(H - 34, n.y)); });
    net.edges.forEach((e) => { e._line.setAttribute("x1", e.a.x); e._line.setAttribute("y1", e.a.y); e._line.setAttribute("x2", e.b.x); e._line.setAttribute("y2", e.b.y); });
    N.forEach((n) => { n._c.setAttribute("cx", n.x); n._c.setAttribute("cy", n.y); n._t.setAttribute("x", n.x); n._t.setAttribute("y", n.y - n._r - 6); });
    _raf = requestAnimationFrame(tick);
  }
  function startNet() { stopNet(); _raf = requestAnimationFrame(tick); }
  function stopNet() { if (_raf) cancelAnimationFrame(_raf); _raf = null; _drag = null; }

  /* ---------- DOCTRINE ---------- */
  function doctrineLens(list) {
    const gates = DOCTRINE_STATIONS;
    const W = 700, H = 360, colX = (i) => 60 + i * ((W - 100) / (gates.length - 1));
    const byGate = { swap: [], special: [], howey: [], cleared: [] };
    list.forEach((m) => { (byGate[m.gate] || byGate.special).push(m); });
    const flows = [], nodes = [];
    list.forEach((m) => {
      const gi = GATE_ORDER.indexOf(m.gate) + 1;
      const arr = byGate[m.gate] || byGate.special, idx = arr.indexOf(m);
      const y = 70 + idx * 30;
      const tx = colX(gi), ty = Math.min(y, H - 40);
      const oc = OUT[m.outcome], selOn = S.selectedId === m.id;
      const sx = colX(0), sy = H / 2;
      flows.push(h("path", { key: "p" + m.id, d: `M ${sx} ${sy} C ${(sx + tx) / 2} ${sy}, ${(sx + tx) / 2} ${ty}, ${tx} ${ty}`, fill: "none", stroke: oc.c, strokeOpacity: selOn ? 0.9 : 0.32, strokeWidth: selOn ? 2.4 : 1.4 }));
      nodes.push(h("g", { key: "n" + m.id, className: "pmle-node", "data-sel": selOn ? "1" : null, style: { cursor: "pointer" },
        onMouseEnter: (e) => showTip(e, m.caption, [m.doctrinalQuestion]), onMouseMove: moveTip, onMouseLeave: hideTip, onClick: () => select(m.id) },
        h("circle", { cx: tx, cy: ty, r: selOn ? 7 : 5, fill: oc.c, stroke: selOn ? "#fff" : "none", strokeWidth: 1.4 })));
    });
    const stations = gates.map(([id, label], i) => h("g", { key: id },
      h("line", { x1: colX(i), y1: 36, x2: colX(i), y2: H - 24, stroke: "rgba(255,255,255,.06)", strokeDasharray: i === 0 ? "0" : "3 4" }),
      label.split("\n").map((ln, j) => h("text", { key: j, x: colX(i), y: 26 + j * 11, textAnchor: "middle", style: { font: `500 9px ${MONO}`, fill: i === gates.length - 1 ? "#6EE7B7" : "#9CA3AF", letterSpacing: ".03em" } }, ln))));
    return h("div", null,
      lensHeader("DOCTRINE FLOW · CLASSIFICATION GATES", "Each matter stops at the gate where it actually turned. Color = outcome."),
      h("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Doctrine classification flow", style: { width: "100%", marginTop: "2px" } }, stations, flows, nodes),
      outcomeLegend());
  }

  /* ---------- shared bits ---------- */
  function lensHeader(t, sub) {
    return h("div", { style: { marginBottom: "6px" } },
      h("div", { style: { font: `600 11px ${MONO}`, letterSpacing: ".16em", color: "#A7F3D0" } }, t),
      h("div", { style: { font: `400 12px ${SANS}`, color: "#6B7280", marginTop: "3px" } }, sub));
  }
  function legend(items) {
    return h("div", { style: { display: "flex", gap: "14px", flexWrap: "wrap", justifyContent: "center", marginTop: "8px", font: `500 10px ${MONO}`, color: "#9CA3AF" } },
      items.map(([l, c], i) => h("span", { key: i, style: { display: "inline-flex", alignItems: "center", gap: "6px" } },
        h("span", { style: { width: "10px", height: "10px", borderRadius: "3px", background: c, opacity: c === "#1b211f" ? 1 : 0.55, border: "1px solid " + c } }), l)));
  }
  function outcomeLegend() { return legend(Object.keys(OUT).map((k) => [k, OUT[k].c])); }

  function scrubber(reveal) {
    return h("div", { style: { display: "flex", alignItems: "center", gap: "13px", marginTop: "12px", padding: "11px 15px", borderRadius: "12px", border: "1px solid rgba(255,255,255,.06)", background: "rgba(255,255,255,.02)" } },
      h("button", { id: "pmle-scrub-btn", onClick: togglePlay, "aria-label": S.playing ? "Pause timeline" : "Play timeline",
        style: { width: "34px", height: "34px", flexShrink: "0", borderRadius: "9px", cursor: "pointer", border: "1px solid rgba(52,211,153,.4)", background: "rgba(52,211,153,.12)", color: "#6EE7B7", fontSize: "13px", display: "flex", alignItems: "center", justifyContent: "center" } },
        S.playing ? "■" : "▶"),
      h("div", { id: "pmle-scrub-year", style: { font: `600 13px ${MONO}`, color: "#ECFDF5", width: "44px" } }, S.scrubberYear),
      h("input", { id: "pmle-scrub-slider", type: "range", min: YEAR_MIN, max: YEAR_MAX, value: S.scrubberYear, "aria-label": "Reveal matters up to year",
        onInput: (e) => scrub(+e.target.value), style: { flex: "1", accentColor: "#34D399" } }),
      h("div", { id: "pmle-reveal-n", style: { font: `500 10px ${MONO}`, letterSpacing: ".1em", color: "#6B7280" } }, reveal.length + " revealed"));
  }
  // Live scrub. Updates the map / timeline IN PLACE (CSS crossfade) instead of
  // re-mounting the lens, so years fade into each other rather than blinking.
  function setPlayBtn() { const b = document.getElementById("pmle-scrub-btn"); if (b) { b.textContent = S.playing ? "■" : "▶"; b.setAttribute("aria-label", S.playing ? "Pause timeline" : "Play timeline"); } }
  function scrub(yr, fromPlay) {
    S.scrubberYear = yr;
    if (!fromPlay && S.playing) { clearInterval(_play); S.playing = false; setPlayBtn(); }
    const yEl = document.getElementById("pmle-scrub-year"); if (yEl) yEl.textContent = yr;
    const sl = document.getElementById("pmle-scrub-slider"); if (sl && +sl.value !== yr) sl.value = yr;
    if (_scrub) _scrub(); else renderLens();
    const rn = document.getElementById("pmle-reveal-n"); if (rn) rn.textContent = revealed(filtered()).length + " revealed";
  }
  function togglePlay() {
    if (S.playing) { clearInterval(_play); S.playing = false; setPlayBtn(); return; }
    if (S.scrubberYear >= YEAR_MAX) scrub(YEAR_MIN);
    S.playing = true; setPlayBtn();
    _play = setInterval(() => {
      if (S.scrubberYear >= YEAR_MAX) { clearInterval(_play); S.playing = false; setPlayBtn(); return; }
      scrub(S.scrubberYear + 1, true);
    }, 650);
  }

  /* ---------- context panel ---------- */
  function context(sel) {
    const head = h("div", { style: { font: `600 11px ${MONO}`, letterSpacing: ".18em", color: "#A7F3D0", marginBottom: "14px" } }, "MATTER DETAIL");
    let body;
    if (!sel) {
      body = h("div", { style: { padding: "30px 6px", textAlign: "center" } },
        h("div", { style: { width: "42px", height: "42px", borderRadius: "11px", margin: "0 auto 14px", border: "1px dashed rgba(255,255,255,.14)", display: "flex", alignItems: "center", justifyContent: "center", color: "#4B5563", fontSize: "18px" } }, "◎"),
        h("div", { style: { font: `500 13.5px ${SANS}`, color: "#9CA3AF", lineHeight: "1.55" } }, "Hover or select anything to inspect it."),
        h("div", { style: { font: `400 12px ${SANS}`, color: "#6B7280", marginTop: "8px", lineHeight: "1.55" } }, "Your selection stays in sync across all five lenses."));
    } else {
      const oc = OUT[sel.outcome], po = POSTURE[sel.posture];
      const row = (k, v) => h("div", { key: k, style: { display: "flex", gap: "10px", padding: "7px 0", borderBottom: "1px solid rgba(255,255,255,.04)" } },
        h("div", { style: { font: `500 9.5px ${MONO}`, letterSpacing: ".1em", color: "#6B7280", width: "88px", flexShrink: "0", paddingTop: "1px" } }, k),
        h("div", { style: { font: `500 12.5px ${SANS}`, color: "#D1D5DB", flex: "1", lineHeight: "1.45" } }, v));
      body = h("div", null,
        h("div", { style: { font: `700 16px ${SANS}`, color: "#F3F4F6", lineHeight: "1.3", letterSpacing: "-.01em" } }, sel.caption),
        h("div", { style: { display: "flex", gap: "8px", marginTop: "12px", marginBottom: "14px" } },
          h("div", { style: { flex: "1", padding: "9px 11px", borderRadius: "10px", background: po.c + "1f", border: "1px solid " + po.c + "40" } },
            h("div", { style: { font: `500 9px ${MONO}`, letterSpacing: ".14em", color: "#9CA3AF" } }, "STATUS"),
            h("div", { style: { display: "flex", alignItems: "center", gap: "7px", marginTop: "5px" } },
              h("span", { style: { width: "9px", height: "9px", borderRadius: "50%", background: po.c } }),
              h("span", { style: { font: `600 12.5px ${SANS}`, color: "#F3F4F6" } }, po.label + " (" + po.l + ")"))),
          h("div", { style: { padding: "9px 11px", borderRadius: "10px", background: oc.g, border: "1px solid " + oc.c + "40", minWidth: "78px" } },
            h("div", { style: { font: `500 9px ${MONO}`, letterSpacing: ".14em", color: "#9CA3AF" } }, "OUTCOME"),
            h("div", { style: { font: `600 12.5px ${SANS}`, color: oc.c, marginTop: "5px" } }, oc.label + " (" + oc.l + ")"))),
        h("div", { style: { font: `400 12.5px ${SANS}`, color: "#9CA3AF", lineHeight: "1.55", marginBottom: "12px" } }, sel.summary),
        row("PARTIES", sel.parties.map((p, i) => h("div", { key: i }, h("span", { style: { color: "#E5E7EB" } }, p.name), h("span", { style: { color: "#6B7280" } }, " · " + p.role)))),
        row("PLATFORM", sel.platform),
        row("CONTRACT", sel.contractType),
        row("FORUM", sel.forum),
        row("STATES", sel.states.length ? sel.states.join(", ") : "None (federal)"),
        row("STATUTES", sel.statutes.join(" · ")),
        row("QUESTION", h("span", { style: { color: "#A7F3D0", fontStyle: "italic" } }, sel.doctrinalQuestion)),
        row("FILED", yearOf(sel.filedDate) + (sel.decidedDate ? "  →  decided " + yearOf(sel.decidedDate) : "  ·  ongoing")),
        h("button", { onClick: () => set({ sourcesOpen: !S.sourcesOpen }), "aria-expanded": S.sourcesOpen ? "true" : "false",
          style: { marginTop: "12px", width: "100%", display: "flex", alignItems: "center", gap: "8px", padding: "9px 11px", borderRadius: "9px", cursor: "pointer",
            border: "1px solid " + (S.sourcesOpen ? "rgba(52,211,153,.35)" : "rgba(255,255,255,.07)"), background: S.sourcesOpen ? "rgba(52,211,153,.07)" : "rgba(255,255,255,.02)", color: "#6EE7B7", font: `600 10.5px ${MONO}`, letterSpacing: ".1em" } },
          h("span", null, S.sourcesOpen ? "−" : "+"), " READING & SOURCES"),
        S.sourcesOpen ? h("div", { style: { padding: "10px 12px", animation: "pmleUp .2s ease" } },
          sel.sources.map((src, i) => h("div", { key: i, style: { font: `400 11.5px ${MONO}`, color: "#9CA3AF", padding: "4px 0", display: "flex", gap: "8px" } },
            h("span", { style: { color: "#34D399" } }, "›"), src))) : null);
    }
    return h("div", { className: "pmle-context", style: { position: "sticky", top: "14px", borderRadius: "14px", border: "1px solid rgba(255,255,255,.07)", background: "rgba(17,22,21,.55)", padding: "16px 16px 18px", maxHeight: "78vh", overflowY: "auto" } }, head, body);
  }

  /* ================= SIMULATE ================= */
  function simulate() {
    const steps = [
      { key: "simC", label: "CONTRACT TYPE", opts: CTYPES, desc: { Election: "Outcome of a government election or control of a chamber.", Sports: "Outcome of a sporting event or season.", "Economic indicator": "A macro print: CPI, rate decision, jobs.", Cultural: "Awards, entertainment, or pop-culture events.", Other: "Anything outside the above buckets." } },
      { key: "simF", label: "FORUM", opts: FORUMS, desc: { CFTC: "Commodity Futures Trading Commission action.", SEC: "Securities & Exchange Commission action.", "State gaming regulator": "A state board asserting gambling jurisdiction.", "Federal court": "Article III court (often preemption suits).", "State court": "State court enforcement or class claims." } },
      { key: "simS", label: "STATE", opts: ["DC", "NV", "NJ", "MD", "NY", "IL", "AZ", "CA", "TX"], desc: {} },
      { key: "simH", label: "STATUTORY HOOK", opts: ["CEA swap regulation", "State gaming / bucket-shop law", "Securities (Howey)", "Consumer protection / UDAP"], desc: { "CEA swap regulation": "Federal commodity-exchange framework & special rule.", "State gaming / bucket-shop law": "State prohibitions on wagering / chance.", "Securities (Howey)": "Investment-contract analysis under Howey.", "Consumer protection / UDAP": "Deception / unfair-practice theories." } },
    ];
    const cur = steps[S.simStep];
    const done = S.simStep >= 4;
    const frag = document.createDocumentFragment();

    const stepper = h("div", { style: { display: "flex", alignItems: "center", gap: "0", marginBottom: "24px" } },
      steps.map((st, i) => {
        const active = i === S.simStep, complete = i < S.simStep || done;
        return [
          h("div", { key: "s" + i, style: { display: "flex", flexDirection: "column", alignItems: "center", gap: "7px", minWidth: "90px" } },
            h("div", { style: { width: "34px", height: "34px", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", font: `600 13px ${MONO}`, transition: "all .25s",
              border: "1px solid " + (active ? "#34D399" : complete ? "rgba(52,211,153,.5)" : "rgba(255,255,255,.12)"),
              background: active ? "rgba(52,211,153,.18)" : complete ? "rgba(52,211,153,.1)" : "transparent",
              color: active || complete ? "#6EE7B7" : "#6B7280", boxShadow: active ? "0 0 0 4px rgba(52,211,153,.12)" : "none" } },
              complete && !active ? "✓" : i + 1),
            h("div", { style: { font: `500 9px ${MONO}`, letterSpacing: ".1em", color: active ? "#A7F3D0" : "#6B7280", textAlign: "center" } }, st.label),
            h("div", { style: { font: `500 10.5px ${SANS}`, color: "#9CA3AF", height: "12px" } }, S[st.key] || "")),
          i < steps.length - 1 ? h("div", { key: "l" + i, style: { flex: "1", height: "1px", background: i < S.simStep || done ? "rgba(52,211,153,.4)" : "rgba(255,255,255,.1)", margin: "0 -6px", marginBottom: "34px" } }) : null,
        ];
      }));

    const header = h("div", { style: { marginBottom: "6px" } },
      h("div", { style: { font: `600 11px ${MONO}`, letterSpacing: ".18em", color: "#34D399" } }, "BUILD A FACT PATTERN"),
      h("div", { style: { font: `400 13px ${SANS}`, color: "#9CA3AF", marginTop: "5px", maxWidth: "64ch" } }, "Pick a hypothetical and the model routes it through the doctrine, then surfaces the most analogous real matters and a predicted posture."));

    let panel;
    if (!done) {
      panel = h("div", { style: { display: "grid", gap: "10px", animation: "pmleFade .3s ease" } },
        cur.opts.map((o) => {
          const on = S[cur.key] === o;
          return h("button", { key: o, onClick: () => set({ [cur.key]: o }), "aria-pressed": on ? "true" : "false",
            style: { textAlign: "left", display: "flex", alignItems: "center", gap: "14px", padding: "14px 16px", borderRadius: "12px", cursor: "pointer", transition: "all .18s",
              border: "1px solid " + (on ? "rgba(52,211,153,.5)" : "rgba(255,255,255,.08)"), background: on ? "rgba(52,211,153,.09)" : "rgba(255,255,255,.02)" } },
            h("div", { style: { width: "20px", height: "20px", borderRadius: "50%", flexShrink: "0", border: "2px solid " + (on ? "#34D399" : "rgba(255,255,255,.2)"), display: "flex", alignItems: "center", justifyContent: "center" } },
              on ? h("div", { style: { width: "9px", height: "9px", borderRadius: "50%", background: "#34D399" } }) : null),
            h("div", { style: { flex: "1" } },
              h("div", { style: { font: `600 14.5px ${SANS}`, color: "#F3F4F6" } }, o),
              cur.desc[o] ? h("div", { style: { font: `400 12px ${SANS}`, color: "#9CA3AF", marginTop: "3px" } }, cur.desc[o]) : null),
            h("span", { style: { color: on ? "#6EE7B7" : "#4B5563", fontSize: "16px" } }, "→"));
        }));
    } else panel = simResult();

    const nav = h("div", { style: { display: "flex", gap: "10px", marginTop: "20px" } },
      S.simStep > 0 ? h("button", { onClick: () => set((x) => ({ simStep: Math.max(0, x.simStep - 1), simReason: false })),
        style: { padding: "11px 18px", borderRadius: "10px", cursor: "pointer", border: "1px solid rgba(255,255,255,.1)", background: "transparent", color: "#9CA3AF", font: `600 12px ${MONO}`, letterSpacing: ".06em" } }, "← BACK") : null,
      !done ? h("button", { disabled: !S[cur.key], onClick: () => set((x) => ({ simStep: x.simStep + 1 })),
        style: { marginLeft: "auto", padding: "11px 22px", borderRadius: "10px", cursor: S[cur.key] ? "pointer" : "not-allowed",
          border: "1px solid " + (S[cur.key] ? "rgba(52,211,153,.5)" : "rgba(255,255,255,.08)"),
          background: S[cur.key] ? "rgba(52,211,153,.16)" : "rgba(255,255,255,.02)", color: S[cur.key] ? "#6EE7B7" : "#4B5563", font: `600 12px ${MONO}`, letterSpacing: ".06em" } },
        S.simStep === 3 ? "PREDICT →" : "NEXT →")
        : h("button", { onClick: () => set({ simStep: 0, simC: null, simF: null, simS: null, simH: null, simReason: false }),
          style: { marginLeft: "auto", padding: "11px 22px", borderRadius: "10px", cursor: "pointer", border: "1px solid rgba(255,255,255,.1)", background: "transparent", color: "#9CA3AF", font: `600 12px ${MONO}`, letterSpacing: ".06em" } }, "↻ RESET"));

    appendKids(frag, [header, h("div", { style: { marginTop: "20px" } }, stepper), panel, nav]);
    return h("div", { style: { padding: "26px 26px 28px", maxWidth: "760px", margin: "0 auto" } }, frag);
  }

  function simResult() {
    const hookMap = { "CEA swap regulation": "CEA", "State gaming / bucket-shop law": "gaming", "Securities (Howey)": "Howey", "Consumer protection / UDAP": "UDAP" };
    const scored = DATA.map((m) => {
      let sc = 0;
      if (m.contractType === S.simC) sc += 3;
      if (m.forum === S.simF) sc += 3;
      if (m.states.includes(S.simS)) sc += 2;
      if (m.statutes.join(" ").includes(hookMap[S.simH]) || (m.gate === "special" && S.simH.includes("gaming"))) sc += 1;
      return { m, sc };
    }).filter((x) => x.sc > 0).sort((a, b) => b.sc - a.sc).slice(0, 3);

    let predicted = "Pending", why = "No close precedent: genuinely unsettled, expect contested litigation.";
    if (S.simF === "State gaming regulator" && S.simC === "Sports") { predicted = "Enjoined"; why = "State gaming boards are actively asserting jurisdiction over sports contracts; absent a preemption ruling, in-state offerings are being halted."; }
    else if (S.simH === "CEA swap regulation" && (S.simF === "Federal court" || S.simF === "CFTC") && (S.simC === "Election" || S.simC === "Economic indicator")) { predicted = "Permitted"; why = "Federal-exchange framework plus the special rule has, so far, sustained election and economic-indicator contracts against gaming challenges."; }
    else if (S.simH === "Securities (Howey)" || S.simF === "SEC") { predicted = "Pending"; why = "Howey treatment of outcome shares is unresolved; inquiries are open but no clear ruling yet."; }
    else if (scored.length) { const oc = scored[0].m.outcome; predicted = oc; why = "Driven by the closest analog in the dataset, which resolved " + oc.toLowerCase() + "."; }
    const po = OUT[predicted] || OUT.Pending;

    return h("div", { style: { animation: "pmleUp .35s ease" } },
      h("div", { style: { padding: "20px 22px", borderRadius: "14px", border: "1px solid " + po.c + "44", background: po.g } },
        h("div", { style: { font: `500 10px ${MONO}`, letterSpacing: ".16em", color: "#9CA3AF" } }, "PREDICTED POSTURE"),
        h("div", { style: { display: "flex", alignItems: "center", gap: "12px", marginTop: "10px" } },
          h("span", { style: { width: "14px", height: "14px", borderRadius: "50%", background: po.c, boxShadow: "0 0 0 5px " + po.c + "22" } }),
          h("div", { style: { font: `800 26px ${SANS}`, color: "#F3F4F6", letterSpacing: "-.02em" } }, predicted + " (" + po.l + ")")),
        h("div", { style: { font: `400 13px ${SANS}`, color: "#D1D5DB", marginTop: "10px", lineHeight: "1.55", maxWidth: "62ch" } }, why)),
      h("div", { style: { font: `500 10px ${MONO}`, letterSpacing: ".16em", color: "#6B7280", margin: "22px 0 10px" } }, "MOST ANALOGOUS MATTERS"),
      scored.length ? h("div", { style: { display: "grid", gap: "9px" } }, scored.map(({ m, sc }) => {
        const oc = OUT[m.outcome];
        return h("button", { key: m.id, onClick: () => set({ appMode: "explore", selectedId: m.id }),
          style: { textAlign: "left", width: "100%", padding: "13px 15px", borderRadius: "11px", border: "1px solid rgba(255,255,255,.08)", background: "rgba(255,255,255,.02)", cursor: "pointer" } },
          h("div", { style: { display: "flex", alignItems: "center", gap: "10px" } },
            h("span", { style: { width: "9px", height: "9px", borderRadius: "50%", background: oc.c, flexShrink: "0" } }),
            h("div", { style: { font: `600 14px ${SANS}`, color: "#F3F4F6", flex: "1" } }, m.caption),
            h("div", { style: { font: `500 10px ${MONO}`, color: "#6B7280" } }, "match " + sc)),
          h("div", { style: { font: `400 12px ${SANS}`, color: "#9CA3AF", marginTop: "6px", paddingLeft: "19px", lineHeight: "1.5" } },
            m.contractType + " · " + m.forum + (m.states.length ? " · " + m.states.join(",") : "") + " · " + oc.label));
      })) : h("div", { style: { font: `400 12.5px ${SANS}`, color: "#6B7280", padding: "8px 0" } }, "No analogous matters in the sample set; this fact pattern is novel."),
      h("button", { onClick: () => set({ simReason: !S.simReason }), "aria-expanded": S.simReason ? "true" : "false",
        style: { marginTop: "12px", width: "100%", display: "flex", gap: "8px", padding: "10px 12px", borderRadius: "9px", cursor: "pointer", border: "1px solid " + (S.simReason ? "rgba(52,211,153,.35)" : "rgba(255,255,255,.07)"), background: S.simReason ? "rgba(52,211,153,.06)" : "transparent", color: "#6EE7B7", font: `600 10.5px ${MONO}`, letterSpacing: ".1em" } },
        h("span", null, S.simReason ? "−" : "+"), " CASE LAW & REASONING"),
      S.simReason ? h("div", { style: { padding: "12px 14px", font: `400 12.5px ${SANS}`, color: "#9CA3AF", lineHeight: "1.6", animation: "pmleUp .2s ease" } },
        "The hypothetical routes through the swap test, then the special rule on enumerated / gaming activities, then Howey. With your hook (",
        h("span", { style: { color: "#A7F3D0" } }, S.simH), "), the controlling question is whether ",
        h("span", { style: { color: "#A7F3D0" } }, String(S.simC).toLowerCase()), " contracts in a ", h("span", { style: { color: "#A7F3D0" } }, String(S.simF).toLowerCase()),
        " clear that gate. The analogs above are the matters that turned on the same question. ",
        h("span", { style: { color: "#6B7280" } }, "(Sample reasoning over placeholder data.)")) : null);
  }

  /* ---------- overlays ---------- */
  function coach() {
    const steps = [["01", "Filter once", "Use search + facets to shape one result set, and the count updates live."], ["02", "Pick a lens", "Five synchronized views of the same matters: map, timeline, matrix, network, doctrine."], ["03", "Inspect & predict", "Select anything to populate MATTER DETAIL, or switch to Simulate to test a fact pattern."]];
    return h("div", { style: { position: "absolute", inset: "0", background: "rgba(6,9,8,.74)", backdropFilter: "blur(3px)", zIndex: "30", display: "flex", alignItems: "center", justifyContent: "center", animation: "pmleFade .25s ease" } },
      h("div", { role: "dialog", "aria-label": "How to read this", style: { maxWidth: "520px", margin: "20px", padding: "26px 26px 22px", borderRadius: "16px", border: "1px solid rgba(52,211,153,.22)", background: "linear-gradient(180deg,rgba(20,28,25,.96),rgba(11,16,14,.98))", boxShadow: "0 30px 70px -20px rgba(0,0,0,.8)" } },
        h("div", { style: { font: `600 11px ${MONO}`, letterSpacing: ".18em", color: "#34D399" } }, "HOW TO READ THIS"),
        h("div", { style: { display: "grid", gap: "14px", margin: "18px 0 20px" } }, steps.map(([n, t, d]) =>
          h("div", { key: n, style: { display: "flex", gap: "14px" } },
            h("div", { style: { width: "30px", height: "30px", flexShrink: "0", borderRadius: "8px", border: "1px solid rgba(52,211,153,.4)", background: "rgba(52,211,153,.1)", color: "#6EE7B7", display: "flex", alignItems: "center", justifyContent: "center", font: `600 12px ${MONO}` } }, n),
            h("div", null, h("div", { style: { font: `600 14px ${SANS}`, color: "#F3F4F6" } }, t), h("div", { style: { font: `400 12.5px ${SANS}`, color: "#9CA3AF", marginTop: "2px", lineHeight: "1.5" } }, d))))),
        h("button", { onClick: () => set({ showCoach: false }),
          style: { width: "100%", padding: "11px", borderRadius: "10px", cursor: "pointer", border: "1px solid rgba(52,211,153,.5)", background: "rgba(52,211,153,.16)", color: "#6EE7B7", font: `600 12px ${MONO}`, letterSpacing: ".08em" } }, "GOT IT →")));
  }

  function palette() {
    const q = S.search.toLowerCase();
    const hits = DATA.filter((m) => !q || m.caption.toLowerCase().includes(q) || m.parties.some((p) => p.name.toLowerCase().includes(q))).slice(0, 7);
    return h("div", { style: { position: "absolute", inset: "0", background: "rgba(6,9,8,.6)", backdropFilter: "blur(2px)", zIndex: "40", display: "flex", justifyContent: "center", paddingTop: "80px", animation: "pmleFade .15s ease" }, onClick: () => set({ showPalette: false }) },
      h("div", { onClick: (e) => e.stopPropagation(), role: "dialog", "aria-label": "Jump to a matter", style: { width: "min(560px,90%)", height: "fit-content", borderRadius: "14px", border: "1px solid rgba(255,255,255,.12)", background: "rgba(16,21,19,.98)", boxShadow: "0 30px 70px -20px rgba(0,0,0,.85)", overflow: "hidden" } },
        h("div", { style: { display: "flex", alignItems: "center", gap: "10px", padding: "14px 16px", borderBottom: "1px solid rgba(255,255,255,.07)" } },
          h("span", { style: { color: "#34D399" } }, "⚲"),
          h("input", { autoFocus: true, value: S.search, "aria-label": "Jump to a matter", onInput: (e) => set({ search: e.target.value }), placeholder: "Jump to a matter…",
            style: { flex: "1", background: "transparent", border: "none", outline: "none", color: "#E5E7EB", font: `500 14px ${SANS}` } }),
          h("span", { style: { font: `500 10px ${MONO}`, color: "#4B5563", border: "1px solid rgba(255,255,255,.1)", borderRadius: "5px", padding: "2px 6px" } }, "ESC")),
        h("div", { style: { padding: "6px", maxHeight: "340px", overflowY: "auto" } },
          hits.length ? hits.map((m) => {
            const oc = OUT[m.outcome];
            return h("button", { key: m.id, onClick: () => set({ selectedId: m.id, showPalette: false, appMode: "explore" }),
              style: { width: "100%", textAlign: "left", display: "flex", alignItems: "center", gap: "11px", padding: "10px 12px", borderRadius: "9px", cursor: "pointer", border: "none", background: "transparent", color: "#E5E7EB" } },
              h("span", { style: { width: "8px", height: "8px", borderRadius: "50%", background: oc.c, flexShrink: "0" } }),
              h("span", { style: { flex: "1", font: `500 13.5px ${SANS}` } }, m.caption),
              h("span", { style: { font: `500 10px ${MONO}`, color: "#6B7280" } }, m.forum));
          }) : h("div", { style: { padding: "18px", textAlign: "center", color: "#6B7280", font: `500 13px ${SANS}` } }, "No matches"))));
  }

  /* ---------- tooltip (single fixed element, no re-render on hover) ---- */
  let _tip = null;
  function ensureTip() {
    if (_tip) return _tip;
    _tip = document.createElement("div");
    _tip.id = "pmle-tip";
    _tip.style.cssText = "position:fixed;z-index:60;pointer-events:none;max-width:260px;padding:9px 12px;border-radius:9px;border:1px solid rgba(52,211,153,.3);background:rgba(10,14,13,.97);box-shadow:0 12px 30px -10px rgba(0,0,0,.8);display:none";
    document.body.appendChild(_tip);
    return _tip;
  }
  function showTip(e, title, lines) {
    const t = ensureTip();
    clear(t);
    t.appendChild(h("div", { style: { font: `600 12.5px ${SANS}`, color: "#F3F4F6", lineHeight: "1.3" } }, title));
    (lines || []).filter(Boolean).forEach((l) => t.appendChild(h("div", { style: { font: `500 11px ${MONO}`, color: "#9CA3AF", marginTop: "3px" } }, l)));
    t.style.display = "block";
    moveTip(e);
  }
  function moveTip(e) { if (!_tip) return; _tip.style.left = e.clientX + 14 + "px"; _tip.style.top = e.clientY + 14 + "px"; }
  function hideTip() { if (_tip) _tip.style.display = "none"; }

  /* ---------------------------------------------------------- boot ----- */
  function boot() {
    const root = document.getElementById("pmle-root");
    els = {
      root,
      mode: document.getElementById("pmle-modetoggle"),
      body: document.getElementById("pmle-appbody"),
      overlays: document.getElementById("pmle-overlays"),
    };
    // breadcrumb: talk to the parent SPA frame
    const back = document.getElementById("pmle-back");
    if (back) back.addEventListener("click", (e) => {
      e.preventDefault();
      try { window.parent.postMessage({ type: "pmle-navigate", to: "/models" }, "*"); } catch (err) {}
      try { if (window.parent && window.parent !== window) window.parent.location.hash = "#models"; } catch (err) {}
    });
    window.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); set({ showPalette: !S.showPalette }); }
      if (e.key === "Escape") { hideTip(); if (S.showPalette) set({ showPalette: false }); }
    });
    render();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
