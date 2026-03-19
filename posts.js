// ============================================================
//  YOUR BLOG POSTS — Edit this file to add new articles
//  Copy one of the blocks below, paste it at the top of the
//  array (after the first "["), fill in your content, save.
// ============================================================

const POSTS = [
 {
    id: "testing-footnotes",
    date: "March 10, 2025",
    category: "Test",
    title: "TEST",
    summary: "testing footnotes",
    content: `
      <p><p>Your paragraph text with a citation.<sup>[1]</sup> More text here with another reference.<sup>[2]</sup></p>Your paragraph text with a citation.<sup>[1]</sup> More text here with another reference.<sup>[2]</sup></p>
      <h3>What GENIUS Does</h3>
      <p>The GENIUS Act establishes a federal framework for payment stablecoin issuers, creating reserve requirements, redemption rights, and a tiered regulatory structure that distinguishes between bank and nonbank issuers. Critically, it preempts certain state money transmission laws while preserving state innovation where consistent with federal minimums.</p>
      <h3>What CLARITY Does</h3>
      <p>The CLARITY Act draws clearer jurisdictional lines between the SEC and CFTC for digital commodities and investment contracts, providing long-sought guidance on when a digital asset is treated as a security versus a commodity. The functional test adopted largely tracks the Howey framework but introduces safe harbors for sufficiently decentralized networks.</p>
      <h3>Open Questions</h3>
      <p>Despite the progress, implementation will raise difficult questions around custody, interoperability with DeFi protocols, and treatment of wrapped assets. The coming months of rulemaking will be critical for practitioners advising clients in this space.</p>
      <div class="footnotes">
        <div class="footnote-title">Footnotes</div>
        <ol>
          <li>SEC v. W.J. Howey Co., 328 U.S. 293 (1946).</li>
          <li>17 C.F.R. § 240.10b-5 (2024).</li>
          <li>Blockchain Association, Comment Letter on Crypto Asset Custody (Mar. 2024).</li>
        </ol>
      </div>
    `
  },
  {
    id: "genius-clarity-acts-2025",
    date: "March 10, 2025",
    category: "Legislation",
    title: "Breaking Down the GENIUS and CLARITY Acts: What Bipartisan Passage Means for Digital Asset Markets",
    summary: "A close reading of the GENIUS and CLARITY Acts and their implications for stablecoin issuers, exchanges, and registered investment advisers operating in the digital asset ecosystem.",
    content: `
      <p>The bipartisan passage of the GENIUS and CLARITY Acts marks a pivotal moment in U.S. digital asset regulation. For years, the industry has operated under enforcement-driven guidance, with agencies like the SEC and CFTC asserting jurisdiction through litigation rather than rulemaking. These two statutes represent a significant shift toward legislative clarity.</p>
      <h3>What GENIUS Does</h3>
      <p>The GENIUS Act establishes a federal framework for payment stablecoin issuers, creating reserve requirements, redemption rights, and a tiered regulatory structure that distinguishes between bank and nonbank issuers. Critically, it preempts certain state money transmission laws while preserving state innovation where consistent with federal minimums.</p>
      <h3>What CLARITY Does</h3>
      <p>The CLARITY Act draws clearer jurisdictional lines between the SEC and CFTC for digital commodities and investment contracts, providing long-sought guidance on when a digital asset is treated as a security versus a commodity. The functional test adopted largely tracks the Howey framework but introduces safe harbors for sufficiently decentralized networks.</p>
      <h3>Open Questions</h3>
      <p>Despite the progress, implementation will raise difficult questions around custody, interoperability with DeFi protocols, and treatment of wrapped assets. The coming months of rulemaking will be critical for practitioners advising clients in this space.</p>
    `
  },
  {
    id: "sec-rfi-custody",
    date: "February 3, 2025",
    category: "Regulation",
    title: "The SEC's RFI on Crypto Asset Custody: Key Issues for Registered Investment Advisers",
    summary: "An analysis of the SEC's Request for Information on crypto asset custody obligations and what it signals for RIAs navigating compliance in a rapidly evolving regulatory environment.",
    content: `
      <p>The SEC's Request for Information on crypto asset custody by registered investment advisers opens a critical dialogue about how existing custody rules—designed for traditional securities—apply to digital assets held on-chain.</p>
      <h3>The Core Tension</h3>
      <p>The Investment Advisers Act requires RIAs to maintain client assets with a "qualified custodian." For digital assets, the question of what qualifies—and whether self-custody arrangements can ever satisfy this standard—remains unresolved. The RFI signals the Commission is actively rethinking these requirements.</p>
      <h3>Key Submissions and Themes</h3>
      <p>Industry responses highlighted three recurring themes: the need for technology-neutral standards, the unique risks of key management versus traditional custodial risk, and the challenge of satisfying surprise examination requirements for on-chain holdings. Several submissions called for a safe harbor tied to SOC 2 audits or similar third-party verification.</p>
      <h3>What Advisers Should Watch</h3>
      <p>Until formal guidance issues, RIAs should document their custody arrangements carefully, assess counterparty risk with any digital asset custodians, and monitor enforcement posture for signals about staff priorities.</p>
    `
  },
];
