import { ExternalLink } from "../components/ExternalLink";

export function AboutDetails() {
  return (
    <div className="commandAboutDetails">
      <details>
        <summary>Privacy and observation</summary>
        <p>Observe coding-agent sessions without exposing prompts or responses. Pomegr analyzes normalized execution metadata only.</p>
        <p>Pomegr reads local session records and presents a normalized, read-only view. When a provider records a session summary, Pomegr displays bounded plain text and labels where it came from. Efficiency signals come from concrete execution events and documented rules, not hidden AI judgment.</p>
      </details>
      <details>
        <summary>What the estimate means</summary>
        <p>When the optional status-line bridge is connected, Pomegr displays Claude Code&apos;s client-side <code>cost.total_cost_usd</code> session estimate. Claude Code calculates it using standard API list rates, so it can help compare session consumption but may differ from an actual API bill and does not represent the marginal cost of subscription usage. Pomegr does not reconstruct this value from transcript tokens.</p>
      </details>
      <details>
        <summary>Known issues</summary>
        <p><strong>Codex cache-write usage is not available.</strong> Subscription-backed Codex session records currently report cache-write token counts as zero, so Pomegr omits the Cache write metric and cache-write classifications for Codex. Cache-read counts remain available. Follow <ExternalLink href="https://github.com/openai/codex/issues/35300">openai/codex#35300</ExternalLink> for the upstream limitation.</p>
      </details>
      <details>
        <summary>Source and license</summary>
        <p>Copyright © 2026 Leandro Carvalho. Pomegr is free software under the GNU Affero General Public License version 3 only and is provided without warranty. The notices below are copies included in this application.</p>
        <nav aria-label="Legal and source documents">
          <a href="/legal/LICENSE.txt">AGPL license</a>
          <a href="/legal/NOTICE.txt">Copyright and warranty notice</a>
          <a href="/legal/SOURCE.txt">Corresponding source</a>
          <a href="/legal/THIRD_PARTY_NOTICES.txt">Third-party notices</a>
          <a href="/legal/TRADEMARKS.txt">Trademark policy</a>
        </nav>
        <p>The <ExternalLink href="https://github.com/Lecarvalho/pomegr">corresponding source code</ExternalLink> is also available from the official repository.</p>
      </details>
    </div>
  );
}
