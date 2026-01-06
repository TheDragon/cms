import { useState } from "react";
import { ConnectButton } from "@mysten/dapp-kit";
import Issue from "./pages/Issue";
import Verify from "./pages/Verify";
import Revocations from "./pages/Revocations";

type Tab = "issue" | "verify" | "revoke";

export default function App() {
  const [tab, setTab] = useState<Tab>("verify");

  return (
    <>
      <div className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <span className="dot" />
            <span>ABC Credentials</span>
            <span className="badge">Sui</span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div className="nav">
              <button className={`tab ${tab === "issue" ? "active" : ""}`} onClick={() => setTab("issue")}>
                Issue
              </button>
              <button className={`tab ${tab === "verify" ? "active" : ""}`} onClick={() => setTab("verify")}>
                Recruiter Verify
              </button>
              <button className={`tab ${tab === "revoke" ? "active" : ""}`} onClick={() => setTab("revoke")}>
                Revocations
              </button>
            </div>
            <ConnectButton />
          </div>
        </div>
      </div>

      <div className="container" style={{ marginTop: 16 }}>
        {tab === "issue" && <Issue />}
        {tab === "verify" && <Verify />}
        {tab === "revoke" && <Revocations />}
      </div>
    </>
  );
}
