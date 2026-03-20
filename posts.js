// ============================================================
//  YOUR BLOG POSTS — Edit this file to add new articles
//  Copy one of the blocks below, paste it at the top of the
//  array (after the first "["), fill in your content, save.
// ============================================================

const POSTS = [
  {
    id: "sec-cftc-joint-interpretation-crypto",
    date: "March 17, 2026",
    category: "Regulatory Developments",
    title: "SEC and CFTC Issue Joint Interpretation on Crypto Assets, Drawing a Clearer Line Between Securities and Non-Securities",
    summary: "The SEC and CFTC’s March 17, 2026 joint interpretation clarifies how federal securities laws apply to crypto assets, reaffirming Howey while introducing a functional taxonomy and guidance on staking, mining, and token separation.",
    content: `
      <p>On March 17, 2026, the Securities and Exchange Commission and Commodity Futures Trading Commission issued a joint interpretation addressing how the federal securities laws apply to certain crypto assets and transactions involving crypto assets.<sup>[1]</sup> The release reflects the SEC’s view that most crypto assets are not themselves securities, while the CFTC states that it will administer the Commodity Exchange Act consistently with the interpretation.</p>

      <h3>Background: Howey, The DAO, and the Need for Guidance</h3>
      <p>The SEC’s analysis of crypto assets is grounded in the Supreme Court’s decision in SEC v. W.J. Howey Co., which defines an investment contract as a transaction involving an investment of money in a common enterprise with a reasonable expectation of profits to be derived from the efforts of others.<sup>[2]</sup> The Commission first applied this framework to crypto assets in its 2017 DAO Report, concluding that certain digital tokens were offered and sold as investment contracts and therefore as securities.</p>
      <p>The Joint Interpretation explains that applying Howey to crypto assets has proven difficult due to the diversity of token structures, varying degrees of decentralization, and the evolving nature of crypto systems.<sup>[3]</sup> The release is intended to provide clarity on how the SEC applies this framework in modern crypto markets.</p>

      <h3>A Five-Part Taxonomy for Crypto Assets</h3>
      <p>The release introduces a functional classification system for crypto assets, dividing them into digital commodities, digital collectibles, digital tools, stablecoins, and digital securities.<sup>[4]</sup></p>
      <p>Digital commodities are associated with functional crypto systems and derive value from the operation of those systems rather than from managerial efforts of others. The release identifies widely traded crypto assets such as Bitcoin and Ether as examples.<sup>[5]</sup> Digital collectibles, including NFTs and meme coins, generally are not securities, although certain arrangements may still constitute investment contracts. Digital tools, such as tickets, credentials, and memberships, are likewise generally not securities when acquired for consumptive or functional use.</p>
      <p>Stablecoins are treated separately. Certain payment stablecoins are not securities, while others require a facts-and-circumstances analysis.<sup>[6]</sup> Digital securities, by contrast, remain securities regardless of whether they are represented onchain or offchain.<sup>[7]</sup></p>

      <h3>Investment Contracts and Economic Reality</h3>
      <p>A central theme of the interpretation is that a crypto asset that is not itself a security may nonetheless be offered and sold as part of an investment contract.<sup>[8]</sup> The analysis depends on the economic realities of the transaction, including how the asset is marketed and the extent to which purchasers rely on the efforts of others. The SEC emphasizes that detailed issuer representations regarding future development and managerial efforts are critical to this analysis.</p>

      <h3>Separation from an Investment Contract</h3>
      <p>The release explains that a crypto asset may cease to be associated with an investment contract where purchasers no longer reasonably rely on the issuer’s efforts, including where those efforts have been completed or abandoned.<sup>[9]</sup> In such circumstances, subsequent transactions may fall outside the securities laws.</p>
      <p>However, separation does not eliminate potential liability associated with the original offering, including liability for unregistered offers and sales or material misstatements or omissions.<sup>[10]</sup></p>

      <h3>Mining, Staking, Wrapping, and Airdrops</h3>
      <p>The interpretation also provides guidance on common crypto activities. Proof-of-work mining and certain mining pool activities generally do not involve securities transactions. Similarly, certain staking arrangements, wrapping transactions, and airdrops where no consideration is provided generally do not involve the offer and sale of securities when conducted in the manner and under the circumstances described in the release.<sup>[11]</sup></p>

      <h3>Tokenized Securities</h3>
      <p>The agencies emphasize that tokenization does not alter the legal character of an instrument. A traditional security remains a security even if represented as a crypto asset or recorded on a blockchain.</p>

      <h3>Bottom Line</h3>
      <p>The Joint Interpretation does not change the governing legal standard. Howey remains the controlling test. What the release does is clarify how that test applies across the full lifecycle of a crypto asset. It distinguishes between the nature of the asset and the circumstances of its offer and sale, introduces a functional taxonomy to organize different types of crypto assets, and places particular weight on issuer conduct and purchaser expectations in determining whether an investment contract exists. It also addresses how that analysis can evolve over time, including when a crypto asset may separate from an investment contract, and provides guidance on common activities such as mining, staking, wrapping, and airdrops. Taken together, the release reflects a more structured and comprehensive approach to applying the federal securities laws to crypto markets, while reaffirming that economic reality, not labels or form, remains the decisive factor.</p>

      <div class="footnotes">
        <div class="footnote-title">Footnotes</div>
        <ol>
          <li>SEC & CFTC Joint Interpretation Regarding the Application of Federal Securities Laws to Crypto Assets, Securities Act Release No. 33-11412 (Mar. 17, 2026).</li>
          <li>SEC v. W.J. Howey Co., 328 U.S. 293, 298–99 (1946).</li>
          <li>Joint Interpretation, supra note 1.</li>
          <li>Id.</li>
          <li>Id.</li>
          <li>Id.</li>
          <li>Securities Act of 1933 § 2(a)(1), 15 U.S.C. § 77b(a)(1); Securities Exchange Act of 1934 § 3(a)(10), 15 U.S.C. § 78c(a)(10).</li>
          <li>Joint Interpretation, supra note 1; Howey, 328 U.S. at 298–99.</li>
          <li>Joint Interpretation, supra note 1.</li>
          <li>Securities Act of 1933 §§ 5, 17(a), 15 U.S.C. §§ 77e, 77q(a).</li>
          <li>Joint Interpretation, supra note 1.</li>
          <li>Framework for “Investment Contract” Analysis of Digital Assets, SEC Strategic Hub for Innovation & Financial Technology (Apr. 3, 2019), superseded by Securities Act Release No. 33-11412.</li>
        </ol>
      </div>
    `
  },
];
