import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient, useSuiClientQuery } from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { MODULE, PACKAGE_ID, TYPES, WALRUS_UPLOAD_URL, getRegistryId, setRegistryId } from "../config";
import { asMoveFields, decodeMoveString } from "../lib/move";
import { applyWalrusMeta } from "../lib/walrus";

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

function getParsedEventField(event: any, keys: string[]): string {
  const parsed = event?.parsedJson;
  if (!parsed) return "";
  for (const key of keys) {
    const value = parsed[key];
    if (value) return String(value);
  }
  return "";
}

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

function parseAddressList(input: string): { valid: string[]; invalid: string[] } {
  const parts = input
    .split(/[\s,;]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const validSet = new Set<string>();
  const invalid: string[] = [];
  for (const part of parts) {
    if (/^0x[0-9a-fA-F]+$/.test(part)) {
      validSet.add(normalizeAddress(part));
    } else {
      invalid.push(part);
    }
  }
  return { valid: Array.from(validSet), invalid };
}

function extractAddresses(input: string): string[] {
  return input.match(/0x[0-9a-fA-F]+/g) ?? [];
}

function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

type ProgramHistoryItem = {
  id: string;
  title: string;
  description: string;
  issuedCount: number;
};

const HISTORY_EVENT_LIMIT = 200;
const HISTORY_FETCH_CHUNK = 50;

function buildDocRefForRecipient(baseRef: string, extraAccess: string[]): string {
  const trimmed = baseRef.trim();
  if (!trimmed) return "";
  if (!extraAccess.length) return trimmed;
  const allowList = Array.from(new Set(extraAccess.map(normalizeAddress)));
  if (!allowList.length) return trimmed;
  const aclValue = encodeURIComponent(allowList.join(","));
  return applyWalrusMeta(trimmed, { acl: aclValue });
}

export default function Issue() {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const [localRegistry, setLocalRegistry] = useState(() => getRegistryId());
  const [activeStep, setActiveStep] = useState<1 | 2 | 3>(1);
  const [showOrgAdvanced, setShowOrgAdvanced] = useState(false);
  const [showProgramAdvanced, setShowProgramAdvanced] = useState(false);
  const [showIssueAdvanced, setShowIssueAdvanced] = useState(false);

  const [ctxTitle, setCtxTitle] = useState("ABC Certificate Program");
  const [ctxDesc, setCtxDesc] = useState("Issued by iBriz");
  const [contextId, setContextId] = useState("");

  const [recipientsInput, setRecipientsInput] = useState("");
  const [extraAccessInput, setExtraAccessInput] = useState("");
  const [chunkSize, setChunkSize] = useState(10);
  const [credTitle, setCredTitle] = useState("Certificate of Participation");
  const [docRef, setDocRef] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadMsg, setUploadMsg] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState("");
  const [programHistory, setProgramHistory] = useState<ProgramHistoryItem[]>([]);
  const [historyMsg, setHistoryMsg] = useState("");
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [showProgramHistory, setShowProgramHistory] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ total: number; completed: number; chunk: number; chunks: number } | null>(null);
  const [bulkErrors, setBulkErrors] = useState<string[]>([]);
  const [isBulkIssuing, setIsBulkIssuing] = useState(false);
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
  const recipientsParsed = useMemo(() => parseAddressList(recipientsInput), [recipientsInput]);
  const extraAccessParsed = useMemo(() => parseAddressList(extraAccessInput), [extraAccessInput]);
  const validRecipients = recipientsParsed.valid;
  const invalidRecipients = recipientsParsed.invalid;
  const extraAccess = extraAccessParsed.valid;
  const invalidAccess = extraAccessParsed.invalid;
  const adminReady = isIssuer && !!localRegistry;
  const batchReady = !!contextId;
  const issueReady = adminReady && batchReady && validRecipients.length > 0 && invalidRecipients.length === 0 && invalidAccess.length === 0;
  const step2Enabled = adminReady;
  const step3Enabled = adminReady && batchReady;
  const issueCount = validRecipients.length;
  const issueTargetLabel = issueCount === 1 ? "recipient" : "recipients";
  const issueLabel = selectedFile ? `Upload and issue to ${issueCount} ${issueTargetLabel}` : `Issue to ${issueCount} ${issueTargetLabel}`;

  useEffect(() => {
    if (!selectedFile) {
      setPreviewUrl("");
      return;
    }
    const url = URL.createObjectURL(selectedFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [selectedFile]);

  useEffect(() => {
    setHistoryLoaded(false);
    setProgramHistory([]);
    setHistoryMsg("");
    setShowProgramHistory(false);
  }, [account?.address]);

  async function copyToClipboard(label: string, value: string) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setMsg(`${label} copied.`);
    } catch {
      setMsg(`Unable to copy ${label.toLowerCase()}. Please select and copy it.`);
    }
  }

  async function handleRecipientsFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const found = extractAddresses(text);
      if (!found.length) {
        setMsg("No recipients found in that file.");
        return;
      }
      setRecipientsInput((prev) => {
        const base = prev.trim();
        const incoming = found.join("\n");
        return base ? `${base}\n${incoming}` : incoming;
      });
      setMsg(`Added ${found.length} recipients from ${file.name}.`);
    } catch (err) {
      setMsg(`Could not read that file. ${String(err)}`);
    } finally {
      event.target.value = "";
    }
  }

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
      setMsg("Setup complete. Organization linked to this browser.");
    } else if (fetchError) {
      setMsg(`Setup complete, but we could not find the organization ID. ${fetchError}`);
    } else {
      setMsg("Setup complete. Use advanced options if you need to view or copy the organization ID.");
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
      setMsg("Program created and linked to this browser.");
    } else if (fetchError) {
      setMsg(`Program created, but we could not find the ID. ${fetchError}`);
    } else {
      setMsg("Program created. Use advanced options if you need to view or copy the program ID.");
    }
  }

  const loadProgramHistory = useCallback(async () => {
    if (!account) {
      setHistoryMsg("Connect your wallet to load program history.");
      return;
    }

    setIsHistoryLoading(true);
    setHistoryMsg("");
    setProgramHistory([]);

    try {
      const issuerAddress = normalizeAddress(account.address);
      const contextEventType = `${PACKAGE_ID}::${MODULE}::ContextCreated`;
      const credentialEventType = `${PACKAGE_ID}::${MODULE}::CredentialIssued`;

      const [contextRes, credentialRes] = await Promise.all([
        client.queryEvents({ query: { MoveEventType: contextEventType }, limit: HISTORY_EVENT_LIMIT }),
        client.queryEvents({ query: { MoveEventType: credentialEventType }, limit: HISTORY_EVENT_LIMIT }),
      ]);

      const contextEvents = (contextRes as any)?.data ?? [];
      const credentialEvents = (credentialRes as any)?.data ?? [];

      const contextIds: string[] = [];
      const contextSeen = new Set<string>();

      for (const event of contextEvents) {
        const issuer = normalizeAddress(getParsedEventField(event, ["issuer"]));
        if (!issuer || issuer !== issuerAddress) continue;
        const contextId = getParsedEventField(event, ["context_id", "contextId", "context"]);
        if (contextId && !contextSeen.has(contextId)) {
          contextSeen.add(contextId);
          contextIds.push(contextId);
        }
      }

      const issuedCounts = new Map<string, number>();
      for (const event of credentialEvents) {
        const issuer = normalizeAddress(getParsedEventField(event, ["issuer"]));
        if (!issuer || issuer !== issuerAddress) continue;
        const contextId = getParsedEventField(event, ["context", "context_id", "contextId"]);
        if (!contextId) continue;
        issuedCounts.set(contextId, (issuedCounts.get(contextId) || 0) + 1);
      }

      const details = new Map<string, { title: string; description: string }>();
      const contextChunks = chunkArray(contextIds, HISTORY_FETCH_CHUNK);
      for (const chunk of contextChunks) {
        const objects = await client.multiGetObjects({ ids: chunk, options: { showContent: true } });
        for (const obj of objects) {
          const objectId = obj?.data?.objectId;
          if (!objectId) continue;
          const fields = asMoveFields(obj);
          const title = decodeMoveString(fields?.title) || "Program";
          const description = decodeMoveString(fields?.description) || "";
          details.set(objectId, { title, description });
        }
      }

      const items = contextIds.map((id) => {
        const detail = details.get(id);
        return {
          id,
          title: detail?.title || "Program",
          description: detail?.description || "",
          issuedCount: issuedCounts.get(id) || 0,
        };
      });

      setProgramHistory(items);

      let summary = items.length
        ? `Loaded ${items.length} program${items.length === 1 ? "" : "s"} from the latest on-chain events.`
        : "No programs found for this wallet yet.";
      if ((contextRes as any)?.hasNextPage || (credentialRes as any)?.hasNextPage) {
        summary += " Showing the latest results only.";
      }
      setHistoryMsg(summary);
    } catch (err) {
      setHistoryMsg(`Unable to load program history. ${String(err)}`);
    } finally {
      setIsHistoryLoading(false);
      setHistoryLoaded(true);
    }
  }, [account, client]);

  useEffect(() => {
    if (activeStep !== 2) return;
    if (!account || !isIssuer || historyLoaded || !showProgramHistory) return;
    loadProgramHistory();
  }, [activeStep, account, isIssuer, historyLoaded, loadProgramHistory, showProgramHistory]);

  async function issueCredentialsBulk() {
    if (!account || !issuerCapId) return;
    if (!localRegistry) return setMsg("Missing organization ID. Run setup once, or paste the organization ID.");
    if (!contextId) return setMsg("Missing program ID. Create a program first (or paste one).");
    if (!validRecipients.length) return setMsg("Add at least one recipient.");
    if (invalidRecipients.length) return setMsg("Remove invalid entries before issuing.");
    if (invalidAccess.length) return setMsg("Remove invalid entries from the access list.");

    setMsg("");
    setBulkErrors([]);
    setBulkProgress(null);
    setIsBulkIssuing(true);

    let completed = 0;
    let stage: "upload" | "issue" = "issue";
    try {
      let baseDocRef = docRef;
      if (selectedFile) {
        stage = "upload";
        setMsg("Uploading attachment...");
        baseDocRef = await uploadToWalrus();
        setMsg("Attachment uploaded. Starting issuance...");
      } else {
        setMsg("Starting issuance...");
      }

      stage = "issue";
      const safeChunkSize = Math.max(1, Math.min(chunkSize || 1, 50));
      const chunks = chunkArray(validRecipients, safeChunkSize);
      setBulkProgress({ total: validRecipients.length, completed: 0, chunk: 0, chunks: chunks.length });
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        const tx = new Transaction();
        const capObj = tx.object(issuerCapId);
        const registryObj = tx.object(localRegistry);
        const contextObj = tx.object(contextId);

        for (const recipient of chunk) {
          const docRefForRecipient = buildDocRefForRecipient(baseDocRef, extraAccess);
          tx.moveCall({
            target: target("issue_credential"),
            arguments: [
              capObj,
              registryObj,
              contextObj,
              tx.pure.address(recipient),
              tx.pure.string(credTitle),
              tx.pure.string(docRefForRecipient),
            ],
          });
        }

        const res = await signAndExecute({ transaction: tx });
        setLastTx(res.digest);
        completed += chunk.length;
        setBulkProgress({ total: validRecipients.length, completed, chunk: index + 1, chunks: chunks.length });
        setMsg(`Issued ${completed}/${validRecipients.length} certificates.`);
      }
      setMsg(`Success. Issued ${validRecipients.length} certificates.`);
    } catch (err) {
      const message = String(err);
      const label = stage === "upload" ? "Upload failed" : "Issuing stopped";
      setBulkErrors((prev) => [...prev, message]);
      setMsg(`${label}. Please review the error and try again.`);
    } finally {
      setIsBulkIssuing(false);
    }
  }

  async function uploadToWalrus(): Promise<string> {
    if (!selectedFile) {
      throw new Error("Choose a file first.");
    }
    if (!WALRUS_UPLOAD_URL) {
      throw new Error("Upload service is not configured. Please check the app settings.");
    }

    setUploadError("");
    setUploadMsg("");
    setIsUploading(true);

    try {
      const uploadUrl = WALRUS_UPLOAD_URL.includes("/v1/blobs") ? WALRUS_UPLOAD_URL : `${WALRUS_UPLOAD_URL.replace(/\/$/, "")}/v1/blobs`;
      const contentType = selectedFile.type || "application/octet-stream";
      const uploadBody: BodyInit = new Blob([await selectedFile.arrayBuffer()], { type: contentType });
      const encodedName = encodeURIComponent(selectedFile.name || "attachment");
      const encodedMime = encodeURIComponent(contentType);

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
      const walrusRef = applyWalrusMeta(walrusRefBase, { name: encodedName, mime: encodedMime });
      setDocRef(walrusRef);
      setUploadMsg(`Uploaded "${selectedFile.name}". Attachment link saved.`);
      return walrusRef;
    } catch (err) {
      const message = String(err);
      setUploadError(message);
      throw new Error(message);
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Issue Certificates (Admin)</h2>
      <p className="small">Start by creating an organization. Once approved, you can issue certificates.</p>

      {!account ? (
        <p className="small">Connect your wallet to get started.</p>
      ) : (
        <p className="small">
          Connected wallet: <span className="badge">{account.address}</span>
        </p>
      )}

      <div className="step-tabs" style={{ marginTop: 12 }}>
        <button type="button" className={`step-tab ${activeStep === 1 ? "active" : ""}`} onClick={() => setActiveStep(1)}>
          Step 1: Organization
        </button>
        <button
          type="button"
          className={`step-tab ${activeStep === 2 ? "active" : ""}`}
          disabled={!step2Enabled}
          onClick={() => setActiveStep(2)}
        >
          Step 2: Program
        </button>
        <button
          type="button"
          className={`step-tab ${activeStep === 3 ? "active" : ""}`}
          disabled={!step3Enabled}
          onClick={() => setActiveStep(3)}
        >
          Step 3: Issue
        </button>
      </div>
      <p className="small" style={{ marginTop: 6 }}>
        Complete each step to unlock the next.
      </p>

      <div className="steps" style={{ marginTop: 12 }}>
        {activeStep === 1 && (
          <div className="card step-card">
            <div className="step-header">
              <div className="step-number">1</div>
              <div className="step-meta">
                <h3 className="step-title">Organization setup</h3>
                <p className="step-desc">Create the issuer profile that can publish certificates.</p>
              </div>
              <span className={`badge ${adminReady ? "ok" : ""}`}>{adminReady ? "Ready" : "Needs setup"}</span>
            </div>

            <div style={{ marginTop: 12 }}>
              {!isIssuer && (
                <button className="btn" disabled={!account || isPending} onClick={createIssuer}>
                  Create organization profile
                </button>
              )}
              {isIssuer && (
                <div>
                  <button className="btn" disabled={!account || isPending} onClick={createIssuer}>
                    Create another organization profile
                  </button>
                  <p className="small">Use this if you want a separate profile for another organization.</p>
                </div>
              )}
              {capQuery.isPending && <p className="small">Checking admin access...</p>}
            </div>

            <div style={{ marginTop: 12 }}>
              <p className="small">
                Organization saved in this browser: {localRegistry ? <span className="badge ok">Yes</span> : <span className="badge">Not yet</span>}
              </p>
              <button
                className="btn secondary"
                style={{ marginTop: 6, padding: "6px 10px", fontSize: 12 }}
                onClick={() => setShowOrgAdvanced((prev) => !prev)}
              >
                {showOrgAdvanced ? "Hide advanced options" : "Advanced options"}
              </button>
            </div>

            {showOrgAdvanced && (
              <div style={{ marginTop: 12 }}>
                <label className="small">Organization ID (shared list)</label>
                <input
                  value={localRegistry}
                  onChange={(e) => {
                    setLocalRegistry(e.target.value);
                    setRegistryId(e.target.value);
                  }}
                  placeholder="0x... organization id"
                />
                <p className="small">
                  Current organization ID: {localRegistry ? <span className="badge">{localRegistry}</span> : <span className="badge">not set</span>}
                </p>
                {localRegistry && (
                  <button className="btn" style={{ marginTop: 6, padding: "6px 10px", fontSize: 12 }} onClick={() => copyToClipboard("Organization ID", localRegistry)}>
                    Copy organization ID
                  </button>
                )}
                <p className="small">Use this only if you are switching browsers or accounts.</p>
              </div>
            )}

            <div className="step-actions">
              <button className="btn" disabled={!step2Enabled} onClick={() => setActiveStep(2)}>
                Continue to program setup
              </button>
            </div>
          </div>
        )}

        {activeStep === 2 && (
          <div className="card step-card">
            <div className="step-header">
              <div className="step-number">2</div>
              <div className="step-meta">
                <h3 className="step-title">Create a program</h3>
                <p className="step-desc">Programs group certificates for an event or course.</p>
              </div>
              <span className={`badge ${batchReady ? "ok" : ""}`}>{batchReady ? "Ready" : "Not set"}</span>
            </div>

            <div style={{ marginTop: 12 }}>
              <label className="small">Program title</label>
              <input value={ctxTitle} onChange={(e) => setCtxTitle(e.target.value)} />
              <label className="small" style={{ marginTop: 8, display: "block" }}>
                Description
              </label>
              <input value={ctxDesc} onChange={(e) => setCtxDesc(e.target.value)} />

              <button className="btn" style={{ marginTop: 12 }} disabled={!account || !isIssuer || isPending} onClick={createContext}>
                Create program
              </button>

              <div style={{ marginTop: 12 }}>
                <p className="small">
                  Program saved in this browser: {contextId ? <span className="badge ok">Yes</span> : <span className="badge">Not yet</span>}
                </p>
                <button
                  className="btn secondary"
                  style={{ marginTop: 6, padding: "6px 10px", fontSize: 12 }}
                  onClick={() => setShowProgramAdvanced((prev) => !prev)}
                >
                  {showProgramAdvanced ? "Hide advanced options" : "Advanced options"}
                </button>
              </div>

              {showProgramAdvanced && (
                <div style={{ marginTop: 12 }}>
                  <label className="small">Program ID</label>
                  <input value={contextId} onChange={(e) => setContextId(e.target.value)} placeholder="0x... program id" />
                  <p className="small">
                    Current program ID: {contextId ? <span className="badge">{contextId}</span> : <span className="badge">not set</span>}
                  </p>
                  {contextId && (
                    <button className="btn" style={{ marginTop: 6, padding: "6px 10px", fontSize: 12 }} onClick={() => copyToClipboard("Program ID", contextId)}>
                      Copy program ID
                    </button>
                  )}
                  <p className="small">Use this only if you are switching browsers or accounts.</p>
                </div>
              )}
            </div>

            <div style={{ marginTop: 16 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <h4 style={{ margin: 0 }}>Program history</h4>
                  <p className="small" style={{ marginTop: 6 }}>
                    Use past programs as templates when you want to reissue a familiar setup.
                  </p>
                </div>
                <button
                  className="btn secondary"
                  style={{ padding: "6px 10px", fontSize: 12 }}
                  onClick={() => setShowProgramHistory((prev) => !prev)}
                >
                  {showProgramHistory ? "Hide history" : "Show history"}
                </button>
              </div>

              {showProgramHistory && (
                <div style={{ marginTop: 12 }}>
                  <button
                    className="btn secondary"
                    style={{ padding: "6px 10px", fontSize: 12 }}
                    disabled={!account || !isIssuer || isHistoryLoading}
                    onClick={loadProgramHistory}
                  >
                    {isHistoryLoading ? "Loading history..." : historyLoaded ? "Refresh history" : "Load history"}
                  </button>
                  {historyMsg && (
                    <p className="small" style={{ marginTop: 8 }}>
                      {historyMsg}
                    </p>
                  )}
                  {programHistory.length > 0 && (
                    <div className="cards-grid" style={{ marginTop: 12 }}>
                      {programHistory.map((item) => (
                        <div key={item.id} className="card">
                          <h4 style={{ margin: 0 }}>{item.title}</h4>
                          {item.description && <p className="small" style={{ marginTop: 6 }}>{item.description}</p>}
                          <p className="small" style={{ marginTop: 8 }}>
                            Issued so far: <span className="badge">{item.issuedCount}</span>
                          </p>
                          <p className="small">Program ID</p>
                          <pre>{item.id}</pre>
                          <button
                            className="btn secondary"
                            style={{ padding: "6px 10px", fontSize: 12 }}
                            onClick={() => {
                              setContextId(item.id);
                              setCtxTitle(item.title);
                              setCtxDesc(item.description || "");
                              setMsg("Program selected. You can issue certificates now.");
                            }}
                          >
                            Use this program
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="step-actions">
              <button className="btn secondary" onClick={() => setActiveStep(1)}>
                Back to organization
              </button>
              <button className="btn" disabled={!step3Enabled} onClick={() => setActiveStep(3)}>
                Continue to issuing
              </button>
            </div>
          </div>
        )}

        {activeStep === 3 && (
          <div className="card step-card">
            <div className="step-header">
              <div className="step-number">3</div>
              <div className="step-meta">
                <h3 className="step-title">Issue certificates</h3>
                <p className="step-desc">Add recipients, attach a file, and issue in bulk.</p>
              </div>
              <span className={`badge ${issueReady ? "ok" : ""}`}>{issueReady ? "Ready" : "Waiting for details"}</span>
            </div>

            <div style={{ marginTop: 12 }}>
              <label className="small">Certificate title</label>
              <input value={credTitle} onChange={(e) => setCredTitle(e.target.value)} />

              <label className="small" style={{ marginTop: 8, display: "block" }}>
                Recipient list (paste or import)
              </label>
              <textarea
                rows={6}
                value={recipientsInput}
                onChange={(e) => setRecipientsInput(e.target.value)}
                placeholder="Paste recipients (one per line or comma-separated)"
              />
              <p className="small">
                Valid recipients: {validRecipients.length}. {invalidRecipients.length ? `Invalid: ${invalidRecipients.length}` : "All entries look valid."}
              </p>
              {invalidRecipients.length > 0 && (
                <p className="small">
                  Invalid entries: {invalidRecipients.slice(0, 5).join(", ")}
                  {invalidRecipients.length > 5 ? "..." : ""}
                </p>
              )}

              <label className="small" style={{ marginTop: 12, display: "block" }}>
                Import list (CSV)
              </label>
              <input type="file" accept=".csv,text/csv" onChange={handleRecipientsFileChange} />

              <label className="small" style={{ marginTop: 12, display: "block" }}>
                Attachment (optional)
              </label>
              <input
                type="file"
                onChange={(e) => {
                  const file = e.target.files?.[0] || null;
                  setSelectedFile(file);
                  setUploadError("");
                  setUploadMsg("");
                  if (file) {
                    setDocRef("");
                  }
                }}
              />
              <p className="small">If you attach a file, it uploads automatically when you issue.</p>

              {selectedFile && (
                <div className="card" style={{ marginTop: 12, padding: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                    <div>
                      <p className="small" style={{ margin: 0 }}>Selected file</p>
                      <p style={{ margin: "4px 0 0", fontWeight: 600 }}>{selectedFile.name}</p>
                      <p className="small" style={{ marginTop: 4 }}>
                        {selectedFile.type || "Unknown type"} - {formatFileSize(selectedFile.size)}
                      </p>
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      {previewUrl && (
                        <a className="btn secondary" style={{ padding: "6px 10px", fontSize: 12 }} href={previewUrl} target="_blank" rel="noreferrer">
                          Open preview
                        </a>
                      )}
                      <button
                        className="btn secondary"
                        style={{ padding: "6px 10px", fontSize: 12 }}
                        onClick={() => {
                          setSelectedFile(null);
                          setUploadMsg("");
                          setUploadError("");
                          setDocRef("");
                        }}
                      >
                        Remove file
                      </button>
                    </div>
                  </div>
                  {previewUrl && selectedFile.type.startsWith("image/") && (
                    <img
                      src={previewUrl}
                      alt="Attachment preview"
                      style={{ width: "100%", marginTop: 12, borderRadius: 12, border: "1px solid var(--stroke)" }}
                    />
                  )}
                  {previewUrl && selectedFile.type === "application/pdf" && (
                    <iframe
                      title="Attachment preview"
                      src={previewUrl}
                      style={{ width: "100%", marginTop: 12, borderRadius: 12, border: "1px solid var(--stroke)", height: 280 }}
                    />
                  )}
                  {previewUrl && !selectedFile.type.startsWith("image/") && selectedFile.type !== "application/pdf" && (
                    <p className="small" style={{ marginTop: 8 }}>
                      Preview not available for this file type.
                    </p>
                  )}
                </div>
              )}

              {uploadMsg && <p className="small" style={{ marginTop: 8 }}>{uploadMsg}</p>}
              {uploadError && <p className="small" style={{ marginTop: 8 }}>{uploadError}</p>}

              <div style={{ marginTop: 12 }}>
                <button
                  className="btn secondary"
                  style={{ padding: "6px 10px", fontSize: 12 }}
                  onClick={() => setShowIssueAdvanced((prev) => !prev)}
                >
                  {showIssueAdvanced ? "Hide advanced options" : "Advanced options"}
                </button>
              </div>

              {showIssueAdvanced && (
                <div style={{ marginTop: 12 }}>
                  <label className="small">Group size (recipients per approval)</label>
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={chunkSize}
                    onChange={(e) => setChunkSize(Math.max(1, Number(e.target.value) || 1))}
                  />
                  <p className="small">Smaller groups are safer but require more wallet approvals.</p>

                  <label className="small" style={{ marginTop: 12, display: "block" }}>
                    Additional allowed wallets (optional)
                  </label>
                  <textarea
                    rows={3}
                    value={extraAccessInput}
                    onChange={(e) => setExtraAccessInput(e.target.value)}
                    placeholder="Paste extra recipients"
                  />
                  {invalidAccess.length > 0 && (
                    <p className="small">
                      Invalid allowlist entries: {invalidAccess.slice(0, 5).join(", ")}
                      {invalidAccess.length > 5 ? "..." : ""}
                    </p>
                  )}
                  <p className="small">Recipients can always open the attachment. Add extra wallets only if needed.</p>
                  <p className="small">This gate hides the download button in the app. Anyone with the link can still access the file.</p>

                  <label className="small" style={{ marginTop: 12, display: "block" }}>
                    Attachment link (advanced)
                  </label>
                  <input value={docRef} onChange={(e) => setDocRef(e.target.value)} placeholder="Paste an existing attachment link" />
                  <p className="small">Use this only if you already have a link and do not want to upload.</p>
                </div>
              )}

              {bulkProgress && (
                <p className="small" style={{ marginTop: 8 }}>
                  Progress: {bulkProgress.completed}/{bulkProgress.total} (chunk {bulkProgress.chunk}/{bulkProgress.chunks})
                </p>
              )}
              {bulkErrors.length > 0 && (
                <pre style={{ marginTop: 8 }}>{bulkErrors.join("\n")}</pre>
              )}

              <div className="step-actions">
                <button className="btn secondary" onClick={() => setActiveStep(2)}>
                  Back to program
                </button>
                <button className="btn" disabled={!issueReady || isPending || isBulkIssuing || isUploading} onClick={issueCredentialsBulk}>
                  {isBulkIssuing || isUploading ? "Working..." : issueLabel}
                </button>
              </div>
              {!issueReady && <p className="small">Add recipients and select a program to enable issuing.</p>}
            </div>
          </div>
        )}
      </div>

      {(msg || lastTx) && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3 style={{ marginTop: 0 }}>Status</h3>
          {msg && <p>{msg}</p>}
          {lastTx && (
            <p className="small">
              Last transaction: <span className="badge">{lastTx}</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
