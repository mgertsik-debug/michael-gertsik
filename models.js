// ============================================================
//  INTERACTIVE MODELS — Edit this file to add new models.
//
//  Each model is an interactive demonstration of how something
//  in the law / finance / technology space works (e.g. the
//  Howey test, insider-trading timelines, market mechanics).
//
//  Models are grouped on the page by "category", so related
//  models appear together under their own section heading.
//
//  ── HOW TO ADD A NEW MODEL ──────────────────────────────────
//  Copy one of the blocks below, paste it at the TOP of the
//  array (right after the opening "["), and fill it in.
//
//  Required fields:
//    id        unique slug used in the URL  (/model/<id>)
//    category  section the model is grouped under
//    title     name shown on the card and model page
//    summary   one or two sentences shown on the card
//    status    "live"  → opens the interactive model
//              "soon"  → shows a "Coming soon" card (no link)
//
//  Provide the interactive content in ONE of two ways:
//    html  →  a full, self-contained HTML document as a string.
//             It runs inside a sandboxed iframe, so its own
//             CSS/JS can't interfere with the rest of the site.
//             Best for models you build with Claude — just
//             paste the generated HTML here.
//    src   →  a path to a standalone .html file you upload to
//             the repo (e.g. "/models/insider-trading.html").
//             Use this for larger models. Loaded in an iframe.
//
//  (If both are given, "src" wins. "soon" models need neither.)
// ============================================================

const MODELS = [

  // ── COMING-SOON EXAMPLE ──────────────────────────────────
  // This is the pattern for a model you plan to build later.
  // Flip status to "live" and add `html` or `src` when ready.
  {
    id: "insider-trading-timeline",
    category: "Market Integrity",
    title: "Insider Trading: Anatomy of a Case",
    summary: "An interactive timeline that walks through a classic insider-trading fact pattern — who knew what, when, and how the elements of liability come together.",
    status: "soon",
  },

  // ── LIVE INTERACTIVE MODEL ───────────────────────────────
  // A self-contained interactive Howey Test classifier. It is
  // an illustration of the four-prong analysis, not legal advice.
  {
    id: "howey-test",
    category: "Securities Analysis",
    title: "The Howey Test, Interactively",
    summary: "Step through the four prongs of SEC v. Howey to see how a transaction is — or isn't — classified as an investment contract. Adjust the facts and watch the analysis update live.",
    status: "live",
    html: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root{
    --bg:#060912; --surface:#0d1426; --surface2:#121b30;
    --border:rgba(120,170,255,0.14); --border-bright:rgba(120,170,255,0.34);
    --text:#eaf1fb; --text-dim:#9fb0cc; --text-muted:#5a6a85;
    --cyan:#2bd9ff; --blue:#5b8cff; --green:#34e2b0; --red:#ff6b6b;
    --sans:'Inter',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
    --mono:'JetBrains Mono','SFMono-Regular',Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box;margin:0;padding:0;}
  body{
    background:var(--bg); color:var(--text); font-family:var(--sans);
    line-height:1.6; padding:28px clamp(16px,4vw,40px) 48px;
    background-image:
      radial-gradient(1200px 600px at 80% -10%, rgba(91,140,255,0.10), transparent 60%),
      radial-gradient(900px 500px at -10% 110%, rgba(43,217,255,0.08), transparent 55%);
  }
  .wrap{max-width:880px;margin:0 auto;}
  .eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:0.18em;text-transform:uppercase;
    color:var(--cyan);margin-bottom:10px;}
  h1{font-size:clamp(24px,3.4vw,34px);font-weight:700;letter-spacing:-0.02em;line-height:1.15;margin-bottom:10px;}
  .lede{color:var(--text-dim);font-size:15px;max-width:640px;margin-bottom:28px;}
  .prongs{display:flex;flex-direction:column;gap:14px;margin-bottom:26px;}
  .prong{
    background:linear-gradient(135deg,rgba(18,27,48,0.9),rgba(13,20,38,0.7));
    border:1px solid var(--border);border-radius:14px;padding:18px 20px;
    transition:border-color .25s,box-shadow .25s,transform .25s;
  }
  .prong.met{border-color:rgba(52,226,176,0.45);box-shadow:0 0 0 1px rgba(52,226,176,0.12),0 8px 28px rgba(0,0,0,0.35);}
  .prong-top{display:flex;align-items:center;gap:14px;}
  .prong-num{font-family:var(--mono);font-size:12px;color:var(--text-muted);width:26px;flex-shrink:0;}
  .prong-q{font-weight:600;font-size:15px;flex:1;}
  .prong-desc{color:var(--text-dim);font-size:13.5px;margin:10px 0 0 40px;}
  .toggle{position:relative;width:52px;height:28px;border-radius:999px;flex-shrink:0;
    background:var(--surface2);border:1px solid var(--border-bright);cursor:pointer;transition:background .25s;}
  .toggle::after{content:'';position:absolute;top:2px;left:2px;width:22px;height:22px;border-radius:50%;
    background:var(--text-muted);transition:transform .25s,background .25s;}
  .toggle.on{background:linear-gradient(90deg,var(--cyan),var(--blue));border-color:transparent;}
  .toggle.on::after{transform:translateX(24px);background:#06121f;}
  .verdict{
    border-radius:16px;padding:24px;border:1px solid var(--border);
    background:linear-gradient(135deg,rgba(18,27,48,0.95),rgba(13,20,38,0.8));
    display:flex;gap:18px;align-items:flex-start;
  }
  .verdict-badge{font-family:var(--mono);font-size:11px;letter-spacing:0.14em;text-transform:uppercase;
    padding:6px 12px;border-radius:999px;white-space:nowrap;flex-shrink:0;font-weight:600;}
  .badge-yes{background:rgba(52,226,176,0.14);color:var(--green);border:1px solid rgba(52,226,176,0.4);}
  .badge-no{background:rgba(255,107,107,0.12);color:var(--red);border:1px solid rgba(255,107,107,0.35);}
  .verdict-title{font-size:18px;font-weight:700;margin-bottom:6px;}
  .verdict-body{color:var(--text-dim);font-size:14px;}
  .meter{height:6px;border-radius:999px;background:var(--surface2);overflow:hidden;margin:18px 0 8px;}
  .meter-fill{height:100%;width:0;border-radius:999px;background:linear-gradient(90deg,var(--cyan),var(--blue));transition:width .4s cubic-bezier(.22,1,.36,1);}
  .meter-label{font-family:var(--mono);font-size:11px;color:var(--text-muted);letter-spacing:0.1em;text-transform:uppercase;}
  .presets{display:flex;flex-wrap:wrap;gap:8px;margin:22px 0 8px;}
  .preset{font-family:var(--mono);font-size:11px;letter-spacing:0.06em;text-transform:uppercase;
    background:rgba(120,170,255,0.06);border:1px solid var(--border);color:var(--text-dim);
    padding:8px 14px;border-radius:8px;cursor:pointer;transition:all .2s;}
  .preset:hover{color:var(--text);border-color:var(--border-bright);background:rgba(120,170,255,0.12);}
  .disclaimer{margin-top:26px;font-size:12px;color:var(--text-muted);border-top:1px solid var(--border);padding-top:16px;}
</style>
</head>
<body>
  <div class="wrap">
    <div class="eyebrow">Securities Analysis · Interactive</div>
    <h1>The Howey Test</h1>
    <p class="lede">In <em>SEC v. W.J. Howey Co.</em> (1946), the Supreme Court defined an "investment contract" — a type of security — using four elements. Toggle each fact below to see how the classification changes.</p>

    <div class="presets">
      <span class="meter-label" style="width:100%;margin-bottom:2px;">Try a scenario:</span>
      <button class="preset" data-p="1,1,1,1">Token ICO with roadmap</button>
      <button class="preset" data-p="0,0,1,1">Decentralized network token</button>
      <button class="preset" data-p="1,1,1,0">Collectible / utility NFT</button>
      <button class="preset" data-p="0,0,0,0">Reset</button>
    </div>

    <div class="prongs" id="prongs"></div>

    <div class="meter-label">Prongs satisfied</div>
    <div class="meter"><div class="meter-fill" id="meter"></div></div>

    <div class="verdict" id="verdict"></div>

    <p class="disclaimer">Educational illustration of the four-prong <em>Howey</em> framework. Real classification is fact-specific and context-dependent — this is not legal advice.</p>
  </div>

<script>
  const PRONGS = [
    {q:"Is there an investment of money?", d:"The purchaser commits capital (or other tangible consideration) in exchange for the asset."},
    {q:"Is it in a common enterprise?", d:"Investors' fortunes are tied together, or to the success of the promoter (horizontal or vertical commonality)."},
    {q:"Is there an expectation of profits?", d:"The purchaser is primarily motivated by an anticipated return, not personal use or consumption."},
    {q:"Do profits come from the efforts of others?", d:"Returns are expected to derive from the essential managerial or entrepreneurial efforts of a promoter or third party."},
  ];
  const state = [false,false,false,false];
  const prongsEl = document.getElementById('prongs');
  const meterEl = document.getElementById('meter');
  const verdictEl = document.getElementById('verdict');

  PRONGS.forEach((p,i)=>{
    const row = document.createElement('div');
    row.className='prong';
    row.innerHTML = \`
      <div class="prong-top">
        <span class="prong-num">0\${i+1}</span>
        <span class="prong-q">\${p.q}</span>
        <button class="toggle" aria-label="toggle" data-i="\${i}"></button>
      </div>
      <div class="prong-desc">\${p.d}</div>\`;
    prongsEl.appendChild(row);
  });

  function render(){
    const rows = prongsEl.querySelectorAll('.prong');
    let count=0;
    state.forEach((on,i)=>{
      rows[i].classList.toggle('met',on);
      rows[i].querySelector('.toggle').classList.toggle('on',on);
      if(on) count++;
    });
    meterEl.style.width = (count/4*100)+'%';
    const all = count===4;
    verdictEl.className = 'verdict';
    if(all){
      verdictEl.innerHTML = \`
        <span class="verdict-badge badge-yes">Likely a security</span>
        <div><div class="verdict-title">All four prongs are satisfied</div>
        <div class="verdict-body">When every element of <em>Howey</em> is met, the transaction is likely an investment contract and therefore a security — bringing it within the registration and disclosure requirements of the federal securities laws (absent an exemption).</div></div>\`;
    } else {
      const missing = PRONGS.filter((_,i)=>!state[i]).length;
      verdictEl.innerHTML = \`
        <span class="verdict-badge badge-no">Not an investment contract</span>
        <div><div class="verdict-title">\${missing} prong\${missing>1?'s':''} not satisfied</div>
        <div class="verdict-body">Howey is conjunctive — <strong>all four</strong> elements must be present. If even one is missing, the transaction is not an investment contract under this test (though it may still be regulated on other grounds).</div></div>\`;
    }
  }

  prongsEl.addEventListener('click',e=>{
    const t = e.target.closest('.toggle');
    if(!t) return;
    const i = +t.dataset.i;
    state[i] = !state[i];
    render();
  });

  document.querySelectorAll('.preset').forEach(b=>{
    b.addEventListener('click',()=>{
      b.dataset.p.split(',').forEach((v,i)=>state[i]= v==='1');
      render();
    });
  });

  render();
</script>
</body>
</html>`,
  },

];
