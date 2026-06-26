# Reading the Chain: Insider Trading in Prediction Markets and the Design of an Open, Cross‑Venue Forensic Scanner

**Michael Gertsik**
*michael-gertsik.com*
*June 2026*

---

> **Abstract.** Prediction markets have crossed from financial curiosity into a national‑security and market‑integrity concern. In the space of a single year, traders appear to have front‑run a coordinated U.S.–Israeli strike on Iran, the U.S. capture of Nicolás Maduro, the Nobel Peace Prize announcement, Google's "Year in Search" rankings, OpenAI's browser launch, and even a celebrity engagement — all on public, on‑chain venues. In March 2026, Joshua Mitts and Moran Ofir of Harvard Law School and the University of Haifa published the first systematic empirical and legal study of the phenomenon, screening more than 210,000 suspicious wallet‑market pairs across roughly 93,000 Polymarket markets and finding a 69.9% win rate and approximately **$143 million** in anomalous profit. This paper does three things. First, it credits and synthesizes that empirical foundation, alongside related work and a wave of 2026 enforcement. Second, it walks through the case studies that motivated the problem. Third — and this is its original contribution — it documents the process of building a working, **independent, cross‑venue forensic scanner** that scores the same on‑chain data in something close to real time rather than retrospectively, and it specifies, in detail, every screening metric the scanner uses and how each confirmed case would have tripped it. It closes with a legal analysis of the statutes that do and do not reach this conduct, and argues that the data to detect prediction‑market insider trading already exists in public — the gap is **infrastructure**, not information.

---

## I. Introduction

I originally set out to write a short paper on insider trading in prediction markets. The deeper I went, the clearer it became that the problem was no longer a niche curiosity for crypto‑natives. Prediction markets are booming, and as the volume grows, so does the number of bad actors and the incentive to exploit material nonpublic information (MNPI). What began as a question about market structure now sits at the intersection of securities law, commodities regulation, wire‑fraud doctrine, money‑laundering enforcement, and national security.

Three observations frame everything that follows.

**One: this is now a mainstream regulatory and national‑security concern, not a fringe one.** When the Council on Foreign Relations, the Department of Justice, the Commodity Futures Trading Commission (CFTC), CNN, PBS, NPR, and members of both parties in Congress are all focused on the same set of facts, the surveillance and regulatory infrastructure needs to catch up to the attention. In the first half of 2026 alone, the CFTC's Division of Enforcement issued a formal advisory warning that insider trading on event contracts may violate federal law (CFTC Press Release No. 9185‑26, Feb. 25, 2026); the agency reasserted exclusive jurisdiction over commodity‑derivative markets in a circuit‑court filing (Press Release No. 9183‑26, Feb. 17, 2026); and the DOJ and CFTC brought the **first two insider‑trading prosecutions ever filed over prediction‑market trading** — *United States v. Gannon Ken Van Dyke* (the Maduro trade; CFTC Press Release No. 9217‑26, Apr. 23, 2026) and *United States v. Michele Spagnuolo* (the Google "Year in Search" trade; CFTC Press Release No. 9237‑26, May 27, 2026). Representative Ritchie Torres introduced the Public Integrity in Financial Prediction Markets Act of 2026 (H.R. 7004), and House Oversight Chairman James Comer opened a congressional probe into insider trading on Kalshi and Polymarket (CNBC, May 22, 2026).

**Two: the data needed to detect this conduct already exists — in public, on‑chain.** Harvard proved it with a retrospective analysis built entirely on Polymarket's public order‑fill data on the Polygon blockchain (Mitts & Ofir, *From Iran to Taylor Swift: Informed Trading in Prediction Markets*, Mar. 16, 2026). The gap is not data *availability*. It is data *infrastructure* — the tooling to ingest, normalize, score, and flag anomalies in real time, across venues, rather than months after the fact in an academic paper or a journalist's thread.

**Three: platform self‑regulation is structurally insufficient.** Polymarket's founder has said the platform "can self‑police insider trading," and the company reports having referred nearly 100 wallets to law enforcement. But one caught referral out of an estimated $143 million in suspected anomalous profit is not a system that works; it is a system that occasionally notices. Cross‑venue, *independent* surveillance — the same principle that underpins FINRA's Cross‑Market Surveillance program for U.S. equities and the Financial Conduct Authority's market‑abuse monitoring in the U.K. — is what prediction markets need. And independent surveillance requires exactly the data infrastructure, cross‑platform normalization, and analytical depth that an intelligence layer provides.

That intelligence layer is what I built. The scanner described in Part IV is a static‑stack, scheduled forensic engine that enumerates resolved Polymarket markets, aggregates trades **by wallet** (the bettor's whole record, not a single market), screens for candidates, deep‑enriches them with on‑chain funding traces, scores each subject with a transparent suite of statistical detectors, fuses those detectors into a tier, and publishes a ranked, explainable ledger. It is deliberately the opposite of a black box: every flag is a number a lawyer can follow, and every flag is labeled "pattern consistent with informed trading — not proof."

---

## II. The Empirical Foundation: Credit to the Harvard Study and Related Work

### A. *From Iran to Taylor Swift* (Mitts & Ofir, Harvard / Haifa, 2026)

The intellectual and empirical backbone of this paper — and the direct inspiration for the scanner's metrics — is **Joshua Mitts and Moran Ofir, *From Iran to Taylor Swift: Informed Trading in Prediction Markets* (First Draft, Mar. 16, 2026)**, circulated through the Harvard Law School Forum on Corporate Governance (Mar. 25, 2026). Mitts is the David J. Greenwald Professor of Law at Columbia University and advises the DOJ on insider‑trading matters; Ofir is a Professor at the Faculty of Law at the University of Haifa. Everything in this section is theirs unless otherwise noted, and the scanner's screening signals are an attempt to operationalize their methodology in real time.

The study's empirical core is a **systematic statistical screening of all Polymarket markets** with at least $10,000 in volume from February 2024 through February 2026, drawn from on‑chain order‑fill data on both the `CTFExchange` and `NegRiskCTFExchange` contracts. After filtering, the screen yields **210,718 suspicious (wallet, market) pairs** spanning **93,050 distinct markets** and **49,775 unique wallet addresses**. The headline findings:

- Among the 197,705 resolved pairs, **138,281 (69.9%) were profitable** — i.e., the trader held the side that ultimately won.
- A permutation test that randomly flips each market's winning outcome 10,000 times places the observed win count **59.6 standard deviations above the null mean** (the paper elsewhere describes this as "more than 60 standard deviations"), with *p* < 0.001. In plain terms: in a Polymarket where outcomes were decided by a coin flip after trading closed, a 69.9% win rate **never occurred once in 10,000 simulations**.
- The estimated **aggregate anomalous profit is approximately $143.0 million** (mean $723 per pair; median $110). Profit is heavily concentrated: the top 685 pairs (the score‑500‑plus tier, 0.3% of all flagged pairs) account for **47.5% of aggregate profit**.
- Win rate rises **monotonically** with the composite score — 68.6% in the lowest tier, 69.6%, 79.5%, and **80.0%** in the highest — which is the single most important validation: the score is not merely identifying traders who bet big, but traders who **bet big and bet correctly**.

Two methodological choices in the Harvard study deserve emphasis because the scanner adopts both.

First, the **unit of analysis is the (wallet, market) pair**, not the wallet, because informed trading is **episodic**: "A wallet that lost money on nine out of ten markets is still of interest if the tenth bet was anomalous in size, timing, and outcome." The analogy is to a corporate insider who trades dozens of stocks but is suspicious only for the specific trades tied to MNPI.

Second, the **aggregate fill filter**. Polymarket's hybrid central limit order book (CLOB) uses "complement routing," so a single CLOB order can produce multiple on‑chain component fills in both YES and NO tokens; counted naively, volume inflates by 2× or more and P&L can even invert. The Harvard filter keeps only fills where the exchange contract itself is the maker or taker, recovering CLOB‑level intent. Its accuracy was verified against the *ricosuave666* (IDF) case: the filtered Dune P&L of **$154,217** matches the Israeli indictment's **$155,699** figure to within 1%.

### B. The five Harvard screening signals (which the scanner's metrics extend)

The Harvard composite score combines five signals, each measuring a distinct dimension of anomaly, with **weights fixed before any results were examined** to guard against data‑mining:

| # | Signal | Weight | What it measures |
|---|--------|:--:|------------------|
| 1 | `z_profit_cross` | 30% | Cross‑sectional profit z‑score — was the trader's profit anomalous vs. peers in the same market? |
| 2 | `z_bet_cross` | 25% | Cross‑sectional bet‑size z‑score — was the bet large relative to other participants? |
| 3 | `z_bet_within` | 20% | Within‑trader bet‑size z‑score — did the bet deviate from the trader's **own** baseline? |
| 4 | `late_buy_fraction` | 15% | Pre‑event timing — share of buying in the final 48 hours before resolution. |
| 5 | `directional_score` | 10% | Directional concentration — pure, un‑hedged, held‑to‑resolution buying. |

Each signal independently predicts profitability (timing is the strongest single correlate, *r* = 0.064), but the power is in the **simultaneous alignment** of independent dimensions. As Mitts and Ofir put it, for the random‑chance explanation to hold, the trader who placed the largest relative bet would *also* need to have deviated most from their own baseline, *also* concentrated buying in the final 48 hours, *also* held a purely directional position, and *also* been on the winning side — the product of those probabilities is vanishingly small. This is precisely the multi‑factor logic that triggers insider‑trading investigations in equities.

The study is candid about its **limitations**, and these limitations are exactly the gaps the scanner was designed to close (Part IV):
1. It cannot observe **intent**; a high score is anomalous behavior, not proof of MNPI.
2. It is **buy‑side only**.
3. The $500 minimum and *z* > 2 threshold **exclude small bets**, so a deliberately small insider escapes.
4. **Sybil wallets** (one entity, many wallets) appear as separate entries — "On‑chain clustering techniques (shared funding sources, coordinated timing, common intermediary addresses) could be used to consolidate related wallets."
5. It **does not trace funding source** — "a newly funded wallet that immediately places a single large bet and then goes dormant" would be a powerful signal, but "on‑chain funding source tracing is computationally expensive and beyond the scope of the current screening."
6. It analyzes **only Polymarket**; cross‑platform surveillance would require integrating multiple venues.

Crucially for what follows, the authors note that the transparency of blockchain data means the methodology "can be replicated and extended by any researcher" — "blockchain‑based surveillance is inherently open and auditable." That invitation is what this project takes up.

### C. Related work

A separate, larger study by researchers at **London Business School and Yale University**, analyzing approximately **1.72 million accounts** and **$13.76 billion** in trading volume from 2023 to 2025, reportedly found that roughly **3% of accounts — "expert winners" — captured over 30% of all profits**, and flagged some **1,950 accounts** for suspected insider trading. Whatever the precise overlap with the Harvard population, the qualitative finding is the same: a small, identifiable cohort of accounts earns the lion's share of the abnormal returns.

These are not conspiracy theories. They are peer‑reviewed (or working‑paper) statistical analyses built on publicly available on‑chain data, and they sit on top of a deep prior literature on information transmission in markets — from Hayek's description of prices as a "system of telecommunications" (Hayek, *The Use of Knowledge in Society*, 1945), to the canonical economics of prediction markets (Wolfers & Zitzewitz, *Prediction Markets*, 2004), to the theory of state‑contingent claims "completing" markets (Arrow, 1964), to the skeptical view that these markets fail precisely when law needs them most (Allensworth, *Prediction Markets and Law: A Skeptical Account*, 2009), to Mitts and Jackson's *Trading on Terror?* (2023). And the cases keep multiplying.

---

## III. Case Studies of Informed Trading in Prediction Markets

The following episodes are the factual record the scanner was built to catch. Where a case is documented in the Harvard study, the on‑chain figures are theirs; where a case post‑dates the study or was reported elsewhere (Van Dyke, Spagnuolo, the Biden pardons, the congressional candidates, the U.S.–Iran peace‑deal wallet), the source is noted inline.

### A. The 2026 Iran Strike Trade — "Magamyman" and the fresh‑account ring

On February 28, 2026, the United States and Israel launched coordinated airstrikes on Iran that killed Supreme Leader Ayatollah Ali Khamenei — among the most closely guarded military secrets in recent history. Polymarket had registered more than **$529 million** in volume across the "US strikes Iran by…?" event group (sixty‑four binary contracts), one of the largest single‑event episodes in the platform's history.

The trading began before the news. At roughly **05:15 UTC — about 71 minutes before the first wire reports** — an account named **"Magamyman"** (wallet `0x4dfd…6e4a`) began buying YES in "US strikes Iran by February 28, 2026?" at **~$0.17** (a 17% implied probability). Over the next ~80 minutes it accumulated a large directional position across multiple Iran date‑markets, watching the YES price climb from $0.17 to $0.70–0.80 as the strike began to circulate. Total reported profit across all Iran markets: **~$553,000** (NPR, Mar. 1, 2026). Notably, Magamyman was *not* a fresh wallet — it had traded forty‑eight Iran‑related markets over sixteen months — which makes it a different archetype from the Maduro case.

Magamyman was not alone. Blockchain‑analytics firm **Bubblemaps** identified **six freshly created accounts** that collectively earned roughly **$1.2 million** from pre‑strike positioning (The Block; CoinDesk, Feb. 28, 2026), among them "Planktonbet" (~$174k), "Dicedicedice" (~$120k), "Neodbs" (~$89k), and "nothingeverhappens911" (~$66k). On‑chain screening of all winning‑side wallets identified **646 suspect wallets**; the top‑ten by suspicion score each showed a **100% win ratio** and bought **2–106 hours before** the event (Dune Analytics). The accounts were created in close temporal proximity, traded in a narrow pre‑strike window, and were overwhelmingly directional with no apparent hedging.

### B. The Maduro Trade → *United States v. Van Dyke* — the first U.S. prosecution

On January 3, 2026, President Trump announced that U.S. forces had captured Venezuelan President Nicolás Maduro (and his wife, Cilia Flores) in a nighttime operation, "Operation Absolute Resolve." In the hours before the announcement, a Polymarket account named **"Burdensome‑Mix"** (wallet `0x31a56e…8eD9`) — created only weeks earlier — bought YES on "Maduro out by January 31, 2026?" at **$0.06–$0.10**, an average of **$0.074** (a 7.4% implied probability). Per the Harvard reconstruction, the wallet acquired 523,879 YES tokens for **$38,533**, worth **$523,879** at resolution — a realized gain of roughly **$485,346**, a **~1,260% return** on a 12.6‑to‑1 risk/reward bet. The single largest burst, **$21,958** for 280,207 tokens, came hours before the Saturday‑morning announcement; trading was concentrated entirely in one near‑term market and was purely directional with no hedging. Daily volume across all Maduro markets spiked roughly **70×** on January 3, from a ~$105,000 baseline to $7.4 million.

On **April 23, 2026**, the SDNY unsealed an indictment and the CFTC filed a parallel civil complaint (No. 1:26‑cv‑03369; CFTC Press Release No. 9217‑26) against **Gannon Ken Van Dyke**, an active‑duty U.S. Army Special Forces soldier from North Carolina, alleging he used **classified nonpublic information** about the Maduro operation to trade the "Burdensome‑Mix" account. The government pegged his bets at roughly **$33,000** and his profit at **more than $404,000** (some reporting ~$409,882), realized both through favorable resolution and by selling related positions early (CNBC; NPR, Apr. 23, 2026). It is the **first insider‑trading case involving prediction markets** anywhere in the United States. (Kalshi later said it had blocked him from its platform.)

### C. The IDF Insider Trading Case — "ricosuave666" — the first criminal charges worldwide

Operation Rising Lion, Israel's June 13, 2025 campaign against Iran's nuclear program, was among the most closely guarded secrets in Israeli national security. An account named **"ricosuave666,"** created in June 2025, bet thousands of dollars on four Israel‑related questions — including "Israel military action against Iran by Friday?" — and went a **perfect record**, earning ~$128,700 on that single market and roughly **$150,000–$155,699** total before going dormant for seven months, briefly reactivating in January 2026, and being deleted after Lookonchain flagged it.

On **February 12, 2026**, the Tel Aviv District Attorney indicted an **IDF reservist and a civilian** for using classified operational plans to place Polymarket bets — charges including "serious security offenses, bribery, and obstruction of justice." It is the **first known criminal prosecution for prediction‑market insider trading anywhere in the world** (Times of Israel; WSJ, Feb. 12, 2026), and it established that misuse of military intelligence to trade event contracts can be criminal conduct. The Harvard screen independently scored *ricosuave666* at **312.9 in the June‑24 strike market — rank 3,662 of 210,718, the top 1.7%** — a clean validation that the methodology catches a genuine, separately‑proven insider.

### D. The Nobel Peace Prize Case — toxic flow that exposed an espionage breach

On October 10, 2025, María Corina Machado won the 2025 Nobel Peace Prize. The Nobel selection process is famously secretive — five committee members, sealed nominations for fifty years. Yet **nine to eleven hours before the announcement**, Machado's implied odds on Polymarket leapt from **~3.6% ($0.04) to over $0.73**, driven by three accounts: **"6741"** (created ~24 hours earlier, $29,000 wagered, ~$53,500 profit), **"dirtycup"** (created weeks earlier, no prior history, $68,340 single‑direction bet, ~$31,000 profit), and **"GayPride"** (~$85,000 profit at higher entry prices). Net profits were ~$90,000. Norwegian Nobel Institute Director Kristian Berg Harpviken told Bloomberg: "It seems we have been prey to a criminal actor who wants to earn money on our information." On January 30, 2026, the Committee formally concluded that **"digital espionage" was the most likely explanation** for the leak (Reuters; Bloomberg). The paradox: the prediction market both *monetized* the stolen information and *revealed that a theft had occurred*.

### E. The AlphaRaccoon / Google "Year in Search" Case → *United States v. Spagnuolo*

On December 4, 2025, Google released "Year in Search 2025," naming the singer **d4vd** the #1 most‑trending person — an outcome essentially no public commentator predicted (his implied odds had been as low as **0.2%** in late November). An account named **"AlphaRaccoon"** (later renamed "0xafEe," wallet `0xee50…7ed6`) correctly predicted **22 of 23 outcomes** across the Year in Search markets, earning **~$1.15 million in a single day**. Its signature trade: **$10,647 on d4vd at ~$0.05**, returning ~$200,000 (~1,900%). Its single loss — a **$12,000 hedge on Kendrick Lamar** for the same #1 slot — read as a deliberate hedge by someone with strong‑but‑imperfect knowledge. Months earlier the same wallet had earned ~$150,000 calling the **exact** release date of Google's Gemini 3.0 model. The exposure came not from a regulator but from a Meta engineer's viral X post.

On **May 27, 2026**, the SDNY and CFTC filed parallel criminal and civil actions against **Michele Spagnuolo**, a Google software engineer based in Switzerland (No. ; CFTC Press Release No. 9237‑26). The complaints allege that from **October 15 to December 4, 2025** he used confidential internal "Year in Search" data to trade at least 23 contracts, **risking ~$2.75 million** and **profiting ~$1.2 million**, then **laundered the proceeds through cryptocurrency privacy services** (CNBC; TechCrunch; Morrison & Foerster, June 1, 2026). It is the **first U.S. prediction‑market insider‑trading case based on *corporate* MNPI** — distinct from the government/military secrets in Van Dyke and the IDF case — and the second coordinated DOJ/CFTC action in roughly a month.

### F. The OpenAI Browser Case — a fresh‑wallet cluster on a product launch

OpenAI launched its ChatGPT Atlas browser on October 21, 2025, ten days before the Polymarket market "OpenAI browser by October 31?" (~$5.5 million volume) was set to resolve. In the days prior, the implied probability surged from **32% to 70%**, and a single brand‑new wallet's **~$40,000** YES bet reportedly pushed it from 75% to 95% (community analyst @cryptof4ck; TradeAlgo). Five wallets were flagged — **tigerlionzebra, Iam100x, mellopal, 0xLuck** (three created in Sept/Oct 2025 with little or no history, concentrated in a niche tech market) and **lamps** (an 84% win rate across 36 predictions, holding ~$114,850 on this market alone). The case — surfaced in part by Polysights' "Insider Finder," a tool funded by a $25,000 Polymarket grant — illustrates corporate **product‑roadmap** MNPI and the recurring **fresh‑wallet cluster** archetype.

### G. The Taylor Swift / "romanticpaul" Case — the purest illustration of the gap

On August 26, 2025, Taylor Swift and Travis Kelce announced their engagement — though Kelce's father later said the proposal happened ~two weeks earlier and that family had known "for months." On Polymarket's "Taylor Swift and Travis Kelce engaged in 2025?" market (~$385,000 volume), an account named **"romanticpaul"** began an aggressive buying spree **~22 hours before** the announcement and made its final purchase **fourteen minutes before** (and one trade three minutes *after*) the Instagram post, single‑handedly moving the market from ~25% to ~45%. Profit on $2,065 staked: **~$3,137 (~152%)**. A separate unidentified trader turned **$12,000 into ~$52,174 (~335%)**. The dollar amounts are modest, but the case is the **purest illustration of the regulatory gap**: even if a member of a celebrity's social circle traded on advance knowledge of a personal announcement, **no federal statute clearly prohibits the conduct.**

### H. Cases beyond the Harvard window — the pattern continues

- **Biden's last‑minute pardons.** Per a Bubblemaps analysis shared with NPR (Apr. 16, 2026), a trader netted approximately **$316,346** across five well‑timed bets on Biden's final‑hours pardons — including a **$21,711 bet on a Jim Biden pardon at 11% odds that returned $198,220 within minutes**, and a bet on an Adam Schiff pardon priced at just 6% — after an earlier wager on a Hunter Biden pardon. Tellingly, **two distinct accounts were cashing out to the same Kraken wallet** — a textbook on‑chain *linkage* signal. Mitts called the odds of this by chance "virtually zero." No charges have been announced.
- **The U.S.–Iran "permanent peace deal" wallet.** Bloomberg (analyzing Polymarket and Dune data) reported a wallet **created two hours before its first trade** that bought "US x Iran permanent peace deal by June 15, 2026?" YES at ~14% odds and was paid out when Pakistan's prime minister announced a peace deal on June 14 — a position Bloomberg valued at "$1.5 million." As discussed in Part IV.A, that figure became a cautionary tale about naive flagging.
- **Congressional candidates betting on themselves.** In April 2026, **Kalshi suspended and fined three congressional candidates** — Mark Moran (VA Senate), Ezekiel Enriquez (TX House primary), and Matt Klein (MN House) — for wagering on their own races (PBS). The same month, the White House reportedly warned staff against trading prediction markets on policy they could influence (TIME), and House Oversight opened a formal probe (CNBC, May 22, 2026).

---

## IV. Process: Building the Forensic Scanner

### A. The original idea, and why the naive version fails

My first concept was a real‑time **surveillance mechanism** that would flag suspicious wallets and market manipulation as it happened. The instinct was right; the naive execution is exactly what trips up even sophisticated newsrooms — and that failure mode is worth crediting, because it shaped the entire architecture.

Consider Bloomberg's reporting (with the intelligence platform **Polysights**) on the "US x Iran permanent peace deal by June 15, 2026?" wallet. Bloomberg headlined a **"$1.5 million payout"** on a single peace‑deal bet by a wallet created two hours before its first trade. The trader **@CarOnPolymarket** then publicly dismantled the reporting (X, June 18, 2026; credit to him): if you actually pull the wallet's record, the **$1.5 million was the wallet's *lifetime* payout across many unrelated markets** — elections, NBA Finals, UFC, robotaxis — not a single suspicious bet; the peace‑deal profit was a "couple hundred thousand." Worse, the **same wallet had bought $120K of the peace‑deal market on June 7 and lost it all** — a fact Bloomberg never mentioned. His conclusion: "Even the most credible newspapers are extremely bad at covering supposed insiders… insider trading on Polymarket is not a thing on the scale the media makes it seem. There may be only 1‑2 *possible* insiders."

That critique is the founding constraint of the scanner. The lessons:

1. **Aggregate the bettor's *whole* record, never a single market.** A headline number that conflates lifetime winnings across elections and sports with one event is meaningless. The forensic pivot must be the wallet (or linked cluster) across *all* its resolved bets.
2. **Account for losses.** A wallet that won a long‑shot but also lost a comparable long‑shot in the same market is a gambler, not an insider. Profitability must be measured net and in context.
3. **Demand statistical improbability, not a suggestive screenshot.** One winning long‑shot is the market's own odds playing out, not evidence. You need a record improbable enough that luck is rejected — or a single bet so corroborated by independent signals that confluence does the work the math can't.

Whether @CarOnPolymarket's "only 1‑2" estimate is right is itself an empirical question — and it is precisely the question a transparent, auditable scanner exists to answer honestly, in either direction.

### B. The new idea, and why it is better

Harvard's screen is retrospective: it ran once, over a fixed window, and published months after the events. The new idea is to take the *same public on‑chain data* — decoded order fills, token transfers, position splits, wallet funding histories — and score it **continuously and structurally**, so the detection signature becomes both **sharper and faster**:

- **Volume–price mismatch** analysis can flag when a market moves without corresponding news (the Nobel surge from 3.6% to 73% overnight; the OpenAI jump from 32% to 70%).
- **Wallet clustering** can identify when a bundle of "new" accounts is actually **one entity** operating through proxy wallets (the Iran ring; the Biden‑pardon accounts cashing out to one Kraken wallet) — directly addressing Harvard's acknowledged Sybil limitation.
- **On‑chain funding traces** can surface the "newly funded wallet that places one large bet then goes dormant" archetype Harvard flagged as out of scope.

**Why Polymarket, and the Kalshi limitation.** Polymarket settles on the public Polygon blockchain: every order fill, transfer, and funding hop is world‑readable, which makes independent, permissionless forensics *possible at all*. **Kalshi**, by contrast, is a centralized, CFTC‑regulated exchange whose order book is **not** on a public chain — so while Kalshi is in some ways better positioned to *self*‑surveil (it has KYC and account identity), it is far harder for an outside party to audit. That asymmetry is the central irony of the space: the *least* regulated venue is the *most* transparent to independent analysis, and the *most* regulated venue is the most opaque to outsiders. The scanner therefore focuses where independent verification is feasible: Polymarket's on‑chain record.

### C. Theoretical considerations and the limits of any wallet screen

Before the metrics, three honest caveats — the same ones that govern any responsible surveillance tool:

- **No screen observes intent.** A high score is *anomalous behavior*, not proof of MNPI. A macro fund with a strong Fed thesis can place large, late, directional, profitable bets without any inside information. Every output of the scanner is labeled **"pattern consistent with informed trading — not proof,"** and the burden of proof in any individual case rests with the accuser.
- **False positives are the enemy, and the design fights them three ways.** (i) A minimum sample (≥ 5 independent resolved bets) before the binomial will even score a record; (ii) a **≥ 2‑agreeing‑detector gate** so no single signal can flag a subject; and (iii) a pre‑publish validation gate that drops and logs any subject whose numbers don't reconcile.
- **Missing data must *exclude*, never penalize.** If a detector's inputs are missing, it returns `hasData = false` and is dropped from the score — it is **never** scored zero. A wallet we simply lack timing data for is not punished for it.

### D. The screening signals — every metric, in detail

The scanner's detector suite is pure, dependency‑free, and unit‑tested; it deliberately uses transparent statistics ("no ML, no heavy deps — statistics a lawyer can follow") rather than an opaque model. Each detector returns a sub‑score in [0, 1], the raw inputs it used, a plain‑English explanation, and a `hasData` flag. The suite both **operationalizes Harvard's five signals** and **extends them** to cover Harvard's stated limitations (funding source, Sybil clustering, concealment). Below, each metric, its formula, its threshold, and its lineage.

**1. WON — binomial improbability (the headline).** This is the rigorous version of Harvard's profitability signal. For a wallet's resolved long‑shot bets, we compute the exact probability of doing *at least* this well by luck:

> *P*(X ≥ k) = Σ₍ᵢ₌ₖ₎ⁿ C(n, i) · pⁱ · (1−p)ⁿ⁻ⁱ,  for X ~ Binomial(n, p)

where *n* is the number of **independent** resolved bets, *k* the number won, and *p* the mean market‑implied probability of those bets. The tail is computed in log‑space with a Lanczos log‑gamma so that astronomically small probabilities (1 in billions) stay numerically stable. The result is reported as a human‑readable **"1 in N"** (e.g., "1 in 4.2M"). **Tiers:** *Extreme* if *P* ≤ 1e‑6, *High* if *P* ≤ 1e‑4, *Notable* if *P* ≤ 1e‑2. A record under **5 independent bets returns `hasData = false`** — small samples are statistically worthless.

   *De‑correlation* is essential and is the binomial's integrity check. An insider who knows one thing bets it across *many* related markets (Van Dyke spread ~$32k across several Maduro date‑markets; Magamyman across Iran date‑contracts). Counting each as independent would fraudulently inflate the improbability. So bets are collapsed by **`eventGroup`**: each underlying event becomes **one effective bet** (won = did they net‑win that event; *p* = mean implied across the group). This is the scanner's analogue of Harvard's concern with correlated outcomes, made explicit.

**2. LONGSHOT — average entry odds.** Mean market‑implied entry probability across the wallet's bets; fires if *p̄* ≤ **0.20**. Captures the Maduro/Nobel/d4vd signature of buying outcomes the market priced at single‑digit percentages.

**3. HELD — hold‑to‑resolution rate.** *h* = held‑to‑resolution / total; fires if *h* ≥ **0.90**. This is the "conviction signature" — an informed trader holds to the $1.00 payout rather than scalping, the cousin of Harvard's directional‑concentration signal. (Sold < ~3% before the outcome.)

**4. FRESH — wallet age + funding recency.** Fires if account age ≤ **14 days** AND **prior on‑chain transactions = 0** — the "purpose‑built wallet" pattern (the Iran ring, dirtycup, the OpenAI cluster, the peace‑deal wallet created two hours before its first trade). **This directly implements the funding‑source signal Harvard flagged as out of scope**, using an on‑chain funding trace to recover wallet age and prior‑tx count.

**5. BASELINE — realized win rate vs. category baseline.** Compares the wallet's win rate on ≤ 35%‑implied bets against an empirical category baseline (military & defense ~52%, politics/elections ~25%, world ~30%, economics ~18%, crypto ~12%, **all ~14%**), scaled by a category‑risk weight (military/world/politics highest). Context for the binomial — and a nod to the fact that base rates differ sharply by event type.

**6. CONCEAL — concealment signatures.** Fires only if **≥ 2** of three tactics co‑occur: (i) **stake‑splitting** across linked wallets (split ratio ≥ 0.5; cluster‑only); (ii) **decoy** tiny bets masking the real one (decoy ratio ≥ 0.3); (iii) **rapid off‑platform cash‑out** within ≤ 24h of resolution. A lone wallet needs decoy + fast cash‑out; it can never fire on one tactic alone. (On‑chain cash‑out latency comes from tracing the wallet's first exchange hop after resolution.)

**7. CONVICTION — the single high‑stakes long‑shot (the lone‑insider bet the binomial can't see).** The binomial needs ≥ 5 bets, so it is blind to a one‑shot insider like Van Dyke ($32k at ~8% → ~$400k). One bet is not statistically "improbable" — it's just the market's odds — so this detector **never flags alone**. It fires only as part of a ≥ 2‑detector confluence: a winning, held position of **≥ $7,500** at **≤ 15% implied**, summed by event (so a thesis spread across several markets of one event counts as one concentrated conviction). Calibrated to the confirmed Maduro/Van Dyke insiders.

**8. TIMING — informed entry timing.** Harvard's `late_buy_fraction`, sharpened. For a wallet's **won** deep‑long‑shots (≤ 20% implied) with known entry and resolution timestamps, it measures how long *before* resolution they bought; fires if at least one winning long‑shot was entered within **72 hours** of resolution. Van Dyke bet the night before; the Iran ring bought hours before at ~10¢; romanticpaul bought fourteen minutes before. Excluded (never penalized) when timestamps are missing.

**9. CONCENTRATION — directional + event purity.** *dirPurity* = max(YES, NO stake) / total; *clusterDensity* = top‑event stake / total. Fires if *dirPurity* ≥ **0.95** AND total stake ≥ **$10,000** (and ≥ 3 bets). This is the "all‑YES, one‑cluster, un‑hedged" tell — real money on a single thesis. Common among long‑shot gamblers, so it carries **low weight** and matters only in confluence.

**10. SIZING — within‑trader bet‑size anomaly.** This is Harvard's `z_bet_within` made concrete: the informed bet dwarfs the wallet's *own* norm. Top event position vs. the wallet's **median** bet; fires if ≥ **8×** median AND ≥ **$3,000** absolute (and ≥ 4 bets, so it can't stand in for a lone‑bet conviction case). Independent of absolute size — it catches the small trader who suddenly deploys their whole bankroll on one event.

**11. CLUSTER — on‑chain linkage (Meiklejohn‑style).** This is the scanner's answer to Harvard's Sybil limitation. Pairwise linkage between two wallets:

> link(a, b) = 0.40·shared_funder + 0.25·co_spend + 0.20·sync_entry + 0.15·create_prox

where *shared_funder* = 1 if both were funded from the same on‑chain address; *co_spend* = Jaccard overlap of the events both bet; *sync_entry* = fraction of shared events entered within a **15‑minute** window; *create_prox* = wallets first seen within **2 days**. Wallets merge into a cluster (one entity) when **mean pairwise link ≥ 0.80**, and the merged record is then scored by the same suite (the binomial de‑correlates shared events across the whole ring). Every link is labeled a **probabilistic inference, not confirmed common ownership**. An **auto ring‑finder** walks the on‑chain funding graph outward from each flagged wallet (when an Etherscan‑class key is available) to pull in siblings the market sweep hasn't reached — turning a single flag into a whole ring (the Iran‑style 6–9 accounts under one funder).

**Fusion → tier.** Fired detectors are combined with contribution weights ordered by discriminating power — **won 32, cluster 22, conviction 20, timing 16, conceal 14, sizing 12, longshot 11, fresh 8, concentration 7, held 6** — renormalized over only those that fired. A detector "agrees" when its sub‑score ≥ 0.45. There are **two paths to a flag**, and both require **≥ 2 independent agreeing detectors**:

- **The record path:** binomial improbability over ≥ 5 independent events → up to *Extreme* (*P* ≤ 1e‑6) or *High* (*P* ≤ 1e‑4), gated on ≥ 2 agreeing detectors.
- **The single‑bet path:** a lone high‑conviction long‑shot **corroborated** by ≥ 2 agreeing detectors (fresh / conceal / timing / cluster / category) → capped at *High*. A single bet can't be statistically "extreme," so here it is the **confluence**, not the math, that flags — and this is what catches the one‑shot insider (Van Dyke) the binomial cannot.

This dual‑path design is the direct, structural response to the Bloomberg failure mode: the record path can't be fooled by a lifetime‑winnings headline (it de‑correlates and demands improbability net of losses), and the single‑bet path won't fire on a lucky screenshot (it demands corroboration).

### E. How each confirmed case maps onto the metrics

The point of a screen is not to admire known cases but to show that its signals *fire* on the ground truth — and *why*. Applying the suite:

| Case | Primary path | Detectors that fire |
|------|--------------|---------------------|
| **Van Dyke / Maduro** (Burdensome‑Mix) | Single‑bet | conviction ($32k @ ~7%, event‑summed), fresh (weeks‑old wallet), timing (hours before), concentration (100% YES, one cluster), held |
| **Iran ring** (6 fresh wallets) | Cluster → record | cluster (shared funder, sync entry, create‑prox), fresh, timing, longshot, won (de‑correlated across the ring) |
| **IDF / ricosuave666** | Record | won (perfect record on 4 events), longshot, timing, sizing — matches Harvard's score of 312.9 (top 1.7%) |
| **Nobel** (6741, dirtycup, GayPride) | Single‑bet / cluster | fresh (24h‑old wallet), timing (hours before), conviction/concentration (dirtycup's single‑direction $68k) |
| **AlphaRaccoon / Spagnuolo** | Record | won (22 of 23 → astronomically improbable), sizing, longshot, conviction (d4vd $10.6k @ 5%), held |
| **OpenAI cluster** | Cluster | cluster (5 fresh wallets, one niche market), fresh, sizing (lamps' concentrated $114k), timing |
| **Taylor Swift / romanticpaul** | Single‑bet (borderline) | timing (14 min before), concentration — *deliberately* near/under threshold given the ~$2k stake; a correct *near‑miss* the scanner should **not** over‑flag |
| **Biden pardons** | Cluster + record | cluster (two accounts → one Kraken cash‑out), timing, longshot (6–11% odds), won across five bets |
| **Peace‑deal wallet** | Record (with losses) | fresh (created 2h before), timing — but **net of the $120k June‑7 loss**, exactly the correction Bloomberg missed |

Three of these deserve emphasis. The *ricosuave666* match is the strongest single validation: a wallet **separately proven** by the Israeli indictment scores in the top 1.7% on an independent statistical screen. The *Taylor Swift* row shows restraint by design — a $2,000 recreational‑looking bet should sit near the threshold, not get blasted as "extreme," because over‑flagging destroys credibility. And the *peace‑deal* row is the whole thesis in miniature: the scanner reaches the *opposite* conclusion from the Bloomberg headline because it nets the losing bet.

---

## V. Legal Analysis

The recurring theme across every case is that the **conduct is obvious and the law is uncertain.** Insider‑trading doctrine was built around securities and fiduciary duties; prediction‑market event contracts are mostly *commodities* tied to geopolitical or macroeconomic events, and they trade on pseudonymous, sometimes decentralized, sometimes offshore venues. This Part walks through each applicable body of law, how it works, whether it reaches prediction‑market trading, and where it breaks down. The primary legal sources are the Congressional Research Service's Legal Sidebar **LSB11406, *Prediction Markets and Insider Trading Law***; **Morrison & Foerster's** insights (the March 2026 article *Prediction Markets and the Law of Insider Trading* and the June 1, 2026 analysis of the *Spagnuolo*/*Van Dyke* actions); and the Harvard study's legal Part V — supplemented with the most recent 2026 CFTC releases and law‑firm commentary.

### A. SEC Rule 10b‑5 (and why it usually doesn't reach event contracts)

Federal securities law prohibits insider trading principally through two judge‑made theories under Section 10(b) of the Securities Exchange Act of 1934 and Rule 10b‑5:

- The **classical theory** (*Chiarella v. United States*, 445 U.S. 222 (1980)): a corporate insider with a fiduciary duty to shareholders must **disclose or abstain** before trading on MNPI about that company; liability extends to **tipping** for a personal benefit (*Dirks v. SEC*, 463 U.S. 646 (1983)).
- The **misappropriation theory** (*United States v. O'Hagan*, 521 U.S. 642 (1997)): liability attaches when someone trades on MNPI **in breach of a duty of trust or confidence owed to the source** of the information — even if they owe no duty to the company whose securities they trade. As *O'Hagan* framed it, the crime is not the use of nonpublic information per se but the **deceptive theft** of that information and its undisclosed conversion for personal gain.

The threshold problem for prediction markets is **subject matter**: both theories reach only the purchase or sale of a **security**. A contract whose payoff derives from a stock price might qualify. But the contracts at issue here pay off on **geopolitical or macroeconomic events** — a military strike, a head of state's capture, a Nobel laureate, a search ranking. As Harvard concludes, "neither the classical nor misappropriation theories of securities fraud map cleanly onto geopolitical or macroeconomic event contracts." These instruments look far more like **commodities**, which pushes the analysis out of the SEC's lane and into the CFTC's.

### B. The CEA and CFTC Rule 180.1 — the principal vehicle, and its narrowness

For commodity derivatives, the operative anti‑fraud authority is **Section 6(c)(1) of the Commodity Exchange Act (7 U.S.C. § 9(1))** and **CFTC Regulation 180.1 (17 C.F.R. § 180.1)**. Section 753 of the Dodd‑Frank Act (2010) amended the CEA to prohibit fraud and manipulation "in connection with any swap, or a contract of sale of any commodity in interstate commerce"; the CFTC finalized Rule 180.1 in 2011, expressly **modeled on SEC Rule 10b‑5**, stating it would be "guided, but not controlled, by" the body of 10b‑5 precedent. The CFTC has taken the position — central to both 2026 prosecutions — that **many event contracts are "swaps"** within its jurisdiction, and it applies a **misappropriation theory**: liability where a person (i) possesses MNPI, (ii) misappropriates it by trading or tipping **in breach of a duty of trust and confidence owed to the source**, (iii) with scienter.

But Rule 180.1 is **narrower than 10b‑5 in critical respects** (CRS LSB11406; Harvard Part V):

- It is **unclear that Rule 180.1 imposes a *Cady, Roberts*‑style affirmative duty to disclose**. Trading on **"lawfully obtained" commercial information**, without deception or breach of a pre‑existing duty, **remains legal** in commodities markets. As Andrew Verstein observed, "[o]fficially, there is still no general restriction on insider trading in commodities markets" (*Insider Trading in Commodities Markets*, 102 Va. L. Rev. 447 (2016)).
- It therefore requires a **link to deception or duty** — a higher bar than 10b‑5's "trading while in possession" standard. Where there is no duty owed to the *source* (e.g., a corporate employee betting on his own employer's data may breach a duty; an outside hacker or a tipped friend may not), liability is uncertain.
- Until 2026, the CFTC had **never applied Rule 180.1 to a prediction market.** Its first insider‑trading enforcement action under the rule was *In re Motazedi* (CFTC No. 16‑02 (2015)), and the misappropriation reading has support in cases like *CFTC v. EOX Holdings* (S.D. Tex. 2019) — but neither involved event contracts.

**The 2026 turn.** That changed fast. The CFTC's February 25, 2026 advisory (Press Release No. 9185‑26) warned that insider trading on event contracts may violate § 6(c)(1) and Rule 180.1 and announced the first prediction‑market fines (reportedly a MrBeast video editor and a political candidate). Then came the two landmark cases: **Van Dyke** (Apr. 23, 2026; Press Release No. 9217‑26) charged a soldier under § 6(c)(1)/Rule 180.1 (with parallel criminal wire‑fraud and money‑laundering counts) for trading on classified **government** MNPI; and **Spagnuolo** (May 27, 2026; Press Release No. 9237‑26) extended the theory to **corporate** MNPI — a Google engineer's misappropriation of internal "Year in Search" data, again paired with wire‑fraud and money‑laundering charges. CFTC Chairman Michael Selig's January 2026 "Project Crypto" agenda and the agency's reassertion of **exclusive jurisdiction** (Press Release No. 9183‑26) signal that Rule 180.1 is now the government's primary tool. The open question, as Morrison & Foerster and the CRS both flag, is how far the misappropriation theory stretches when the **source of the information owes (or is owed) no clear duty** — the Nobel hacker, the tipped friend, the celebrity's acquaintance.

### C. Title 18: Wire Fraud and the "commercial value" problem

Federal **wire fraud (18 U.S.C. § 1343)** is the workhorse the DOJ paired with the CFTC counts in both Van Dyke and Spagnuolo. The Second Circuit has held that wire fraud can reach the **misappropriation of confidential information that has demonstrable commercial value** to a party seeking to keep it confidential (*United States v. Chastain*, 145 F.4th 282 (2d Cir. 2025) — the NFT "insider trading" case). That is a powerful but **limited** tool, because the information must have **commercial value to its holder**, not merely value to a trader. Consider classified information about a military operation: it is plainly valuable to a Polymarket bettor, but it is **not obviously a commercial asset** of the armed force — it may be "intangible interest[] unconnected to traditional property rights." This is why the cleanest wire‑fraud cases (Spagnuolo's *corporate* data) are easier than the government‑secrets cases, where the "property"/"commercial value" hook is strained — and why prosecutors in Van Dyke also leaned on the CEA and, by reporting, classified‑information and **money‑laundering** theories.

### D. The "Eddie Murphy Rule" (Dodd‑Frank § 746 / CEA § 6(c)(1))

The so‑called **"Eddie Murphy rule"** — named for the orange‑juice futures scene in *Trading Places* — was enacted as **Section 746 of the Dodd‑Frank Act** and is the historical heart of CEA § 6(c)(1). It was designed specifically to **prohibit trading commodity derivatives on MNPI misappropriated from a *government* source**, and was implemented through Rule 180.1. It is, in other words, the provision most squarely aimed at the Van Dyke fact pattern — a government insider trading on government secrets. Its limitation is the same as Rule 180.1's generally: it targets **misappropriation and deception**, not mere possession, and it has only just been tested against event contracts.

### E. Money Laundering (18 U.S.C. § 1956 and § 1957)

Both 2026 prosecutions include **money‑laundering** counts, and this is an under‑appreciated but potent angle. Section 1957 (engaging in monetary transactions in criminally derived property over $10,000) and § 1956 (laundering of proceeds / concealment) attach once the underlying trading is a "specified unlawful activity" such as wire fraud. The Spagnuolo complaint alleges he **laundered ~$1.2 million in proceeds through cryptocurrency privacy services** — the on‑chain analogue of running cash through a mixer. This matters for the scanner: the **rapid off‑platform cash‑out** and **mixing/privacy‑service hop** are exactly the concealment behaviors the `conceal` detector is built to catch, and they convert a hard‑to‑prove information offense into a more tractable financial‑crime case.

### F. Exchange Rules: Polymarket vs. Kalshi (and why contract ≠ fraud)

Both platforms purport to prohibit informed trading, but the prohibitions differ sharply (Harvard Part V):

- **Polymarket** (Rulebook § II.8(d)) prohibits only **Company personnel and affiliates** from trading on the Company's MNPI — essentially an internal‑employee rule, mirroring the CFTC's own restriction on Designated Contract Market employees (17 C.F.R. § 1.59(d)). It does **not** broadly prohibit ordinary users from trading on outside MNPI; its terms reach front‑running, wash trading, and fraud, but the company has taken little public enforcement action against the flagged accounts in these cases.
- **Kalshi's** rules are broader: §§ (y)–(z) prohibit any **"Insider"** with access to MNPI about a contract's underlying — or anyone who can **influence** the outcome — from trading those contracts, including employees of a "Source Agency." This is why Kalshi was able to **suspend the three congressional candidates** who bet on their own races.

But a violation of an exchange rule is, at most, a **breach of contract** — and **not every breach is fraud.** If the contract is not a security, the securities laws don't apply; if there's no misappropriation in breach of a duty owed to the source, Rule 180.1 may not apply either. Whether injured counterparties are **third‑party beneficiaries** with standing to sue an insider under state contract principles is, as Harvard notes, an **open question.**

### G. State Anti‑Fraud and Gambling Law

State law adds a third, fragmented layer. State **anti‑fraud (blue‑sky)** statutes and consumer‑protection laws (New York's Martin Act; California's Corporations and Business & Professions Codes) could in principle reach deceptive trading, but they were not written for pseudonymous on‑chain event contracts and face the same securities‑vs‑commodity classification problem. Meanwhile, many states and countries treat these platforms as **gambling**: France and Belgium (and, per French regulators, Germany, the Netherlands, Poland, Switzerland, and others) have **banned Polymarket** outright as illegal gambling, and U.S. state gaming regulators continue to assert authority over sports‑related contracts even as the CFTC claims exclusive federal jurisdiction (a conflict now in litigation following *KalshiEX LLC v. CFTC*). The EU's **Markets in Crypto‑Assets (MiCA)** regime prohibits insider dealing in crypto‑assets, but whether it reaches prediction‑market *tokens* is unsettled. The net effect is a patchwork in which the **same trade** may be a federal commodities violation, a state gambling offense, perfectly legal, or wholly unreachable, depending on the venue, the contract, and the information's source.

### H. The structural gap

Stepping back, the deepest problem is the one Harvard names: insider‑trading doctrine has a **transactional, duty‑based focus**, while prediction markets present **architectural novelty** — pseudonymous wallets, decentralized settlement, offshore operators, and information sources (a hacker, a friend, a celebrity's relative) who often owe **no cognizable duty** to anyone. Should regulation attach to the **platform** (mandatory surveillance and registration as a condition of serving U.S. persons), to the **contract** (special rules for high‑risk information channels like military or election markets), or to **both**? Should it turn on whether the venue is centralized (Kalshi) or decentralized (Polymarket)? Current law has no satisfying answer — which is exactly why independent, infrastructure‑grade surveillance has to fill the gap that doctrine, for now, cannot.

---

## VI. Conclusion

The prediction‑market industry is at an inflection point. It can build the integrity infrastructure **before** regulators build it for them — or it can wait until the next indictment, which, given the pattern of suspicious trades documented here, will not be long. In the first half of 2026 the government went from *never* having charged a prediction‑market insider to filing **two landmark cases in a single month** (Van Dyke and Spagnuolo), issuing an enforcement advisory, asserting exclusive jurisdiction, and fielding a congressional probe and a standalone bill (H.R. 7004). The trajectory is clear, and the legal theories — CEA § 6(c)(1)/Rule 180.1 misappropriation, wire fraud, money laundering — are now live, even if their edges (the duty‑less source, the offshore venue, the non‑commercial secret) remain unsettled.

But enforcement after the fact is not market integrity. The lesson of this project is that **the signal is already in public, on‑chain, in real time** — the binomial improbability of a perfect long‑shot record, the within‑trader size anomaly, the late informed entry, the fresh purpose‑built wallet, the funding‑graph ring, the rapid mix‑and‑cash‑out. Harvard proved the signal exists at scale and earned the field's gratitude for it; the contribution here is to show that the **same data can be ingested, normalized across venues, scored with transparent statistics, and published as an explainable, auditable ledger** — closing precisely the gaps (Sybil clustering, funding‑source tracing, concealment, cross‑venue coverage, real‑time cadence) that a one‑time retrospective study has to leave open.

The cautionary half of the lesson matters just as much. The Bloomberg/peace‑deal episode shows how *easy* it is to manufacture a false "$1.5 million insider" out of a wallet's lifetime winnings — and how a disciplined screen that aggregates the **whole record**, **de‑correlates** related bets, **nets out losses**, and demands a **two‑detector confluence** reaches the opposite, correct conclusion. The goal is not to flag everyone who wins a long‑shot; it is to separate the recreational gambler from the genuine insider with enough rigor that a lawyer, a journalist, or a regulator can follow every step and a court could one day take it seriously. On‑chain data metrics are uniquely suited to that task because they are complete, immutable, and **open to anyone** — which is the whole point. The data is there. The signal is there. What has been missing is the infrastructure to read it at scale. That is what the scanner is for.

---

## Sources and References

**Primary empirical source**
- Joshua Mitts & Moran Ofir, *From Iran to Taylor Swift: Informed Trading in Prediction Markets* (First Draft, Mar. 16, 2026); Harvard Law School Forum on Corporate Governance (Mar. 25, 2026), https://corpgov.law.harvard.edu/2026/03/25/from-iran-to-taylor-swift-informed-trading-in-prediction-markets/.
- (As described) Study by researchers at London Business School and Yale University analyzing ~1.72 million accounts and ~$13.76 billion in volume (2023–2025); ~3% of accounts captured >30% of profits; ~1,950 accounts flagged.

**Legal authorities cited in the outline**
- Congressional Research Service, *Prediction Markets and Insider Trading Law*, Legal Sidebar LSB11406, https://www.congress.gov/crs-product/LSB11406.
- Morrison & Foerster, *Prediction Markets and the Law of Insider [Trading]* (Mar. 3, 2026), https://www.mofo.com/resources/insights/260303-prediction-markets-and-the-law-of-insider; and *DOJ and CFTC Bring Parallel Insider Trading Actions Based on Internet Search Trend Event Contracts* (June 1, 2026), https://www.mofo.com/resources/insights/260601-doj-and-cftc-bring-parallel-insider-trading-actions.

**Statutes, rules, and cases**
- Securities Exchange Act of 1934 § 10(b); 17 C.F.R. § 240.10b‑5.
- Commodity Exchange Act § 6(c)(1), 7 U.S.C. § 9(1); CFTC Rule 180.1, 17 C.F.R. § 180.1; 17 C.F.R. § 1.59(d).
- Dodd‑Frank Wall Street Reform and Consumer Protection Act §§ 745, 746 ("Eddie Murphy rule"), 753.
- 18 U.S.C. § 1343 (wire fraud); 18 U.S.C. §§ 1956, 1957 (money laundering).
- *Chiarella v. United States*, 445 U.S. 222 (1980); *Dirks v. SEC*, 463 U.S. 646 (1983); *United States v. O'Hagan*, 521 U.S. 642 (1997); *United States v. Chastain*, 145 F.4th 282 (2d Cir. 2025); *CFTC v. EOX Holdings L.L.C.*, 405 F. Supp. 3d 697 (S.D. Tex. 2019); *In re Motazedi*, CFTC No. 16‑02 (2015); *KalshiEX LLC v. CFTC*, No. 23‑cv‑3257 (D.D.C. 2024).
- H.R. 7004, Public Integrity in Financial Prediction Markets Act of 2026.
- Regulation (EU) 2023/1114 (Markets in Crypto‑Assets / MiCA).

**CFTC and government materials (2026)**
- CFTC Press Release No. 9185‑26 (Div. of Enforcement Prediction Markets Advisory, Feb. 25, 2026).
- CFTC Press Release No. 9183‑26 (exclusive‑jurisdiction circuit filing, Feb. 17, 2026).
- CFTC Press Release No. 9217‑26, *CFTC Charges U.S. Service Member with Insider Trading in Nicolás Maduro‑Related Event Contracts* (Apr. 23, 2026); *United States v. Van Dyke*, No. 1:26‑cv‑03369 (S.D.N.Y.).
- CFTC Press Release No. 9237‑26, *CFTC Charges Google Employee with Insider Trading in Search Result‑Related Event Contracts* (May 27, 2026); *United States v. Spagnuolo* (S.D.N.Y.).
- Michael Selig, Chairman, CFTC, *The Next Phase of Project Crypto* (Jan. 29, 2026).

**Law‑firm and analyst commentary**
- Sidley Austin LLP, *The First Prediction Market Insider Trading Case* (May 2026).
- Akin Gump, *DOJ and CFTC Bring New Insider Trading Cases in Prediction Markets* (2026).
- Baker Botts, *CFTC Brings First of Its Kind Insider Trading Action … Maduro‑Related Event Contracts* (Apr. 2026).
- Sullivan & Cromwell LLP, *CFTC Division of Enforcement Announces Five Priority Areas, Insider Trading Framework for Prediction Markets* (Apr. 2026).
- Government Enforcement, Compliance & Investigations Report, *Corporate Insider Trading on Prediction Markets: United States v. Spagnuolo* (June 2026).

**Journalism and on‑chain analytics (selected, by case)**
- *Iran strike:* Bobby Allyn, NPR (Mar. 1, 2026); Zack Abrams, The Block (Feb. 28, 2026); CoinDesk (Feb. 28, 2026); Bubblemaps/Dune Analytics.
- *Maduro / Van Dyke:* NPR (Jan. 5 & Apr. 23, 2026); PBS NewsHour (Jan. 12, 2026); CNBC (Apr. 23–24, 2026); Lookonchain.
- *IDF / ricosuave666:* Times of Israel & WSJ (Feb. 12, 2026); Israel Hayom; Jerusalem Post; Haaretz.
- *Nobel:* Bloomberg (Oct. 10 & 13, 2025; Jan. 30, 2026); Reuters (Jan. 30, 2026); Protos; Blockworks.
- *AlphaRaccoon / Spagnuolo:* DeFi Rate (Dec. 5, 2025); CoinDesk; Gizmodo; CNBC & TechCrunch (May 27, 2026).
- *OpenAI browser:* @cryptof4ck, @KyleDeWriter (X, Oct.–Dec. 2025); TradeAlgo; Gizmodo; Polysights "Insider Finder."
- *Taylor Swift / romanticpaul:* WSJ (Aug. 27, 2025); Business Insider; Parade; Benzinga.
- *Biden pardons:* Bubblemaps via NPR (Apr. 16, 2026); Decrypt.
- *U.S.–Iran peace‑deal wallet:* Bloomberg News analysis of Polymarket and Dune data; @CarOnPolymarket (X, June 18, 2026) (critique of the reporting — credit for the false‑positive lesson).
- *Congressional candidates / oversight:* PBS NewsHour; CNBC (May 22, 2026); TIME (Apr. 10, 2026).

**Scholarship and theory**
- Friedrich A. Hayek, *The Use of Knowledge in Society*, 35 Am. Econ. Rev. 519 (1945); Justin Wolfers & Eric Zitzewitz, *Prediction Markets*, 18 J. Econ. Persp. 107 (2004); Kenneth J. Arrow, *The Role of Securities in the Optimal Allocation of Risk‑Bearing*, 31 Rev. Econ. Stud. 91 (1964); Rebecca Haw Allensworth, *Prediction Markets and Law: A Skeptical Account*, 122 Harv. L. Rev. 1217 (2009); Andrew Verstein, *Insider Trading in Commodities Markets*, 102 Va. L. Rev. 447 (2016), and *Insider Trading and Position Limits*, 72 UCLA L. Rev. 1014 (2025); Joshua Mitts & Robert J. Jackson, Jr., *Trading on Terror?* (working paper, 2023). On‑chain clustering methodology after Meiklejohn et al., *A Fistful of Bitcoins* (2013).

---

*Author's note on methodology and limitations.* The scanner described in Part IV is the author's own implementation, available in summary at michael‑gertsik.com. It is a screening and investigative aid, not an adjudication. Every flag it produces is labeled "pattern consistent with informed trading — not proof," every cluster link is a probabilistic inference rather than confirmed common ownership, and the system is designed to **exclude** (never penalize) subjects for whom data is missing. Statistical screening cannot establish intent or the possession of material nonpublic information; those are questions for investigators and courts. Nothing in this paper alleges that any specific identified or pseudonymous trader committed a crime, except where charges have in fact been filed by the named authorities.
