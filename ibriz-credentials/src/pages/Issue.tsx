import { useMemo, useState } from "react";
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient, useSuiClientQuery } from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { MODULE, PACKAGE_ID, TYPES, WALRUS_UPLOAD_URL, getRegistryId, setRegistryId } from "../config";
import { AES_GCM_IV_BYTES, DEFAULT_PBKDF2_ITERATIONS, SALT_BYTES, encryptWithPassphrase, toBase64Url } from "../lib/crypto";

function target(fn: string) {
  return `${PACKAGE_ID}::${MODULE}::${fn}`;
}

function getEventField(res: unknown, eventSuffix: string, keys: string[]): string {
  const events: any[] = (res as any)?.events || [];
  const match = events.find((e) => typeof e?.type === "string" && e.type.endsWith(eventSuffix));
  if (!match?.parsedJson) return "";
  for (const key of keys) {
    const value = (match.parsedJson as any)[key];
    if (value) return String(value);
  }
  return "";
}

export default function Issue() {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const [localRegistry, setLocalRegistry] = useState(() => getRegistryId());

  const [ctxTitle, setCtxTitle] = useState("ABC Certificate Batch");
  const [ctxDesc, setCtxDesc] = useState("Issued by iBriz");
  const [contextId, setContextId] = useState("");

  const [recipient, setRecipient] = useState("");
  const [credTitle, setCredTitle] = useState("Certificate of Participation");
  const [docRef, setDocRef] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [uploadMsg, setUploadMsg] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const [msg, setMsg] = useState<string>("");

  const { mutateAsync: signAndExecute, isPending } = useSignAndExecuteTransaction();

  // Detect IssuerCap owned by the connected wallet:
  const capQuery = useSuiClientQuery(
    "getOwnedObjects",
    {
      owner: account?.address ?? "0x0",
      filter: { StructType: TYPES.IssuerCap },
      options: { showType: true },
    },
    { enabled: !!account }
  );

  const issuerCapId = useMemo(() => {
    const d = capQuery.data;
    const first = d?.data?.[0];
    return first?.data?.objectId || "";
  }, [capQuery.data]);

  const isIssuer = !!issuerCapId;
  const passphraseReady = passphrase.length >= 8 && passphrase === confirmPassphrase;

  async function createIssuer() {
    if (!account) return;
    setMsg("");
    const tx = new Transaction();
    tx.moveCall({ target: target("create_issuer"), arguments: [] });

    const res = await signAndExecute({ transaction: tx });

    setLastTx(res.digest);

    let resolvedRegistryId = "";
    let fetchError = "";
    try {
      const txBlock = await client.waitForTransaction({
        digest: res.digest,
        options: { showEvents: true, showObjectChanges: true },
      });
      const blockChanges: any[] = (txBlock as any).objectChanges || [];
      const createdFromBlock = blockChanges.find(
        (c) => c.type === "created" && typeof c.objectType === "string" && c.objectType.includes("::Registry") && (c.owner?.Shared || c.owner?.shared)
      );
      const eventFromBlock = getEventField(txBlock, "::IssuerCreated", ["registry_id", "registryId"]);
      resolvedRegistryId = createdFromBlock?.objectId || eventFromBlock || "";
    } catch (err) {
      fetchError = String(err);
    }

    if (resolvedRegistryId) {
      setRegistryId(resolvedRegistryId);
      setLocalRegistry(resolvedRegistryId);
      setMsg(`Setup complete. Saved your registry ID in this browser: ${resolvedRegistryId}`);
    } else if (fetchError) {
      setMsg(`Setup complete, but we could not find the registry ID. ${fetchError}`);
    } else {
      setMsg("Setup complete. Copy the registry ID from the last transaction and paste it below.");
    }

    // refresh cap query
    capQuery.refetch();
  }

  async function createContext() {
    if (!account || !issuerCapId) return;
    setMsg("");

    const tx = new Transaction();
    tx.moveCall({
      target: target("create_context"),
      arguments: [tx.object(issuerCapId), tx.pure.string(ctxTitle), tx.pure.string(ctxDesc)],
    });

    const res = await signAndExecute({ transaction: tx });

    setLastTx(res.digest);

    let nextContextId = "";
    let fetchError = "";

    try {
      const txBlock = await client.waitForTransaction({
        digest: res.digest,
        options: { showEvents: true, showObjectChanges: true },
      });
      const blockChanges: any[] = (txBlock as any).objectChanges || [];
      const createdFromBlock = blockChanges.find((c) => c.type === "created" && typeof c.objectType === "string" && c.objectType.includes("::Context"));
      const eventFromBlock = getEventField(txBlock, "::ContextCreated", ["context_id", "contextId"]);
      nextContextId = createdFromBlock?.objectId || eventFromBlock || "";
    } catch (err) {
      fetchError = String(err);
    }
    if (!nextContextId && account) {
      try {
        const owned = await client.getOwnedObjects({
          owner: account.address,
          filter: { StructType: TYPES.Context },
          options: { showType: true, showPreviousTransaction: true },
        });
        const match = owned?.data?.find((item: any) => item?.data?.previousTransaction === res.digest);
        nextContextId = match?.data?.objectId || "";
      } catch (err) {
        fetchError = fetchError || String(err);
      }
    }

    if (nextContextId) {
      setContextId(nextContextId);
      setMsg(`Batch created: ${nextContextId}`);
    } else if (fetchError) {
      setMsg(`Batch created, but we could not find the ID. ${fetchError}`);
    } else {
      setMsg("Batch created. Copy the batch ID from the last transaction and paste it below.");
    }
  }

  async function issueCredential() {
    if (!account || !issuerCapId) return;
    if (!localRegistry) return setMsg("Missing registry ID. Run setup once, or paste the registry ID.");
    if (!contextId) return setMsg("Missing batch ID. Create a batch first (or paste one).");
    if (!recipient.startsWith("0x")) return setMsg("Recipient address must start with 0x.");

    setMsg("");

    const tx = new Transaction();
    tx.moveCall({
      target: target("issue_credential"),
      arguments: [
        tx.object(issuerCapId),
        tx.object(localRegistry),
        tx.object(contextId),
        tx.pure.address(recipient),
        tx.pure.string(credTitle),
        tx.pure.string(docRef),
      ],
    });

    const res = await signAndExecute({ transaction: tx });

    setLastTx(res.digest);

    let credentialId = "";
    let fetchError = "";
    try {
      const txBlock = await client.waitForTransaction({
        digest: res.digest,
        options: { showEvents: true, showObjectChanges: true },
      });
      const changes: any[] = (txBlock as any).objectChanges || [];
      const createdCred = changes.find((c) => c.type === "created" && typeof c.objectType === "string" && c.objectType.includes("::Credential"));
      const credFromEvent = getEventField(txBlock, "::CredentialIssued", ["credential_id", "credentialId"]);
      credentialId = createdCred?.objectId || credFromEvent || "";
    } catch (err) {
      fetchError = String(err);
    }

    if (credentialId) {
      setMsg(`Certificate issued. ID: ${credentialId}`);
    } else if (fetchError) {
      setMsg(`Certificate issued, but we could not read the ID. ${fetchError}`);
    } else {
      setMsg("Certificate issued. Copy the certificate ID from the last transaction.");
    }
  }

  async function uploadToWalrus() {
    if (!selectedFile) {
      setUploadError("Choose a file first.");
      return;
    }
    if (!WALRUS_UPLOAD_URL) {
      setUploadError("Upload service is not configured. Please check the app settings.");
      return;
    }
    if (!passphrase) {
      setUploadError("Enter a passphrase to lock the file.");
      return;
    }
    if (passphrase.length < 8) {
      setUploadError("Passphrase needs at least 8 characters.");
      return;
    }
    if (passphrase !== confirmPassphrase) {
      setUploadError("Passphrases do not match.");
      return;
    }

    setUploadError("");
    setUploadMsg("");
    setIsUploading(true);

    try {
      const uploadUrl = WALRUS_UPLOAD_URL.includes("/v1/blobs") ? WALRUS_UPLOAD_URL : `${WALRUS_UPLOAD_URL.replace(/\/$/, "")}/v1/blobs`;
      const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
      const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
      const iterations = DEFAULT_PBKDF2_ITERATIONS;
      const plaintext = await selectedFile.arrayBuffer();
      const ciphertext = await encryptWithPassphrase(plaintext, passphrase, salt, iv, iterations);

      const uploadBody: BodyInit = new Blob([ciphertext], { type: "application/octet-stream" });
      const contentType = "application/octet-stream";

      const encodedName = encodeURIComponent(selectedFile.name || "attachment");
      const encodedMime = encodeURIComponent(selectedFile.type || "application/octet-stream");
      const metaSuffix = `#enc=v1;alg=aesgcm;kdf=pbkdf2;iter=${iterations};salt=${toBase64Url(salt)};iv=${toBase64Url(iv)};name=${encodedName};mime=${encodedMime}`;

      const res = await fetch(uploadUrl, {
        method: "PUT",
        body: uploadBody,
        headers: {
          "Content-Type": contentType,
        },
      });

      if (!res.ok) {
        throw new Error(`Upload failed (${res.status} ${res.statusText}).`);
      }

      const responseContentType = res.headers.get("content-type") || "";
      let data: any = null;
      if (responseContentType.includes("application/json")) {
        data = await res.json();
      } else {
        const text = await res.text();
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }

      let blobId = "";
      let objectId = "";
      if (typeof data === "string") {
        blobId = data.trim();
      } else if (data && typeof data === "object") {
        const top = data;
        const newlyCreated =
          top?.newlyCreated ||
          top?.newly_created ||
          top?.blobStoreResult?.newlyCreated ||
          top?.blobStoreResult?.newly_created ||
          null;
        const alreadyCertified =
          top?.alreadyCertified ||
          top?.already_certified ||
          top?.blobStoreResult?.alreadyCertified ||
          top?.blobStoreResult?.already_certified ||
          null;

        const blobObject = newlyCreated?.blobObject || newlyCreated?.blob_object || null;

        blobId =
          top.blobId ||
          top.blob_id ||
          top?.result?.blobId ||
          top?.result?.blob_id ||
          blobObject?.blobId ||
          blobObject?.blob_id ||
          alreadyCertified?.blob_id ||
          alreadyCertified?.blobId ||
          "";
        objectId =
          top.id ||
          top?.result?.id ||
          blobObject?.id ||
          alreadyCertified?.object ||
          "";
      }

      if (!blobId && !objectId) {
        throw new Error("Upload completed, but we could not link the file. Please try again.");
      }

      const walrusRefBase = blobId
        ? blobId.startsWith("walrus://")
          ? blobId
          : `walrus://${blobId}`
        : objectId.startsWith("walrus-object://")
          ? objectId
          : `walrus-object://${objectId}`;
      const walrusRef = `${walrusRefBase}${metaSuffix}`;
      setDocRef(walrusRef);
      setUploadMsg(`Uploaded "${selectedFile.name}". Attachment link saved (encrypted).`);
    } catch (err) {
      setUploadError(String(err));
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Issue Certificates (Admin)</h2>

      {!account ? (
        <p className="small">Connect your wallet to issue certificates.</p>
      ) : (
        <p className="small">
          Connected wallet: <span className="badge">{account.address}</span>
        </p>
      )}

      <div className="row" style={{ marginTop: 12 }}>
        <div className="card" style={{ flex: 1 }}>
          <h3 style={{ marginTop: 0 }}>Admin setup</h3>
          <p className="small">Admin access detected: {isIssuer ? <span className="badge ok">Yes</span> : <span className="badge bad">No</span>}</p>

          {!isIssuer && (
            <button className="btn" disabled={!account || isPending} onClick={createIssuer}>
              Set up admin access (one-time)
            </button>
          )}
          {isIssuer && (
            <div style={{ marginTop: 8 }}>
              <button className="btn" disabled={!account || isPending} onClick={createIssuer}>
                Create a new registry anyway
              </button>
              <p className="small">This creates a new admin key and a new shared list for this wallet.</p>
            </div>
          )}

          <div style={{ marginTop: 12 }}>
            <label className="small">Registry ID (shared list)</label>
            <input
              value={localRegistry}
              onChange={(e) => {
                setLocalRegistry(e.target.value);
                setRegistryId(e.target.value);
              }}
              placeholder="0x... registry id"
            />
            <p className="small">
              Current registry ID: {localRegistry ? <span className="badge">{localRegistry}</span> : <span className="badge">not set</span>}
            </p>
            <p className="small">Tip: after setup, we save this in your browser.</p>
          </div>
        </div>

        <div className="card" style={{ flex: 1 }}>
          <h3 style={{ marginTop: 0 }}>Batch / Event</h3>
          <label className="small">Title</label>
          <input value={ctxTitle} onChange={(e) => setCtxTitle(e.target.value)} />
          <label className="small" style={{ marginTop: 8, display: "block" }}>
            Description
          </label>
          <input value={ctxDesc} onChange={(e) => setCtxDesc(e.target.value)} />

          <button className="btn" style={{ marginTop: 12 }} disabled={!account || !isIssuer || isPending} onClick={createContext}>
            Create Batch
          </button>

          <div style={{ marginTop: 12 }}>
            <label className="small">Batch ID</label>
            <input value={contextId} onChange={(e) => setContextId(e.target.value)} placeholder="0x... batch id" />
            <p className="small">
              Current batch ID: {contextId ? <span className="badge">{contextId}</span> : <span className="badge">not set</span>}
            </p>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <h3 style={{ marginTop: 0 }}>Issue Certificate</h3>
        <div className="row">
          <div>
            <label className="small">Recipient wallet address</label>
            <input value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="0x... recipient wallet" />
          </div>
          <div>
            <label className="small">Certificate title</label>
            <input value={credTitle} onChange={(e) => setCredTitle(e.target.value)} />
          </div>
        </div>

        <label className="small" style={{ marginTop: 8, display: "block" }}>
          Attachment link (optional)
        </label>
        <input value={docRef} onChange={(e) => setDocRef(e.target.value)} placeholder="Added after upload (or paste a link)" />

        <label className="small" style={{ marginTop: 12, display: "block" }}>
          Attach file (stored on Walrus)
        </label>
        <input
          type="file"
          onChange={(e) => {
            const file = e.target.files?.[0] || null;
            setSelectedFile(file);
            setUploadError("");
            setUploadMsg("");
          }}
        />
        <div style={{ marginTop: 8 }}>
          <label className="small">Passphrase (required to open file)</label>
          <input
            type="password"
            value={passphrase}
            onChange={(e) => {
              setPassphrase(e.target.value);
              setUploadError("");
              setUploadMsg("");
            }}
            placeholder="8+ characters"
          />
          <label className="small" style={{ marginTop: 8, display: "block" }}>
            Confirm passphrase
          </label>
          <input
            type="password"
            value={confirmPassphrase}
            onChange={(e) => {
              setConfirmPassphrase(e.target.value);
              setUploadError("");
              setUploadMsg("");
            }}
            placeholder="Re-enter passphrase"
          />
          {passphrase && passphrase.length < 8 && (
            <p className="small" style={{ marginTop: 6 }}>
              Passphrase needs at least 8 characters.
            </p>
          )}
          {passphrase && confirmPassphrase && passphrase !== confirmPassphrase && (
            <p className="small" style={{ marginTop: 6 }}>
              Passphrases do not match.
            </p>
          )}
        </div>
        <button className="btn" style={{ marginTop: 8 }} disabled={!selectedFile || isUploading || !passphraseReady} onClick={uploadToWalrus}>
          {isUploading ? "Uploading..." : "Encrypt and upload"}
        </button>
        {uploadMsg && <p className="small" style={{ marginTop: 8 }}>{uploadMsg}</p>}
        {uploadError && <p className="small" style={{ marginTop: 8 }}>{uploadError}</p>}

        <button className="btn" style={{ marginTop: 12 }} disabled={!account || !isIssuer || isPending} onClick={issueCredential}>
          Issue Certificate
        </button>

        {msg && <p style={{ marginTop: 12 }}>{msg}</p>}
        {lastTx && (
          <p className="small">
            Last transaction: <span className="badge">{lastTx}</span>
          </p>
        )}
        {capQuery.isPending && <p className="small">Checking admin access...</p>}
      </div>
    </div>
  );
}
