// ============================================================
//  YOUR INSIGHTS — Edit this file to add new entries.
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
    id: "cftc-mlb-prediction-markets-2026",
    slug: "cftc-mlb-agreement-signals-next-step-in-prediction-market-oversight",
    date: "March 19, 2026",
    category: "Regulatory Developments",
    title: "CFTC-MLB Agreement Signals Next Step in Prediction Market Oversight",
    summary: "The CFTC's first formal agreement with a professional sports league establishes a framework for cooperation on sports-related prediction markets.",
    content: `
      <h3>A New Playbook for Prediction Markets and Baseball</h3>
      <p>On March 19, 2026, the CFTC entered into an agreement with Major League Baseball, a unique pairing between a federal market regulator and a professional sports league. The deal centers on prediction markets tied to baseball, a space drawing more attention as it continues to grow. Against that backdrop, the parties signed a [Memorandum of Understanding](https://www.cftc.gov/media/13516/CFTC-MLB_MOU/download) (MOU) aimed at supporting fair markets while protecting the integrity of the game. CFTC Chairman Michael Selig [described](https://www.cftc.gov/PressRoom/PressReleases/9199-26) the MOU as a collaborative step to strengthen these markets, while MLB Commissioner Rob Manfred [emphasized](https://www.mlb.com/press-release/press-release-mlb-names-polymarket-exclusive-prediction-market-exchange-partner-and-signs-agreement-with-cftc-to-establish-iintegrity-framework) that protecting the game remains the league’s top priority.</p>

      <h3>How the CFTC and MLB Plan to Work Together</h3>
      <p>The MOU sets up a structured framework for cooperation between the CFTC and MLB. The parties will meet at least once a month to discuss issues affecting the integrity of baseball and related event contract markets. They can also share information upon request, which should help both sides respond more quickly to potential issues. The agreement includes confidentiality protections, meaning shared information must be kept confidential and remains the record of the providing party. It also limits how that information can be used, with the CFTC restricted to its statutory responsibilities under the Commodity Exchange Act and MLB focused on protecting the integrity of the sport. Taken together, the MOU creates an ongoing channel for coordination rather than a one-time exchange.</p>

      <h3>Why This Happened Now</h3>
      <p>The timing lines up with the CFTC’s recent push on prediction markets. One week earlier, the Division of Market Oversight [issued guidance](https://www.cftc.gov/csl/26-08/download) encouraging exchanges to engage with sports leagues before listing sports-related contracts. The guidance emphasized early communication, alignment with league integrity standards, and the use of official data where appropriate. At the same time, the CFTC issued an Advance Notice of Proposed Rulemaking seeking public comment on broader regulation in this space. Seen in that light, the MLB agreement looks like a direct step in line with that approach.</p>

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
    title: "Drawing a Clearer Line: SEC & CFTC Issue Joint Interpretation on Crypto Assets",
    summary: "The SEC and CFTC's March 17, 2026 joint interpretation clarifies how federal securities laws apply to crypto assets, reaffirming <em>Howey</em> while introducing a functional taxonomy and guidance on staking, mining, and token separation.",
    content: `
      <p>On March 17, 2026, the Securities and Exchange Commission and Commodity Futures Trading Commission issued a joint interpretation addressing how federal securities laws apply to certain crypto assets and related transactions (the Joint Interpretation).<sup>[1]</sup> This guidance reflects the SECs view that most crypto assets are not themselves securities. The CFTC further states that it will administer the Commodity Exchange Act consistently with the interpretation and recognizes that certain non-security crypto assets may constitute commodities subject to its oversight.</p>

      <h3>Background: Howey & the Need for Guidance</h3>
      <p>The SECs analysis of whether a transaction qualifies as an investment contract, and thus a security subject to federal securities laws, is grounded in the Supreme Courts decision in <em>SEC v. W.J. Howey Co.</em><sup>[2]</sup> There, the Court defined an investment contract as a transaction involving an investment of money in a common enterprise with a reasonable expectation of profits derived from the efforts of others. The Commission first applied this framework to crypto assets in its [2017 DAO Report](https://www.sec.gov/files/litigation/investreport/34-81207.pdf), concluding that certain digital tokens were offered and sold as investment contracts and therefore as securities.</p>
      <p>In light of the SEC's prior use of <em>Howey</em>, the Joint Interpretation acknowledges that applying this test in the crypto context has proven difficult given the diversity of token structures, varying degrees of decentralization, and the evolving nature of markets.<sup>[3]</sup></p>

      <h3>A Five-Part Taxonomy for Crypto Assets</h3>
      <p>The Joint Interpretation introduces a functional classification system for crypto assets, dividing them into digital commodities, digital collectibles, digital tools, stablecoins, and digital securities.<sup>[4]</sup></p>

      <p><b>1. Digital Commodities:</b> Digital commodities are crypto assets intrinsically linked to a functional crypto system, deriving value from its programmatic operation and underlying supply-and-demand dynamics. Unlike investment contracts, their value is not based on an expectation of profits from the managerial efforts of others. Instead, they play an integral role in network operation, including validation, transaction fees, governance, and security. They derive value from their utility and broader market dynamics.</p>

      <p><b>2. Digital Collectibles:</b> Digital collectibles, including NFTs and meme coins, are assets designed to be collected or used and typically do not provide rights to enterprise income or assets. Their value generally reflects factors such as subject matter, popularity, scarcity, and market demand, rather than a purchasers expectation of profits from ongoing managerial efforts. However, the Joint Interpretation cautions that fractionalization or similar arrangements may still give rise to an investment contract.</p>

      <p><b>3. Digital Tools:</b> Digital tools, such as tickets, credentials, memberships, and identity-related assets, perform practical functions and derive value from their utility rather than passive yield or enterprise claims. The Joint Interpretation notes that these assets are often non-transferable or programmatically issued and, as described, generally are not securities because they lack the economic characteristics associated with securities.</p>

      <p><b>4. Stablecoins:</b> Stablecoins are treated separately. A stablecoin is a crypto asset designed to maintain a stable value relative to a reference asset, such as the U.S. dollar. Congress enacted the [GENIUS Act](https://www.congress.gov/119/bills/s1582/BILLS-119s1582enr.pdf) in July 2025, establishing a comprehensive regulatory framework for payment stablecoins and excluding from the definition of security any payment stablecoin issued by a permitted payment stablecoin issuer. Because the GENIUS Act is not yet effective, the Joint Interpretation clarifies that the offer and sale of certain Covered Stablecoins do not involve securities transactions. This means persons involved in their issuance and redemption are not required to register those transactions with the SEC. At the same time, the Joint Interpretation emphasizes that stablecoins outside this category may meet the definition of a security depending on the facts and circumstances of their structure and use.</p>

      <p><b>5. Digital Securities:</b> Digital securities, by contrast, remain securities regardless of whether they are represented onchain or offchain. These tokenized instruments fall within the statutory definition of securities, and tokenization does not alter their legal character. The Joint Interpretation emphasizes that a security remains a security irrespective of how it is recorded, even where additional features or benefits are layered onto the instrument.</p>

      <h3>When Offers & Sales of Crypto Assets Involve Investment Contracts</h3>
      <p>A central theme of the Joint Interpretation is that a crypto asset that is not itself a security may nonetheless be offered and sold as part of an investment contract.<sup>[5]</sup> This determination turns on the economic realities of the transaction, including how the asset is marketed, sold, and promoted.</p>

      <p>The Joint Interpretation explains that a non-security crypto asset may become subject to an investment contract where an issuer induces an investment of money in a common enterprise through representations or promises to undertake essential managerial efforts. In these circumstances, purchasers must reasonably expect profits based on those efforts.</p>

      <p>The source, timing, and manner of the issuers representations are central to this analysis. Representations must be conveyed prior to or at the time of the offer or sale to shape purchaser expectations, while post-sale statements generally do not convert a prior transaction into an investment contract.</p>

      <p>The Joint Interpretation further emphasizes the importance of how representations are communicated. Statements made in agreements, official communications, or established public channels are more likely to inform purchaser expectations than informal or unauthorized statements. The SEC also considers whether such representations are broadly disseminated and consistent with the issuers established communication practices.</p>

      <p>Importantly, the content of those representations is critical. Explicit and detailed statements regarding future development, funding, timelines, and managerial efforts are more likely to create a reasonable expectation of profits. By contrast, vague or generalized statements that lack concrete plans or resources are less likely to support an investment contract analysis.</p>

      <h3>Separation from an Investment Contract</h3>
      <p>The Joint Interpretation also addresses the other side of the analysis: whether a crypto asset that was initially sold as part of an investment contract can later cease to be subject to one. Separation occurs when purchasers can no longer reasonably expect the issuers represented managerial efforts to remain connected to the asset.<sup>[6]</sup></p>

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
          <li>Securities Act of 1933 §§ 5, 17(a), 15 U.S.C. §§ 77e, 77q(a).</li>
          <li>Joint Interpretation, supra note 1.</li>
        </ol>
      </div>
    `,
    link: ""
  },
];
