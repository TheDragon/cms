import { useEffect, useMemo, useState } from "react";
import { useCurrentAccount, useSuiClientQuery } from "@mysten/dapp-kit";
import { WALRUS_VIEW_URL, getRegistryId, setRegistryId as setStoredRegistryId } from "../config";
import { DEFAULT_PBKDF2_ITERATIONS, decryptWithPassphrase, fromBase64Url } from "../lib/crypto";
import { asMoveFields, decodeMoveString, extractVecSetAddresses } from "../lib/move";
import { buildWalrusBlobUrl, parseWalrusRef } from "../lib/walrus";

export default function Verify() {
  const account = useCurrentAccount();
  const [credentialId, setCredentialId] = useState("");
  const [registryId, setRegistryId] = useState(() => getRegistryId());
  const [decryptPassphrase, setDecryptPassphrase] = useState("");
  const [decryptMsg, setDecryptMsg] = useState("");
  const [decryptError, setDecryptError] = useState("");
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [decryptedUrl, setDecryptedUrl] = useState("");
  const [decryptedName, setDecryptedName] = useState("");

  const credQuery = useSuiClientQuery(
    "getObject",
    { id: credentialId || "0x0", options: { showType: true, showContent: true, showOwner: true } },
    { enabled: !!credentialId }
  );

  const registryQuery = useSuiClientQuery(
    "getObject",
    { id: registryId || "0x0", options: { showContent: true, showType: true } },
    { enabled: !!registryId }
  );

  const credFields = useMemo(() => asMoveFields(credQuery.data), [credQuery.data]);
  const regFields = useMemo(() => asMoveFields(registryQuery.data), [registryQuery.data]);

  const looksCredential = credQuery.data?.data?.type?.includes("::Credential");
  const revokedList = useMemo(() => extractVecSetAddresses(regFields?.revoked), [regFields]);
  const isRevoked = useMemo(() => revokedList.includes(credentialId), [revokedList, credentialId]);
  const docRef = useMemo(() => decodeMoveString(credFields?.doc_ref), [credFields]);
  const walrusRef = useMemo(() => parseWalrusRef(docRef), [docRef]);
  const walrusUrl = useMemo(() => buildWalrusBlobUrl(WALRUS_VIEW_URL, walrusRef), [WALRUS_VIEW_URL, walrusRef]);
  const isEncrypted = walrusRef?.meta?.enc === "v1";

  useEffect(() => {
    return () => {
      if (decryptedUrl) {
        URL.revokeObjectURL(decryptedUrl);
      }
    };
  }, [decryptedUrl]);

  useEffect(() => {
    setDecryptMsg("");
    setDecryptError("");
    setDecryptedUrl("");
    setDecryptedName("");
  }, [docRef]);

  function safeDecode(value: string): string {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  async function decryptAttachment() {
    if (!walrusRef) {
      setDecryptError("No attachment link found.");
      return;
    }
    if (!walrusUrl) {
      setDecryptError("Attachment viewer is not configured.");
      return;
    }
    if (!isEncrypted) {
      setDecryptError("This attachment is not encrypted.");
      return;
    }
    if (!decryptPassphrase) {
      setDecryptError("Enter the passphrase to unlock.");
      return;
    }

    const saltEncoded = walrusRef.meta.salt;
    const ivEncoded = walrusRef.meta.iv;
    if (!saltEncoded || !ivEncoded) {
      setDecryptError("Attachment info is incomplete.");
      return;
    }

    const iterations = Number(walrusRef.meta.iter || DEFAULT_PBKDF2_ITERATIONS);
    if (!Number.isFinite(iterations) || iterations <= 0) {
      setDecryptError("Attachment info is invalid.");
      return;
    }

    setDecryptError("");
    setDecryptMsg("");
    setIsDecrypting(true);
    setDecryptedUrl("");
    setDecryptedName("");

    try {
      const res = await fetch(walrusUrl);
      if (!res.ok) {
        throw new Error(`Download failed (${res.status} ${res.statusText}).`);
      }

      const cipher = await res.arrayBuffer();
      const salt = fromBase64Url(saltEncoded);
      const iv = fromBase64Url(ivEncoded);
      const plaintext = await decryptWithPassphrase(cipher, decryptPassphrase, salt, iv, iterations);

      const mime = walrusRef.meta.mime ? safeDecode(walrusRef.meta.mime) : "application/octet-stream";
      const name = walrusRef.meta.name ? safeDecode(walrusRef.meta.name) : "attachment";
      const blob = new Blob([plaintext], { type: mime || "application/octet-stream" });
      const url = URL.createObjectURL(blob);

      setDecryptedUrl(url);
      setDecryptedName(name);
      setDecryptMsg("Unlocked. You can download the file.");
    } catch (err) {
      setDecryptError(String(err));
    } finally {
      setIsDecrypting(false);
    }
  }

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Verify Certificate</h2>
      <p className="small">You do not need a wallet to verify.</p>

      <div className="row" style={{ marginTop: 12 }}>
        <div>
          <label className="small">Certificate ID</label>
          <input value={credentialId} onChange={(e) => setCredentialId(e.target.value)} placeholder="0x... certificate id" />
        </div>
        <div>
          <label className="small">Registry ID (shared list)</label>
          <input
            value={registryId}
            onChange={(e) => {
              setRegistryId(e.target.value);
              setStoredRegistryId(e.target.value);
            }}
            placeholder="0x... registry id"
          />
        </div>
      </div>

      {credQuery.isPending && (
        <p className="small" style={{ marginTop: 12 }}>
          Loading certificate...
        </p>
      )}
      {credQuery.error && <p style={{ marginTop: 12 }}>Error: {String(credQuery.error)}</p>}

      {credFields && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="row" style={{ alignItems: "center" }}>
            <h3 style={{ margin: 0, flex: 1 }}>Certificate Details</h3>
            {looksCredential ? <span className="badge ok">Certificate</span> : <span className="badge bad">Not a certificate</span>}
            {registryId ? isRevoked ? <span className="badge bad">Revoked</span> : <span className="badge ok">Valid</span> : <span className="badge">No registry</span>}
          </div>

          <div style={{ marginTop: 12 }}>
            <p className="small">Issued by</p>
            <pre>{credFields.issuer || "(missing)"}</pre>

            <p className="small">Recipient</p>
            <pre>{credFields.recipient || "(missing)"}</pre>

            <p className="small">Batch</p>
            <pre>{credFields.context || "(missing)"}</pre>

            <p className="small">Title</p>
            <pre>{decodeMoveString(credFields.title)}</pre>

            <p className="small">Issued at (timestamp)</p>
            <pre>{String(credFields.issued_at_ms ?? "(missing)")}</pre>

            <p className="small">Attachment link</p>
            <pre>{docRef || "(missing)"}</pre>
            {walrusUrl && (
              <p className="small" style={{ marginTop: 8 }}>
                Attachment:{" "}
                <a href={walrusUrl} target="_blank" rel="noreferrer">
                  Open file
                </a>
              </p>
            )}
            {isEncrypted && (
              <div style={{ marginTop: 12 }}>
                <p className="small">This file is locked. Enter the passphrase to open it here.</p>
                <label className="small">Passphrase</label>
                <input
                  type="password"
                  value={decryptPassphrase}
                  onChange={(e) => {
                    setDecryptPassphrase(e.target.value);
                    setDecryptError("");
                    setDecryptMsg("");
                  }}
                  placeholder="Passphrase"
                />
                <button className="btn" style={{ marginTop: 8 }} disabled={isDecrypting} onClick={decryptAttachment}>
                  {isDecrypting ? "Unlocking..." : "Unlock file"}
                </button>
                {decryptMsg && (
                  <p className="small" style={{ marginTop: 8 }}>
                    {decryptMsg}
                  </p>
                )}
                {decryptError && (
                  <p className="small" style={{ marginTop: 8 }}>
                    {decryptError}
                  </p>
                )}
                {decryptedUrl && (
                  <p className="small" style={{ marginTop: 8 }}>
                    Unlocked file:{" "}
                    <a href={decryptedUrl} download={decryptedName || "attachment"}>
                      Download
                    </a>
                  </p>
                )}
              </div>
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
        <h3 style={{ marginTop: 0 }}>How revocation is checked</h3>
        <p className="small">
          We read the shared registry and check whether this certificate ID is on the revoked list.
        </p>
        {registryQuery.isPending && <p className="small">Loading registry...</p>}
        {registryQuery.error && <p>Error: {String(registryQuery.error)}</p>}
        {registryId && !regFields && !registryQuery.isPending && <p className="small">Registry loaded, but details could not be read.</p>}
      </div>
    </div>
  );
}
