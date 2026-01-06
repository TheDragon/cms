import { useMemo, useState } from "react";
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient, useSuiClientQuery } from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { MODULE, PACKAGE_ID, TYPES, WALRUS_UPLOAD_URL, getRegistryId, setRegistryId } from "../config";

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

  const [ctxTitle, setCtxTitle] = useState("ABC Credential Batch");
  const [ctxDesc, setCtxDesc] = useState("Issued by iBriz");
  const [contextId, setContextId] = useState("");

  const [recipient, setRecipient] = useState("");
  const [credTitle, setCredTitle] = useState("Certificate of Participation");
  const [docRef, setDocRef] = useState("walrus://TODO");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadMsg, setUploadMsg] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const [msg, setMsg] = useState<string>("");

  const { mutateAsync: signAndExecute, isPending } = useSignAndExecuteTransaction();

  // Detect IssuerCap owned by the connected wallet:
  const capQuery = useSuiClientQuery(
    "getOwnedObjects",
    account
      ? {
          owner: account.address,
          filter: { StructType: TYPES.IssuerCap },
          options: { showType: true },
        }
      : null
  );

  const issuerCapId = useMemo(() => {
    const d = capQuery.data;
    const first = d?.data?.[0];
    return first?.data?.objectId || "";
  }, [capQuery.data]);

  const isIssuer = !!issuerCapId;

  async function createIssuer() {
    if (!account) return;
    setMsg("");
    const tx = new Transaction();
    tx.moveCall({ target: target("create_issuer"), arguments: [] });

    const res = await signAndExecute({
      transaction: tx,
      options: { showEffects: true, showObjectChanges: true, showEvents: true },
    });

    setLastTx(res.digest);

    // Try to auto-detect Registry ID from object changes:
    const changes: any[] = (res as any).objectChanges || [];
    const createdRegistry = changes.find(
      (c) =>
        c.type === "created" &&
        typeof c.objectType === "string" &&
        c.objectType.includes("::Registry") &&
        (c.owner?.Shared || c.owner?.shared)
    );
    const registryFromEvent = getEventField(res, "::IssuerCreated", ["registry_id", "registryId"]);
    const registryId = createdRegistry?.objectId || registryFromEvent;

    let resolvedRegistryId = registryId;
    let fetchError = "";
    if (!resolvedRegistryId) {
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
    }

    if (resolvedRegistryId) {
      setRegistryId(resolvedRegistryId);
      setLocalRegistry(resolvedRegistryId);
      setMsg(`OK. Issuer created. Registry saved to localStorage: ${resolvedRegistryId}`);
    } else if (fetchError) {
      setMsg(`OK. Issuer created, but registry ID was not detected. ${fetchError}`);
    } else {
      setMsg("OK. Issuer created. Copy the shared Registry objectId from the transaction output and paste it below.");
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

    const res = await signAndExecute({
      transaction: tx,
      options: { showEffects: true, showObjectChanges: true, showEvents: true },
    });

    setLastTx(res.digest);

    // Try to get the Context objectId from created objects:
    const changes: any[] = (res as any).objectChanges || [];
    const createdContext = changes.find((c) => c.type === "created" && typeof c.objectType === "string" && c.objectType.includes("::Context"));
    const contextFromEvent = getEventField(res, "::ContextCreated", ["context_id", "contextId"]);
    let nextContextId = createdContext?.objectId || contextFromEvent;
    let fetchError = "";

    if (!nextContextId) {
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
      setMsg(`OK. Context created: ${nextContextId}`);
    } else if (fetchError) {
      setMsg(`OK. Context created, but ID was not detected. ${fetchError}`);
    } else {
      setMsg("OK. Context created. Copy the Context objectId from the tx output and paste it in the field below.");
    }
  }

  async function issueCredential() {
    if (!account || !issuerCapId) return;
    if (!localRegistry) return setMsg("Error: Missing Registry ID. Create issuer once, or paste the Registry ID.");
    if (!contextId) return setMsg("Error: Missing Context ID. Create a context first (or paste one).");
    if (!recipient.startsWith("0x")) return setMsg("Error: Recipient must be a Sui address (0x...).");

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

    const res = await signAndExecute({
      transaction: tx,
      options: { showEffects: true, showObjectChanges: true, showEvents: true },
    });

    setLastTx(res.digest);

    const changes: any[] = (res as any).objectChanges || [];
    const createdCred = changes.find((c) => c.type === "created" && typeof c.objectType === "string" && c.objectType.includes("::Credential"));
    const credFromEvent = getEventField(res, "::CredentialIssued", ["credential_id", "credentialId"]);
    const credentialId = createdCred?.objectId || credFromEvent;

    if (credentialId) {
      setMsg(`OK. Credential issued. Credential ID: ${credentialId}`);
    } else {
      setMsg("OK. Credential issued. Copy the created Credential objectId from the tx output.");
    }
  }

  async function uploadToWalrus() {
    if (!selectedFile) {
      setUploadError("Pick a file first.");
      return;
    }
    if (!WALRUS_UPLOAD_URL) {
      setUploadError("Missing VITE_WALRUS_UPLOAD_URL in .env (publisher /v1/blobs endpoint).");
      return;
    }

    setUploadError("");
    setUploadMsg("");
    setIsUploading(true);

    try {
      const uploadUrl = WALRUS_UPLOAD_URL.includes("/v1/blobs") ? WALRUS_UPLOAD_URL : `${WALRUS_UPLOAD_URL.replace(/\/$/, "")}/v1/blobs`;

      const res = await fetch(uploadUrl, {
        method: "PUT",
        body: selectedFile,
        headers: {
          "Content-Type": selectedFile.type || "application/octet-stream",
        },
      });

      if (!res.ok) {
        throw new Error(`Upload failed (${res.status} ${res.statusText}).`);
      }

      const contentType = res.headers.get("content-type") || "";
      let data: any = null;
      if (contentType.includes("application/json")) {
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
        throw new Error(`Upload succeeded but no blob id found in response: ${JSON.stringify(data).slice(0, 500)}`);
      }

      const walrusRef = blobId
        ? blobId.startsWith("walrus://")
          ? blobId
          : `walrus://${blobId}`
        : objectId.startsWith("walrus-object://")
          ? objectId
          : `walrus-object://${objectId}`;
      setDocRef(walrusRef);
      setUploadMsg(`Uploaded "${selectedFile.name}". doc_ref updated.`);
    } catch (err) {
      setUploadError(String(err));
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Issue Credentials (ABC Admin)</h2>

      {!account ? (
        <p className="small">Connect a wallet to issue credentials.</p>
      ) : (
        <p className="small">
          Connected: <span className="badge">{account.address}</span>
        </p>
      )}

      <div className="row" style={{ marginTop: 12 }}>
        <div className="card" style={{ flex: 1 }}>
          <h3 style={{ marginTop: 0 }}>Issuer</h3>
          <p className="small">IssuerCap detected: {isIssuer ? <span className="badge ok">Yes</span> : <span className="badge bad">No</span>}</p>

          {!isIssuer && (
            <button className="btn" disabled={!account || isPending} onClick={createIssuer}>
              Create ABC Issuer (one-time)
            </button>
          )}
          {isIssuer && (
            <div style={{ marginTop: 8 }}>
              <button className="btn" disabled={!account || isPending} onClick={createIssuer}>
                Create New Registry Anyway
              </button>
              <p className="small">This mints a new IssuerCap and Registry for this wallet.</p>
            </div>
          )}

          <div style={{ marginTop: 12 }}>
            <label className="small">Registry ID (shared)</label>
            <input
              value={localRegistry}
              onChange={(e) => {
                setLocalRegistry(e.target.value);
                setRegistryId(e.target.value);
              }}
              placeholder="0x... (shared Registry object id)"
            />
            <p className="small">
              Current Registry ID: {localRegistry ? <span className="badge">{localRegistry}</span> : <span className="badge">not set</span>}
            </p>
            <p className="small">Tip: after you create issuer once, we store this in localStorage.</p>
          </div>
        </div>

        <div className="card" style={{ flex: 1 }}>
          <h3 style={{ marginTop: 0 }}>Context (Event / Batch)</h3>
          <label className="small">Title</label>
          <input value={ctxTitle} onChange={(e) => setCtxTitle(e.target.value)} />
          <label className="small" style={{ marginTop: 8, display: "block" }}>
            Description
          </label>
          <input value={ctxDesc} onChange={(e) => setCtxDesc(e.target.value)} />

          <button className="btn" style={{ marginTop: 12 }} disabled={!account || !isIssuer || isPending} onClick={createContext}>
            Create Context
          </button>

          <div style={{ marginTop: 12 }}>
            <label className="small">Context ID</label>
            <input value={contextId} onChange={(e) => setContextId(e.target.value)} placeholder="0x... Context object id" />
            <p className="small">
              Current Context ID: {contextId ? <span className="badge">{contextId}</span> : <span className="badge">not set</span>}
            </p>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <h3 style={{ marginTop: 0 }}>Issue Credential</h3>
        <div className="row">
          <div>
            <label className="small">Recipient Address</label>
            <input value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="0x... recipient address" />
          </div>
          <div>
            <label className="small">Credential Title</label>
            <input value={credTitle} onChange={(e) => setCredTitle(e.target.value)} />
          </div>
        </div>

        <label className="small" style={{ marginTop: 8, display: "block" }}>
          doc_ref (optional)
        </label>
        <input value={docRef} onChange={(e) => setDocRef(e.target.value)} />

        <label className="small" style={{ marginTop: 12, display: "block" }}>
          Attach file (Walrus)
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
        <button className="btn" style={{ marginTop: 8 }} disabled={!selectedFile || isUploading} onClick={uploadToWalrus}>
          {isUploading ? "Uploading..." : "Upload to Walrus"}
        </button>
        {uploadMsg && <p className="small" style={{ marginTop: 8 }}>{uploadMsg}</p>}
        {uploadError && <p className="small" style={{ marginTop: 8 }}>{uploadError}</p>}

        <button className="btn" style={{ marginTop: 12 }} disabled={!account || !isIssuer || isPending} onClick={issueCredential}>
          Issue Credential
        </button>

        {msg && <p style={{ marginTop: 12 }}>{msg}</p>}
        {lastTx && (
          <p className="small">
            Last tx digest: <span className="badge">{lastTx}</span>
          </p>
        )}
        {capQuery.isPending && <p className="small">Checking IssuerCap...</p>}
      </div>
    </div>
  );
}
