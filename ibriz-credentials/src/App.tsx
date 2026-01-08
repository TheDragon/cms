import { useState } from "react";
import { ConnectButton } from "@mysten/dapp-kit";
import { NETWORK } from "./config";
import Issue from "./pages/Issue";
import Verify from "./pages/Verify";
import Revocations from "./pages/Revocations";

type Tab = "issue" | "verify" | "revoke";

export default function App() {
  const [tab, setTab] = useState<Tab>("verify");
  const tabMeta: Record<Tab, { title: string; subtitle: string }> = {
    issue: {
      title: "Issue certificates",
      subtitle: "Create batches, attach files, and publish certificates in a guided flow.",
    },
    verify: {
      title: "Verify certificates",
      subtitle: "Look up a certificate, check revocations, and unlock attachments.",
    },
    revoke: {
      title: "Revoke certificates",
      subtitle: "Admin-only control to invalidate a certificate from the shared registry.",
    },
  };
  const tabTips: Record<Tab, { title: string; items: string[]; note: string }> = {
    issue: {
      title: "Issuing checklist",
      items: ["Connect the admin wallet", "Run admin setup once", "Create a batch for this event", "Add the recipient and attachment"],
      note: "Your registry ID stays in this browser after setup.",
    },
    verify: {
      title: "Verification tips",
      items: ["No wallet required", "Use the shared registry ID", "Paste the certificate ID", "Use the passphrase to unlock files"],
      note: "If the file is locked, the passphrase comes from the issuer.",
    },
    revoke: {
      title: "Revocation tips",
      items: ["Admin wallet required", "Registry ID must match the issuer", "Revocation is permanent once confirmed"],
      note: "Revoked certificates stay in the registry list.",
    },
  };
  const meta = tabMeta[tab];
  const tips = tabTips[tab];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="dot" />
          <div className="brand-stack">
            <span>ABC Certificates</span>
            <span className="small">Credential Studio</span>
          </div>
        </div>

        <nav className="side-nav">
          <button className={`side-tab ${tab === "issue" ? "active" : ""}`} onClick={() => setTab("issue")}>
            Issue
          </button>
          <button className={`side-tab ${tab === "verify" ? "active" : ""}`} onClick={() => setTab("verify")}>
            Verify
          </button>
          <button className={`side-tab ${tab === "revoke" ? "active" : ""}`} onClick={() => setTab("revoke")}>
            Revoke
          </button>
        </nav>

        <div className="side-divider" />

        <div className="side-wallet">
          <span className="small">Wallet</span>
          <ConnectButton />
          <span className="badge">Network: {NETWORK}</span>
        </div>
      </aside>

      <main className="main">
        <div className="page-hero">
          <div>
            <div className="eyebrow">Certificate workspace</div>
            <h1 className="page-title">{meta.title}</h1>
            <p className="page-subtitle">{meta.subtitle}</p>
          </div>
          <div className="hero-actions">
            <span className="badge">Sui</span>
            <span className="badge">Walrus</span>
          </div>
        </div>

        <div className="main-grid">
          <section className="main-pane">
            {tab === "issue" && <Issue />}
            {tab === "verify" && <Verify />}
            {tab === "revoke" && <Revocations />}
          </section>
          <aside className="side-pane">
            <div className="card">
              <h3 style={{ marginTop: 0 }}>{tips.title}</h3>
              <ul className="info-list">
                {tips.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <p className="small">{tips.note}</p>
            </div>
            <div className="card" style={{ marginTop: 12 }}>
              <h3 style={{ marginTop: 0 }}>Need help?</h3>
              <p className="small">
                If something is unclear, share the screen and we will walk through the steps together.
              </p>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}
