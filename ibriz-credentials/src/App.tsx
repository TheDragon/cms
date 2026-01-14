import { useEffect, useMemo, useState } from "react";
import { ConnectButton, useCurrentAccount, useSuiClientQuery } from "@mysten/dapp-kit";
import { NETWORK, TYPES } from "./config";
import Issue from "./pages/Issue";
import Verify from "./pages/Verify";
import Revocations from "./pages/Revocations";

type Tab = "issue" | "verify" | "revoke";

export default function App() {
  const [tab, setTab] = useState<Tab>("verify");
  const account = useCurrentAccount();
  const capQuery = useSuiClientQuery(
    "getOwnedObjects",
    {
      owner: account?.address ?? "0x0",
      filter: { StructType: TYPES.IssuerCap },
      options: { showType: true },
    },
    { enabled: !!account }
  );
  const isIssuer = useMemo(() => {
    const first = capQuery.data?.data?.[0];
    return !!first?.data?.objectId;
  }, [capQuery.data]);
  const tabs = useMemo<Tab[]>(() => (isIssuer ? ["issue", "verify", "revoke"] : ["issue", "verify"]), [isIssuer]);

  useEffect(() => {
    if (!tabs.includes(tab)) {
      setTab("verify");
    }
  }, [tab, tabs]);

  const tabMeta: Record<Tab, { title: string; subtitle: string }> = {
    issue: {
      title: "Issue certificates",
      subtitle: "Create programs, attach files, and publish certificates in bulk.",
    },
    verify: {
      title: "My certificates",
      subtitle: account ? "See certificates owned by the connected wallet." : "Connect a wallet to view your certificates.",
    },
    revoke: {
      title: "Revoke certificates",
      subtitle: "Admin-only control to invalidate a certificate from the shared list.",
    },
  };
  const tabTips: Record<Tab, { title: string; items: string[]; note: string }> = {
    issue: {
      title: "Admin checklist",
      items: ["Connect the admin wallet", "Create the organization profile", "Create a program", "Add recipients and issue"],
      note: "Your organization ID stays in this browser after setup.",
    },
    verify: {
      title: "Viewer tips",
      items: ["Wallet required", "Certificates load automatically", "Optional revocation check in advanced settings"],
      note: "Attachments open only when your wallet is on the access list.",
    },
    revoke: {
      title: "Revocation tips",
      items: ["Admin wallet required", "Organization ID must match the issuer", "Revocation is permanent once confirmed"],
      note: "Revoked certificates stay in the shared list.",
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
            My Certificates
          </button>
          {isIssuer && (
            <button className={`side-tab ${tab === "revoke" ? "active" : ""}`} onClick={() => setTab("revoke")}>
              Revoke
            </button>
          )}
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
            {tab === "issue" ? (
              <>
                <div id="issue-sidebar" />
                <div className="card" style={{ marginTop: 12 }}>
                  <h3 style={{ marginTop: 0 }}>Need help?</h3>
                  <p className="small">
                    If something is unclear, share the screen and we will walk through the steps together.
                  </p>
                </div>
              </>
            ) : (
              <>
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
              </>
            )}
          </aside>
        </div>
      </main>
    </div>
  );
}
