// ============================================================
//  YOUR INSIGHTS: Edit this file to add new entries.
//
//  Insights = short, timely commentary on news, enforcement
//  actions, regulatory updates, and brief analysis.
//
//  To add a new entry, copy the block below, paste it at the
//  TOP of the array (right after the opening "["), fill in
//  your content, and save.
//
//  For "link": paste a full URL to link out to an external
//  source when clicked. Leave as "" for no external link.
// ============================================================

const INSIGHTS = [
  {
    id: "cftc-2026-proposed-rule-prediction-markets",
    slug: "from-categorical-bans-to-case-by-case-review-the-cftcs-2026-proposed-rule-on-prediction-markets",
    date: "July 1, 2026",
    category: "Regulatory Developments",
    title: "From Categorical Bans to Case-by-Case Review: The CFTC's 2026 Proposed Rule on Prediction Markets",
    summary: "The CFTC's proposed rewrite of Rule 40.11 would end categorical prohibitions on event contracts, define \"gaming\" for the first time, codify the Kalshi court's reading of \"involve,\" and build a procedural framework around public interest review. A close read of the full proposal, and what it signals about where enforcement is heading.",
    content: `
      <p>On June 10, 2026, the Commodity Futures Trading Commission approved a notice of proposed rulemaking titled "Prediction Markets; Public Interest Determinations," a full rewrite of Rule 40.11 and the most consequential regulatory document for event contract markets since Dodd-Frank added the "Special Rule" to the Commodity Exchange Act in 2010.<sup>[1]</sup> The proposal was published in the Federal Register on June 12, 2026, and comments are due July 27, 2026.<sup>[2]</sup> The proposal runs well over 250 pages, and the details matter. This piece walks through what the rule would actually do, where it departs from the Commission's own prior positions, and what it signals about where compliance and enforcement in this market are heading.</p>

      <p>The headline moves are four: the end of categorical prohibitions in favor of contract-by-contract public interest review, a codified event-focused reading of the word "involve," a first-ever regulatory definition of "gaming" that pulls sports inside the rule while blessing most sports outcome contracts, and a structured 90-day review process with real procedural rights for prediction markets.</p>

      <h3>The Statutory Frame</h3>
      <p>Section 5c(c)(5)(C) of the CEA, which the proposal calls the Special Rule, authorizes the CFTC to determine that event contracts are contrary to the public interest if they involve one of five enumerated activities: activity unlawful under any federal or state law, terrorism, assassination, war, or gaming, plus a sixth catchall for similar activity the Commission designates by rule.<sup>[3]</sup> Contracts subject to such a determination cannot be listed or cleared on a registered exchange.</p>

      <p>The Commission now reads the Special Rule as a three-step inquiry: first, whether the instruments are event contracts in excluded commodities at all; second, whether they "involve" an enumerated activity; and third, whether the Commission affirmatively finds them contrary to the public interest.<sup>[4]</sup> Critically, the proposal emphasizes that the statute says the Commission "may determine" a contract is contrary to the public interest. In the agency's current view, that discretionary language forecloses any self-executing per se prohibition, which is exactly what the text of the existing Rule 40.11, adopted in 2011 without defining any of the enumerated terms, appears to impose.<sup>[5]</sup></p>

      <h3>How We Got Here</h3>
      <p>The interpretive fight has a long procedural history, and the proposal is remarkably candid about it. In 2012, the Commission barred Nadex from listing political event contracts, reasoning that gaming means gambling, that trading the contracts amounted to staking money on a contest, and that the legislative history revived a version of the pre-2000 economic purpose test.<sup>[6]</sup> In 2021, ErisX withdrew its self-certification of NFL futures contracts one day before the end of a Rule 40.11 review, after staff had drafted a prohibition order.<sup>[7]</sup> In September 2023, the Commission issued an order barring Kalshi's congressional control contracts on essentially the Nadex reasoning: the contracts involved gaming and unlawful activity because trading them was wagering, and they flunked a form of the economic purpose test.<sup>[8]</sup></p>

      <p>Kalshi sued under the Administrative Procedure Act, and in September 2024 Judge Cobb of the U.S. District Court for the District of Columbia vacated the order, holding that "involve" refers to the event underlying the contract, not the character of trading in it, and that the contracts involved elections and party control rather than any game.<sup>[9]</sup> The CFTC appealed, then dismissed its own appeal in May 2025 after the change in administration.<sup>[10]</sup> In February 2026 it withdrew its 2024 proposed rule, which had gone the opposite direction by defining gaming to include election contracts and making the enumerated categories per se contrary to the public interest.<sup>[11]</sup> A March 2026 advance notice of proposed rulemaking drew roughly 3,500 comments, and this proposal is the product.<sup>[12]</sup></p>

      <p>The proposal does not merely accept the district court's ruling as a litigation loss. It affirmatively adopts the court's reasoning and states that the Commission now preliminarily believes both the Nadex Order and the Kalshi Order were incorrectly decided.<sup>[13]</sup> Agencies rarely say that about their own precedents this plainly.</p>

      <h3>What the Proposal Does</h3>
      <p><b>1. Contract-specific review only, with no categorical determinations.</b> Proposed Rule 40.11(a)(1) provides that the Commission "may determine" that specific submitted contracts are contrary to the public interest, replacing the current rule's flat prohibition.<sup>[14]</sup> More than that, the proposal concludes that prospective categorical determinations covering classes of contracts not yet submitted would constitute rulemaking dressed up as adjudication, in violation of the APA's distinction between rules and orders.<sup>[15]</sup> The practical consequence is a common law of orders: guidance for the industry will accrete through individual determinations, which the Commission commits to following consistently or explaining departures from, in findings the rule itself would require.<sup>[16]</sup></p>

      <p><b>2. "Involves" turns on the underlying event, with a drafting doctrine attached.</b> Proposed Rule 40.11(a)(3) codifies the Kalshi court's interpretation: contracts involve an activity if their settlement is determined by an occurrence or contingency in that activity.<sup>[17]</sup> The proposal illustrates with examples that will now be studied closely. A contract on whether a specified terrorist attack occurs involves terrorism; a contract on crude oil volumes transiting the Strait of Hormuz does not involve war, even though war would move the number, because settlement turns on a measurement of commercial shipping rather than an occurrence within the conflict itself.<sup>[18]</sup></p>

      <p>The sleeper doctrine is what the proposal says about facially neutral contracts. Where a settlement condition can be reached through multiple causal pathways and at least one runs through terrorism, war, or assassination, the contract is treated as involving that activity unless its terms affirmatively specify the qualifying pathways and exclude the enumerated one. A contract on whether a named foreign leader is out of office by a date involves assassination as drafted; the same contract redrafted to settle only on electoral defeat, resignation, constitutional removal, negotiated departure, or natural death does not.<sup>[19]</sup> Settlement drafting, in other words, becomes the compliance surface.</p>

      <p><b>3. Gaming gets defined, and sports come inside the rule.</b> Proposed Rule 40.11(b) defines gaming as any activity that participants typically engage in for recreation or to entertain others, that is governed by rules, and that includes measurable occurrences or outcomes depending on participants' luck, skill, or athletic ability during the activity.<sup>[20]</sup> The Commission expressly disavows its prior equation of gaming with gambling, which the district court warned would swallow the statute since every event contract stakes money on a contingency.<sup>[21]</sup></p>

      <p>The definition is doing careful boundary work. Sports, including e-sports and judged competitions like figure skating, are gaming. Games of pure chance are gaming. But the proposal distinguishes games from what it calls contests: elections, the Nobel Prize, the Academy Awards, and even the Cy Young Award are outcomes determined by evaluative judgment external to any game, so contracts on them do not involve gaming at all and sit entirely outside the Special Rule.<sup>[22]</sup> The line can be fine. A contract on which pitcher records the most strikeouts in a season involves gaming because settlement turns on occurrences in games; a contract on who wins the Cy Young does not, because settlement turns on writers' votes.<sup>[23]</sup> Game attendance and Olympic host city selection likewise fall outside, since neither is an occurrence in the game itself.<sup>[24]</sup> The Commission also floats an alternative, more philosophical definition for comment, built on whether an activity is created by its rules and whether participants' purposes are internal to it.<sup>[25]</sup></p>

      <p><b>4. A quietly broader scope.</b> Existing Rule 40.11 reaches only event contracts in excluded commodities under CEA section 1a(19)(iv). The proposal extends coverage to all excluded commodities, carving out only price and rate changes in the financial commodities listed in section 1a(19)(i), which the Commission reads as the intended referent of the statute's erroneous cross-reference to a nonexistent "section 1a(2)(i)."<sup>[26]</sup> The proposal also lists categories it views as outside the Special Rule entirely: economic indicators like CPI and jobless claims, financial indicators like the federal funds rate, foreign exchange, election results and other political occurrences such as legislative votes and appointments, and award contests.<sup>[27]</sup></p>

      <p><b>5. The public interest framework abandons the economic purpose test.</b> The proposal rejects the view, advanced in both the Nadex and Kalshi Orders, that the Special Rule incorporates a version of the pre-2000 economic purpose test, dismissing the Feinstein-Lincoln floor colloquy as an unreliable guide to congressional intent.<sup>[28]</sup> Notably, former Senator Lincoln, the Special Rule's author, filed an ANPRM comment supporting contract-specific review and citing the Super Bowl's commercial significance, which the proposal deploys to considerable rhetorical effect.<sup>[29]</sup></p>

      <p>In place of a single test, proposed Rule 40.11(a)(5) codifies three general factor buckets. Favorable: whether contracts provide meaningful hedging or price-basing utility, yield economically useful or otherwise meaningful information, or promote responsible innovation and fair competition, including whether prohibition would push volume to less regulated offshore venues.<sup>[30]</sup> Unfavorable: particular risks of manipulation or market disruption, settlement integrity deficits, and particular risks of information leakage or exploitation of material nonpublic information by insiders.<sup>[31]</sup> Third: whether the contracts would outrun the exchange's self-regulatory and compliance infrastructure, with credit given for guardrails like barring trader categories likely to hold inside information and maintaining robust surveillance and customer identification.<sup>[32]</sup> Hedging potential remains a significant favorable factor but is no longer necessary; the proposal's theory is that event contract prices are information goods, aggregating dispersed beliefs in ways that can outperform surveys and feed commercial decision-making well beyond the underlying event.<sup>[33]</sup></p>

      <p><b>6. Category outcomes are heavily signposted.</b> Contracts involving federal or state unlawful activity are likely or highly likely to be found contrary to the public interest, with an exception for aggregate crime rates over extended periods, which have obvious insurance and planning utility.<sup>[34]</sup> Contracts involving terrorism, assassination, and war are highly likely to fail, on national security grounds the proposal spells out: prices in such markets cannot reflect real probabilities because the informed are barred from trading, attackers could buy the "no" side to generate misleading signals, and the contracts create financial incentives to leak classified information or to target cleared personnel for it.<sup>[35]</sup> Within gaming, contracts on games of pure chance are highly likely to fail as informationless, with a carve-out acknowledging that skill-dependent games like tournament poker are not purely random.<sup>[36]</sup></p>

      <p>Sports outcome contracts get the opposite treatment. Settlement on aggregate outcomes, final scores, point differentials, win-loss results, tournament advancement, and statistical performance over a game or season weighs heavily toward listing, on the theory that manipulation capacity is distributed across many participants and residual attempts produce detectable performance anomalies.<sup>[37]</sup> Objective, league-verified settlement data, an established integrity framework in the underlying sport, and formal information-sharing arrangements with leagues and governing bodies all weigh in favor.<sup>[38]</sup> That factor already has real-world infrastructure behind it: the CFTC has executed memoranda of understanding with Major League Baseball, the first agreement of its kind with a professional league and <a href="/insight/cftc-mlb-prediction-markets-2026" onclick="event.preventDefault(); openInsight('cftc-mlb-prediction-markets-2026');">covered on this site in March</a>, and more recently with the National Hockey League.<sup>[39]</sup> Six categories weigh against: contracts settling solely on player injuries (a concern pressed jointly by the players associations of the five major leagues), officiating decisions (with the Donaghy scandal cited by name), discrete in-game actions like a specific pitch or play call, physical altercations, games of pure chance, and pre-collegiate sports.<sup>[40]</sup></p>

      <p><b>7. Process becomes the centerpiece.</b> The proposal builds a structured timeline into the rule itself. Review can be initiated only by a written determination of the Commission, non-delegable, that must issue within 10 days of a contract's listing and identify the contracts, the enumerated activity, the terms at issue, and the factors warranting review.<sup>[41]</sup> Staff must serve a statement of concerns by day 15; the exchange may respond by day 30, including with proposed contract modifications; a staff recommendation, requiring General Counsel concurrence, may go to the Commission by day 60 and must be served on the exchange simultaneously; the exchange may respond to the recommendation by day 70; and by day 90 the Commission either issues a prohibition order with mandatory written findings or the review is deemed concluded and the contracts may trade.<sup>[42]</sup> Extensions are available only with the exchange's agreement. Prohibition orders must weigh factors both ways and reconcile the outcome with prior determinations, codifying State Farm and Fox obligations directly into the rule text.<sup>[43]</sup> The Commission may consolidate review of similar contracts across multiple exchanges into a single proceeding and order.<sup>[44]</sup> The consolidation mechanism is a response to scale: daily event contract listings grew from roughly 1,600 in April 2025 to 162,000 in April 2026, and the Commission reviewed 28 exchange applications over the past year.<sup>[45]</sup></p>

      <p>One structural consequence deserves emphasis: because review follows listing and nothing in the statute forces suspension during review, the proposal openly acknowledges that contracts later found contrary to the public interest may trade for up to the full review period, after which positions would be closed out with purchase prices and fees returned.<sup>[46]</sup> Traders in edge-category contracts are bearing regulatory delisting risk, and the proposal essentially says so.</p>

      <h3>Reading Between the Lines</h3>
      <p>Three things stand out to me after reading the full document.</p>

      <p>First, this is a preemption brief wearing a rulemaking's clothes. The background sections rehearse, at length, the CEA's grant of exclusive jurisdiction, its legislative history of displacing state-by-state regulation, and the Third Circuit's 2026 holding in KalshiEX v. Flaherty that the CEA grants the CFTC exclusive regulatory authority over event contracts on designated markets.<sup>[47]</sup> The Commission has simultaneously filed an amicus brief in the Ninth Circuit supporting a prediction market against Nevada's enforcement efforts.<sup>[48]</sup> Read against that litigation posture, the gaming definition looks less like a concession than a consolidation: by defining gaming to include sports, the agency brings the dominant segment of the industry, in a market that did over $25 billion in volume across registered prediction markets in 2025, squarely within an active federal review framework, and then signals through the factors that well-designed outcome contracts will pass.<sup>[49]</sup> A field occupied by a calibrated federal regime is much harder for state gaming regulators to reach than one the federal regulator disclaims. The unresolved tension is that the CFTC endorsed the position that gaming does not encompass sports at a Ninth Circuit argument as recently as April 2026, an about-face that challengers to any final rule will not let go unmentioned.<sup>[50]</sup></p>

      <p>Second, contract drafting is becoming the compliance function. The pathway-specification doctrine means the difference between a listable contract and an assassination contract can be a settlement clause enumerating the permissible ways a head of state leaves office. The same logic runs through the factors: objective settlement sources, exclusion of subjective determinations, and terms narrow enough to permit the exchange to explain, in its self-certification, why each permutation of the contract clears the Special Rule.<sup>[51]</sup> The proposal warns that overly broad contract specifications will draw staff demands for supplemental information and expressly invites pre-certification engagement with staff.<sup>[52]</sup> For the lawyers in this space, the center of gravity shifts from litigating what "gaming" means to engineering settlement terms, surveillance commitments, and league information-sharing agreements before certification.</p>

      <p>Third, insider trading on event markets has moved from hypothetical to enforcement priority, and the rule is designed around it. The generally applicable factors elevate information leakage and insider exploitation of material nonpublic information to a named consideration in every Special Rule review, and the compliance factor rewards exchanges that can prove they detect informed trading.<sup>[53]</sup> The proposal's footnotes show why this is not abstract: the Enforcement Division issued a prediction markets advisory in February 2026 reasserting its Rule 180.1 authority over fraud and misappropriation on these venues, and in April 2026 the CFTC charged a U.S. service member with insider trading in event contracts tied to Nicolás Maduro on an unregistered platform, allegedly using confidential knowledge of a U.S. military operation.<sup>[54]</sup> A separate CFTC action alleges that Michele Spagnuolo traded event contracts on sensitive nonpublic information acquired through his employment at Google, which extends the pattern beyond national security secrets into ordinary corporate MNPI, the classic insider trading paradigm.<sup>[55]</sup> The message to exchanges is that surveillance capability is now an input to listability itself, and the message to the market is that wallet-level and account-level trading forensics around event contracts is about to matter a great deal more.</p>

      <p>The comment period will be contentious, and litigation is close to certain from at least one direction: prediction markets contesting a gaming definition that contradicts the agency's own courtroom statements, state regulators and anti-gambling advocates contesting the favorable treatment of sports contracts, or both. Several bills in Congress would impose the per se prohibitions this proposal concludes the statute forbids.<sup>[56]</sup> However the final rule lands, the safest prediction remains that the regulatory framework for event contracts will stay unsettled well past finalization. What has changed is that the CFTC has now committed, in extraordinary detail and against its own precedents, to a theory of what these markets are for.</p>

      <div class="footnotes footnotes--emerald">
        <div class="footnote-title">Footnotes</div>
        <ol>
          <li>Prediction Markets; Public Interest Determinations, 91 Fed. Reg. 35,806 (proposed June 12, 2026) (RIN 3038-AF65) (NPRM); see also Jay B. Sykes, <em>CFTC Issues Proposed Rule Regarding Prediction Markets</em>, CRS Legal Sidebar No. LSB11441 (June 24, 2026), https://www.congress.gov/crs-product/LSB11441.</li>
          <li>NPRM, supra note 1 (comments due July 27, 2026).</li>
          <li>CEA sec. 5c(c)(5)(C), 7 U.S.C. § 7a-2(c)(5)(C), added by Dodd-Frank Wall Street Reform and Consumer Protection Act, Pub. L. No. 111-203, § 745(b), 124 Stat. 1376, 1735 (2010).</li>
          <li>NPRM, supra note 1, § I.B.2.</li>
          <li>Id.; 17 C.F.R. § 40.11; Provisions Common to Registered Entities, 76 Fed. Reg. 44776 (July 27, 2011).</li>
          <li>Order Prohibiting the Listing or Trading of Political Event Contracts (CFTC Apr. 2, 2012) (Nadex Order); NPRM, supra note 1, § I.C.5.</li>
          <li>NPRM, supra note 1, § I.C.6; Statement of Commissioner Brian D. Quintenz on ErisX RSBIX NFL Contracts and Certain Event Contracts (Mar. 25, 2021).</li>
          <li>Order In the Matter of the Certification by KalshiEX LLC of Derivatives Contracts with Respect to Political Control of the United States Senate and United States House of Representatives (CFTC Sept. 22, 2023) (Kalshi Order); NPRM, supra note 1, § I.C.7.</li>
          <li><em>KalshiEX LLC v. CFTC</em>, No. 23-cv-3257, 2024 WL 4164694 (D.D.C. Sept. 12, 2024).</li>
          <li><em>KalshiEX LLC v. CFTC</em>, No. 24-5205 (D.C. Cir. May 7, 2025) (dismissing appeal).</li>
          <li>Event Contracts, 89 Fed. Reg. 48968 (proposed June 10, 2024); Event Contracts; Withdrawal of Proposed Regulatory Action, 91 Fed. Reg. 5386 (Feb. 6, 2026).</li>
          <li>Prediction Markets; Advance Notice of Proposed Rulemaking, 91 Fed. Reg. 12516 (Mar. 16, 2026); NPRM, supra note 1, § I.C.9.</li>
          <li>NPRM, supra note 1, §§ II.C, II.D.1, II.D.3 (stating the Commission's preliminary belief that the Nadex Order and Kalshi Order reasoning was incorrect).</li>
          <li>Proposed 17 C.F.R. § 40.11(a)(1), NPRM, supra note 1.</li>
          <li>NPRM, supra note 1, § II.G.3 (discussing 5 U.S.C. § 551 and <em>Chrysler Corp. v. Brown</em>, 441 U.S. 281 (1979)).</li>
          <li>Proposed 17 C.F.R. § 40.11(e)(2), NPRM, supra note 1.</li>
          <li>Proposed 17 C.F.R. § 40.11(a)(3), NPRM, supra note 1; <em>KalshiEX</em>, 2024 WL 4164694.</li>
          <li>NPRM, supra note 1, § II.C.</li>
          <li>Id. § II.D.2 (pathway-specification discussion and examples).</li>
          <li>Proposed 17 C.F.R. § 40.11(b)(1), NPRM, supra note 1.</li>
          <li>NPRM, supra note 1, § II.D.3; <em>KalshiEX</em>, 2024 WL 4164694.</li>
          <li>NPRM, supra note 1, § II.D.3.</li>
          <li>Id.</li>
          <li>Id.</li>
          <li>Id. (alternative structural definition presented for comment).</li>
          <li>Proposed 17 C.F.R. § 40.11(a)(2), NPRM, supra note 1, § II.B; CEA sec. 1a(19), 7 U.S.C. § 1a(19).</li>
          <li>NPRM, supra note 1, § II.D.4.</li>
          <li>Id. §§ I.B.3, II.E (discussing 156 Cong. Rec. S5906-07 (daily ed. July 15, 2010)).</li>
          <li>Id. § I.B.3 (discussing Letter from former Senator Blanche Lincoln in response to the ANPRM).</li>
          <li>Proposed 17 C.F.R. § 40.11(a)(5)(i), NPRM, supra note 1, § II.E.2(a).</li>
          <li>Proposed 17 C.F.R. § 40.11(a)(5)(ii), NPRM, supra note 1, § II.E.2(b).</li>
          <li>Proposed 17 C.F.R. § 40.11(a)(5)(iii), NPRM, supra note 1, § II.E.2(c).</li>
          <li>NPRM, supra note 1, § II.E.2(a); see also Anthony M. Diercks, Jared Dean Katz & Jonathan H. Wright, <em>Kalshi and the Rise of Macro Markets</em>, FEDS No. 2026-010 (Bd. of Governors of the Fed. Reserve Sys. 2026).</li>
          <li>Proposed 17 C.F.R. § 40.11(a)(6)(i), NPRM, supra note 1, § II.E.3(a).</li>
          <li>Proposed 17 C.F.R. § 40.11(a)(6)(ii), NPRM, supra note 1, § II.E.3(b).</li>
          <li>NPRM, supra note 1, § II.E.3(c)(i).</li>
          <li>Proposed 17 C.F.R. § 40.11(a)(6)(iii)(A), NPRM, supra note 1, § II.E.3(c)(ii).</li>
          <li>Id.</li>
          <li>See <em>CFTC-MLB Agreement Signals Next Step in Prediction Market Oversight</em>, Insights (Mar. 19, 2026) (discussing the CFTC's first memorandum of understanding with a professional sports league); Katten Muchin Rosenman LLP, <em>Game Plan or Game Changer? The CFTC Proposes New Rules for Event Contracts and Prediction Markets</em> (June 26, 2026) (noting the subsequent CFTC-NHL memorandum of understanding).</li>
          <li>Proposed 17 C.F.R. § 40.11(a)(6)(iii)(B), NPRM, supra note 1, § II.E.3(c)(iii); Letter from the NFLPA, MLBPA, NBPA, NHLPA & MLSPA (Apr. 30, 2026) (ANPRM comment); <em>United States v. Donaghy</em>, 570 F. Supp. 2d 411 (E.D.N.Y. 2008).</li>
          <li>Proposed 17 C.F.R. § 40.11(c), (f), NPRM, supra note 1, § II.G.</li>
          <li>Proposed 17 C.F.R. § 40.11(d)-(e), NPRM, supra note 1.</li>
          <li>Proposed 17 C.F.R. § 40.11(e)(2), NPRM, supra note 1 (citing <em>Motor Vehicle Mfrs. Ass'n v. State Farm Mut. Auto. Ins. Co.</em>, 463 U.S. 29 (1983), and <em>FCC v. Fox Television Stations, Inc.</em>, 556 U.S. 502 (2009)).</li>
          <li>Proposed 17 C.F.R. § 40.11(c)(4), (e)(1)(i), NPRM, supra note 1.</li>
          <li>NPRM, supra note 1, § III.C (reporting growth in daily event contract listings from approximately 1,600 in April 2025 to 162,000 in April 2026, and Commission review of 28 DCM and SEF applications over the past year).</li>
          <li>NPRM, supra note 1, § II.G.1.</li>
          <li><em>KalshiEX, LLC v. Flaherty</em>, 172 F.4th 220 (3d Cir. 2026); NPRM, supra note 1, § I.B.1.</li>
          <li>Brief of CFTC as Amicus Curiae in Support of Appellant, <em>North American Derivatives Exchange, Inc. d/b/a Crypto.com v. Nevada</em>, No. 25-7187 (9th Cir. filed Feb. 17, 2026).</li>
          <li>NPRM, supra note 1, § I.A (reporting total 2025 trading volume across CFTC-registered prediction markets exceeding $25 billion).</li>
          <li>Sykes, supra note 1 (describing the CFTC's position at April 2026 Ninth Circuit oral argument).</li>
          <li>NPRM, supra note 1, § II.G.2; 17 C.F.R. § 40.2(a)(3)(v); CFTC Staff Letter No. 26-08 (Mar. 12, 2026).</li>
          <li>NPRM, supra note 1, §§ II.D, II.G.1-2.</li>
          <li>Proposed 17 C.F.R. § 40.11(a)(5)(ii)-(iii), NPRM, supra note 1, § II.E.2(b)-(c); 17 C.F.R. § 180.1.</li>
          <li>CFTC Enforcement Division Issues Prediction Markets Advisory (Feb. 25, 2026); CFTC Press Release No. 9217-26, CFTC Charges U.S. Service Member with Insider Trading in Nicolás Maduro-Related Event Contracts (Apr. 23, 2026).</li>
          <li>Katten Muchin Rosenman LLP, supra note 39 (discussing the CFTC's enforcement action alleging that Michele Spagnuolo traded on sensitive nonpublic information acquired through his employment with Google).</li>
          <li>Sykes, supra note 1; see also Karl E. Schneider & Alexander H. Pepper, <em>Prediction Markets Legislation in the 119th Congress</em>, CRS In Focus No. IF13207 (Apr. 21, 2026).</li>
        </ol>
      </div>
    `,
    link: ""
  },
  {
    id: "cftc-mlb-prediction-markets-2026",
    slug: "cftc-mlb-agreement-signals-next-step-in-prediction-market-oversight",
    date: "March 19, 2026",
    category: "Regulatory Developments",
    title: "CFTC-MLB Agreement Signals Next Step in Prediction Market Oversight",
    summary: "The CFTC's first formal agreement with a professional sports league establishes a framework for cooperation on sports-related prediction markets.",
    content: `
      <h3>A New Playbook for Prediction Markets and Baseball</h3>
      <p>On March 19, 2026, the CFTC entered into an agreement with Major League Baseball, a unique pairing between a federal market regulator and a professional sports league. The deal centers on prediction markets tied to baseball, a space drawing more attention as it continues to grow. Against that backdrop, the parties signed a [Memorandum of Understanding](https://www.cftc.gov/media/13516/CFTC-MLB_MOU/download) (MOU) aimed at supporting fair markets while protecting the integrity of the game. CFTC Chairman Michael Selig [described](https://www.cftc.gov/PressRoom/PressReleases/9199-26) the MOU as a collaborative step to strengthen these markets, while MLB Commissioner Rob Manfred [emphasized](https://www.mlb.com/press-release/press-release-mlb-names-polymarket-exclusive-prediction-market-exchange-partner-and-signs-agreement-with-cftc-to-establish-iintegrity-framework) that protecting the game remains the league's top priority.</p>

      <h3>How the CFTC and MLB Plan to Work Together</h3>
      <p>The MOU sets up a structured framework for cooperation between the CFTC and MLB. The parties will meet at least once a month to discuss issues affecting the integrity of baseball and related event contract markets. They can also share information upon request, which should help both sides respond more quickly to potential issues. The agreement includes confidentiality protections, meaning shared information must be kept confidential and remains the record of the providing party. It also limits how that information can be used, with the CFTC restricted to its statutory responsibilities under the Commodity Exchange Act and MLB focused on protecting the integrity of the sport. Taken together, the MOU creates an ongoing channel for coordination rather than a one-time exchange.</p>

      <h3>Why This Happened Now</h3>
      <p>The timing lines up with the CFTC's recent push on prediction markets. One week earlier, the Division of Market Oversight [issued guidance](https://www.cftc.gov/csl/26-08/download) encouraging exchanges to engage with sports leagues before listing sports-related contracts. The guidance emphasized early communication, alignment with league integrity standards, and the use of official data where appropriate. At the same time, the CFTC issued an Advance Notice of Proposed Rulemaking seeking public comment on broader regulation in this space. Seen in that light, the MLB agreement looks like a direct step in line with that approach.</p>

      <h3>What This Means for Prediction Market Participants Going Forward</h3>
      <p>This agreement signals that the regulatory approach to sports-related prediction markets is still evolving. For market participants, the takeaway is straightforward. Engaging with sports leagues may help reduce regulatory risk. At the same time, the broader landscape remains unsettled, as state gaming regulators continue to assert authority over sports-related activity while the CFTC maintains that federal oversight applies. In that context, this MOU may serve as a model for how regulators and sports organizations coordinate as the market develops.</p>
    `,
    link: ""
  },
  {
    id: "sec-cftc-joint-interpretation-crypto",
    slug: "drawing-a-clearer-line-sec-cftc-issue-joint-interpretation-on-crypto-assets",
    date: "March 17, 2026",
    category: "Regulatory Developments",
    title: "Drawing a Clearer Line: SEC & CFTC Issue Joint Interpretive Guidance on the State of Crypto Assets",
    summary: "The SEC and CFTC's March 17, 2026 joint interpretive guidance clarifies the application of federal securities laws to crypto assets, applying the Howey framework while introducing a functional taxonomy and addressing key activities such as staking, mining, and token separation.",
    content: `
      <p>On March 17, 2026, the Securities and Exchange Commission and Commodity Futures Trading Commission issued joint interpretive guidance addressing how federal securities laws apply to certain crypto assets and related transactions (the "Joint Interpretation").<sup>[1]</sup> This guidance reflects the SECs view that most crypto assets are not themselves securities. The CFTC further states that it will administer the Commodity Exchange Act consistently with the interpretation and recognizes that certain non-security crypto assets may constitute commodities subject to its oversight.</p>

      <h3>Background: Howey & the Need for Guidance</h3>
      <p>The SECs analysis of whether a transaction qualifies as an investment contract, and thus a security subject to federal securities laws, is grounded in the Supreme Courts decision in <em>SEC v. W.J. Howey Co.</em><sup>[2]</sup> There, the Court defined an investment contract as a transaction involving an investment of money in a common enterprise with a reasonable expectation of profits derived from the efforts of others. The Commission first applied this framework to crypto assets in its [2017 DAO Report](https://www.sec.gov/files/litigation/investreport/34-81207.pdf), concluding that certain digital tokens were offered and sold as investment contracts and therefore as securities.</p>
      <p>In light of the SEC's prior use of <em>Howey</em>, the Joint Interpretation acknowledges that applying this test in the crypto context has proven difficult given the diversity of token structures, varying degrees of decentralization, and the evolving nature of markets.<sup>[3]</sup></p>

      <h3>A Five-Part Taxonomy for Crypto Assets</h3>
      <p>The Joint Interpretation introduces a functional classification system for crypto assets, dividing them into digital commodities, digital collectibles, digital tools, stablecoins, and digital securities.<sup>[4]</sup></p>

      <p><b>1. Digital Commodities:</b> Digital commodities are crypto assets intrinsically linked to a functional crypto system, deriving value from its programmatic operation and underlying supply-and-demand dynamics. Unlike investment contracts, their value is not based on an expectation of profits from the managerial efforts of others. Instead, they play an integral role in network operation, including validation, transaction fees, governance, and security. They derive value from their utility and broader market dynamics.</p>

      <p><b>2. Digital Collectibles:</b> Digital collectibles, including NFTs and meme coins, are assets designed to be collected or used and typically do not provide rights to enterprise income or assets. Their value generally reflects factors such as subject matter, popularity, scarcity, and market demand, rather than a purchasers expectation of profits from ongoing managerial efforts. However, the Joint Interpretation cautions that fractionalization or similar arrangements may still give rise to an investment contract.</p>

      <p><b>3. Digital Tools:</b> Digital tools, such as tickets, credentials, memberships, and identity-related assets, perform practical functions and derive value from their utility rather than passive yield or enterprise claims. The Joint Interpretation notes that these assets are often non-transferable or programmatically issued and, as described, generally are not securities because they lack the economic characteristics associated with securities.</p>

      <p><b>4. Stablecoins:</b> Stablecoins are treated separately. A stablecoin is a crypto asset designed to maintain a stable value relative to a reference asset, such as the U.S. dollar. Congress enacted the [GENIUS Act](https://www.congress.gov/119/bills/s1582/BILLS-119s1582enr.pdf) in July 2025, establishing a comprehensive regulatory framework for payment stablecoins and excluding from the definition of security any payment stablecoin issued by a permitted payment stablecoin issuer. Because the GENIUS Act is not yet effective, the Joint Interpretation clarifies that the offer and sale of certain Covered Stablecoins do not involve securities transactions. This means persons involved in their issuance and redemption are not required to register those transactions with the SEC. At the same time, the Joint Interpretation emphasizes that stablecoins outside this category may meet the definition of a security depending on the facts and circumstances of their structure and use.</p>

      <p><b>5. Digital Securities:</b> Digital securities, by contrast, remain securities regardless of whether they are represented onchain or offchain. These tokenized instruments fall within the statutory definition of securities, and tokenization does not alter their legal character. The Joint Interpretation emphasizes that a security remains a security irrespective of how it is recorded, even where additional features or benefits are layered onto the instrument.</p>

      <h3>When Offers & Sales of Crypto Assets Involve Investment Contracts</h3>
      <p>A central theme of the Joint Interpretation is that a crypto asset that is not itself a security may nonetheless be offered and sold as part of an investment contract.<sup>[5]</sup> This determination turns on the economic realities of the transaction, including how the asset is marketed, sold, and promoted.</p>

      <p>The Joint Interpretation explains that a non-security crypto asset may become subject to an investment contract where an issuer induces an investment of money in a common enterprise through representations or promises to undertake essential managerial efforts. In these circumstances, purchasers must reasonably expect profits based on those efforts.</p>

      <p>The source, timing, and manner of the issuers representations are central to this analysis. Representations must be conveyed prior to or at the time of the offer or sale to shape purchaser expectations, while post-sale statements generally do not convert a prior transaction into an investment contract.</p>

      <p>The Joint Interpretation further emphasizes the importance of how representations are communicated. Statements made in agreements, official communications, or established public channels are more likely to inform purchaser expectations than informal or unauthorized statements. The SEC also considers whether such representations are broadly disseminated and consistent with the issuers established communication practices.</p>

      <p>Importantly, the content of those representations is critical. Explicit and detailed statements regarding future development, funding, timelines, and managerial efforts are more likely to create a reasonable expectation of profits. By contrast, vague or generalized statements that lack concrete plans or resources are less likely to support an investment contract analysis.</p>

      <h3>Separation from an Investment Contract</h3>
      <p>The Joint Interpretation also addresses the other side of the analysis: whether a crypto asset that was initially sold as part of an investment contract can later cease to be subject to one. Separation occurs when purchasers can no longer reasonably expect the issuers represented managerial efforts to remain connected to the asset.<sup>[6]</sup></p>

      <p>This may occur where the issuer has fulfilled its representations or promises, or where those efforts have been abandoned. Once those expectations no longer exist, the associated investment contract ceases, and subsequent offers or sales of the non-security crypto asset generally are not securities transactions unless a new investment contract is created.</p>

      <p>The Joint Interpretation emphasizes that clear, time-bound disclosures regarding promised efforts and milestones, as well as public notice when those efforts are completed, can help establish when separation has occurred.</p>

      <p>However, separation does not eliminate potential liability associated with the original offering. Failure to register an offering of an investment contract, or to qualify for an exemption, may still result in liability. This includes investor rights and antifraud exposure, even if the asset later separates from the contract.<sup>[7]</sup></p>

      <h3>Mining, Staking, Wrapping, & Airdrops</h3>
      <p>The Joint Interpretation also provides detailed guidance on common crypto network activities, focusing on when those activities do not involve securities transactions.<sup>[8]</sup> It begins by emphasizing that public permissionless crypto networks operate through consensus mechanisms that validate transactions and maintain the network without centralized intermediaries.</p>

      <p><b>1. Protocol Mining:</b> Protocol mining activities, including mining on proof-of-work networks and participation in mining pools, generally do not involve the offer or sale of securities. In these networks, miners contribute computational resources to validate transactions and add new blocks, earning rewards distributed programmatically by the protocol. Individual miners do not rely on the essential managerial efforts of others, but instead use their own resources to secure the network and receive rewards. Similarly, in mining pools, although pool operators coordinate activity, their role is administrative or ministerial, and individual miners continue to perform the underlying validation work.</p>

      <p><b>2. Staking:</b> Through self or solo staking, participants stake their own digital commodities and receive protocol-determined rewards. In custodial arrangements, the custodian acts as an agent and performs administrative or ministerial functions without determining whether, when, or how much to stake. In liquid staking arrangements, providers stake on behalf of depositors and may issue receipt tokens, but these activities are not treated as essential managerial efforts. Accordingly, these staking arrangements generally do not involve the offer or sale of securities when conducted in the manner and under the circumstances described above.</p>

      <p>The Joint Interpretation also addresses staking receipt tokens. When such tokens merely represent a claim on deposited non-security crypto assets and their associated rewards, and those assets are not subject to an investment contract, their offer and sale do not involve securities transactions. However, different conclusions may apply where the underlying asset is itself a security or remains subject to an investment contract.</p>

      <p><b>3. Wrapping:</b> Redeemable wrapped tokens issued on a one-to-one basis for deposited crypto assets generally do not involve securities transactions when they function solely as receipts. These tokens must be fully backed, redeemable on a fixed basis, and not used for independent profit-generating activities. Where those conditions are met, the wrapped token does not have the economic characteristics of a security.</p>

      <p><b>4. Airdrops:</b> Where non-security crypto assets are distributed without the provision of money, goods, or services, those distributions generally do not involve the offer or sale of securities. This includes certain retroactive or unannounced distributions based on prior network activity. However, the analysis may differ where recipients provide consideration or where the underlying asset is itself a security.</p>

      <h3>Conclusion</h3>
      <p>The Joint Interpretation does not change the governing legal standard. <em>Howey</em> remains the controlling test. What it does is clarify how that test applies to crypto assets and related transactions.</p>

      <p>It introduces a functional taxonomy that distinguishes among different types of crypto assets while separating the nature of the asset from the circumstances of its offer and sale. In doing so, it emphasizes that issuer conduct and purchaser expectations are central to determining whether an investment contract exists.</p>

      <p>The Joint Interpretation also frames that analysis as dynamic. A non-security crypto asset may become subject to an investment contract based on issuer representations tied to essential managerial efforts, and may later separate from that contract once those representations are fulfilled or no longer relevant.</p>

      <p>It further provides targeted guidance on common crypto activities. Mining, staking, wrapping, and certain airdrops generally do not involve securities transactions when conducted as described, while tokenized securities remain securities regardless of form and stablecoins require careful, fact-specific analysis.</p>

      <p>For market participants, the guidance provides both clarity and constraint. Digital commodities, collectibles, and tools are generally not securities as assets, but transactions involving them may still give rise to investment contracts. Issuers should carefully structure disclosures, define milestones, and communicate clearly to support separation, while recognizing that failure to register or comply with antifraud obligations remains actionable even if an asset later separates from an investment contract.</p>

      <p>Participants in mining, staking, and related activities can take comfort that their core functions, as described, generally fall outside the securities laws. However, deviations from those parameters or involvement with assets that are securities or remain subject to investment contracts may change that analysis. Similarly, providers of staking receipt tokens or wrapped assets must distinguish between receipts for non-security assets and instruments tied to securities or ongoing investment contracts.</p>

      <p>Finally, the Joint Interpretation reflects an evolving regulatory approach. The SEC has invited public comment and may refine or expand its position. Market participants should monitor developments closely and assess how the guidance affects their activities, product design, and compliance obligations.</p>

      <div class="footnotes">
        <div class="footnote-title">Footnotes</div>
        <ol>
          <li>SEC & CFTC Joint Interpretation Regarding the Application of Federal Securities Laws to Crypto Assets, Securities Act Release No. 33-11412 (Mar. 17, 2026).</li>
          <li><em>SEC v. W.J. Howey Co.</em>, 328 U.S. 293, 298–99 (1946).</li>
          <li>Joint Interpretation, supra note 1.</li>
          <li>Id.</li>
          <li>Joint Interpretation, supra note 1; <em>Howey</em>, 328 U.S. at 298–99.</li>
          <li>Joint Interpretation, supra note 1.</li>
          <li>Securities Act of 1933 sections 5, 17(a), 15 U.S.C. sections 77e, 77q(a).</li>
          <li>Joint Interpretation, supra note 1.</li>
        </ol>
      </div>
    `,
    link: ""
  },
];
