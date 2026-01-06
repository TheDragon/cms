import { useMemo, useState } from "react";
import { useCurrentAccount, useSuiClientQuery } from "@mysten/dapp-kit";
import { TYPES, WALRUS_VIEW_URL, getRegistryId, setRegistryId as setStoredRegistryId } from "../config";
import { asMoveFields, decodeMoveString, extractVecSetAddresses } from "../lib/move";

export default function Verify() {
  const account = useCurrentAccount();
  const [credentialId, setCredentialId] = useState("");
  const [registryId, setRegistryId] = useState(() => getRegistryId());

  const credQuery = useSuiClientQuery("getObject", credentialId ? { id: credentialId, options: { showType: true, showContent: true, showOwner: true } } : null);

  const registryQuery = useSuiClientQuery("getObject", registryId ? { id: registryId, options: { showContent: true, showType: true } } : null);

  const credFields = useMemo(() => asMoveFields(credQuery.data), [credQuery.data]);
  const regFields = useMemo(() => asMoveFields(registryQuery.data), [registryQuery.data]);

  const looksCredential = credQuery.data?.data?.type?.includes("::Credential");
  const revokedList = useMemo(() => extractVecSetAddresses(regFields?.revoked), [regFields]);
  const isRevoked = useMemo(() => revokedList.includes(credentialId), [revokedList, credentialId]);
  const docRef = useMemo(() => decodeMoveString(credFields?.doc_ref), [credFields]);
  const walrusBase = useMemo(() => {
    if (!WALRUS_VIEW_URL) return "";
    const normalized = WALRUS_VIEW_URL.replace(/\/$/, "");
    return normalized.includes("/v1/blobs") ? normalized : `${normalized}/v1/blobs`;
  }, [WALRUS_VIEW_URL]);
  const walrusUrl = useMemo(() => {
    if (!docRef || !walrusBase) return "";
    if (docRef.startsWith("walrus://")) {
      const id = docRef.slice("walrus://".length);
      return id ? `${walrusBase}/${id}` : "";
    }
    if (docRef.startsWith("walrus-object://")) {
      const id = docRef.slice("walrus-object://".length);
      return id ? `${walrusBase}/by-object-id/${id}` : "";
    }
    return "";
  }, [docRef, walrusBase]);

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Recruiter Verify</h2>
      <p className="small">This page works even without wallet connect (connect is optional).</p>

      <div className="row" style={{ marginTop: 12 }}>
        <div>
          <label className="small">Credential Object ID</label>
          <input value={credentialId} onChange={(e) => setCredentialId(e.target.value)} placeholder="0x... credential id" />
        </div>
        <div>
          <label className="small">ABC Registry ID</label>
          <input
            value={registryId}
            onChange={(e) => {
              setRegistryId(e.target.value);
              setStoredRegistryId(e.target.value);
            }}
            placeholder="0x... shared registry id"
          />
        </div>
      </div>

      {credQuery.isPending && (
        <p className="small" style={{ marginTop: 12 }}>
          Loading credential…
        </p>
      )}
      {credQuery.error && <p style={{ marginTop: 12 }}>❌ {String(credQuery.error)}</p>}

      {credFields && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="row" style={{ alignItems: "center" }}>
            <h3 style={{ margin: 0, flex: 1 }}>Credential Details</h3>
            {looksCredential ? <span className="badge ok">Credential</span> : <span className="badge bad">Not a Credential</span>}
            {registryId ? isRevoked ? <span className="badge bad">Revoked</span> : <span className="badge ok">Valid</span> : <span className="badge">No Registry</span>}
          </div>

          <div style={{ marginTop: 12 }}>
            <p className="small">Issuer</p>
            <pre>{credFields.issuer || "(missing)"}</pre>

            <p className="small">Recipient</p>
            <pre>{credFields.recipient || "(missing)"}</pre>

            <p className="small">Context</p>
            <pre>{credFields.context || "(missing)"}</pre>

            <p className="small">Title</p>
            <pre>{decodeMoveString(credFields.title)}</pre>

            <p className="small">Issued at (ms)</p>
            <pre>{String(credFields.issued_at_ms ?? "(missing)")}</pre>

            <p className="small">doc_ref</p>
            <pre>{docRef || "(missing)"}</pre>
            {walrusUrl && (
              <p className="small" style={{ marginTop: 8 }}>
                Attachment:{" "}
                <a href={walrusUrl} target="_blank" rel="noreferrer">
                  Open in Walrus
                </a>
              </p>
            )}
          </div>
        </div>
      )}

      {!!account && (
        <p className="small" style={{ marginTop: 12 }}>
          Connected wallet: <span className="badge">{account.address}</span>
        </p>
      )}

      <div className="card" style={{ marginTop: 12 }}>
        <h3 style={{ marginTop: 0 }}>Revocation Check Source</h3>
        <p className="small">
          We read the shared ABC <code>Registry</code> object and check if this credential ID is in the revoked set.
        </p>
        {registryQuery.isPending && <p className="small">Loading registry…</p>}
        {registryQuery.error && <p>❌ {String(registryQuery.error)}</p>}
        {registryId && !regFields && !registryQuery.isPending && <p className="small">Registry loaded, but fields not readable.</p>}
      </div>
    </div>
  );
}
