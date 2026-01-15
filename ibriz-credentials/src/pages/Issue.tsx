import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import { createPortal } from "react-dom";
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient, useSuiClientQuery } from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { MODULE, NETWORK, PACKAGE_ID, TYPES, WALRUS_UPLOAD_URL, getRegistryId, setRegistryId } from "../config";
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

type IssuedCredentialItem = {
  id: string;
  recipient: string;
  context: string;
};

const HISTORY_EVENT_LIMIT = 200;
const HISTORY_FETCH_CHUNK = 50;
const SIDEBAR_PAGE_SIZE = 5;
const DEFAULT_CHUNK_SIZE = 10;
const DEFAULT_CRED_TITLE = "Certificate of Participation";

function buildDocRefForRecipient(baseRef: string, extraAccess: string[]): string {
  const trimmed = baseRef.trim();
  if (!trimmed) return "";
  if (!extraAccess.length) return trimmed;
  const allowList = Array.from(new Set(extraAccess.map(normalizeAddress)));
  if (!allowList.length) return trimmed;
  const aclValue = encodeURIComponent(allowList.join(","));
  return applyWalrusMeta(trimmed, { acl: aclValue });
}

const ORG_CREATED_AT_PREFIX = `IBRIZ_ORG_CREATED_AT:${NETWORK}:${PACKAGE_ID}:`;

function getOrgCreatedAt(registryId: string): number {
  if (!registryId || typeof window === "undefined") return 0;
  const raw = localStorage.getItem(`${ORG_CREATED_AT_PREFIX}${registryId}`) || "";
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

function setOrgCreatedAt(registryId: string, value: number) {
  if (!registryId || typeof window === "undefined") return;
  localStorage.setItem(`${ORG_CREATED_AT_PREFIX}${registryId}`, String(value));
}

function getEventTimestamp(event: any): number {
  const raw = event?.timestampMs ?? event?.timestamp ?? event?.time ?? "";
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

function formatShortId(value: string, head = 6, tail = 4): string {
  if (!value) return "";
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

type IssueProps = {
  onIssuedSuccess?: () => void;
};

export default function Issue({ onIssuedSuccess }: IssueProps) {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const [localRegistry, setLocalRegistry] = useState(() => getRegistryId());
  const [orgCreatedAtMs, setOrgCreatedAtMs] = useState(() => getOrgCreatedAt(localRegistry));
  const [activeStep, setActiveStep] = useState<1 | 2 | 3>(1);
  const [showAdvancedModal, setShowAdvancedModal] = useState(false);

  const [ctxTitle, setCtxTitle] = useState("");
  const [ctxDesc, setCtxDesc] = useState("");
  const [contextId, setContextId] = useState("");
  const [orgName, setOrgName] = useState("");
  const [orgNameDraft, setOrgNameDraft] = useState("");
  const [isOrgRenaming, setIsOrgRenaming] = useState(false);

  const [recipientsInput, setRecipientsInput] = useState("");
  const [extraAccessInput, setExtraAccessInput] = useState("");
  const [chunkSize, setChunkSize] = useState(DEFAULT_CHUNK_SIZE);
  const [credTitle, setCredTitle] = useState(DEFAULT_CRED_TITLE);
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
  const [prefillEnabled, setPrefillEnabled] = useState(true);
  const [isProgramLocked, setIsProgramLocked] = useState(false);
  const [showOrgCreate, setShowOrgCreate] = useState(false);
  const [issuedList, setIssuedList] = useState<IssuedCredentialItem[]>([]);
  const [issuedMsg, setIssuedMsg] = useState("");
  const [isIssuedLoading, setIsIssuedLoading] = useState(false);
  const [issuedLoaded, setIssuedLoaded] = useState(false);
  const [historyPage, setHistoryPage] = useState(1);
  const [issuedPage, setIssuedPage] = useState(1);
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const [successCount, setSuccessCount] = useState(0);
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

  const registryQuery = useSuiClientQuery(
    "getObject",
    {
      id: localRegistry || "0x0",
      options: { showContent: true, showType: true },
    },
    { enabled: !!localRegistry }
  );

  const issuerCapId = useMemo(() => {
    const d = capQuery.data;
    const first = d?.data?.[0];
    return first?.data?.objectId || "";
  }, [capQuery.data]);

  const registryFields = useMemo(() => asMoveFields(registryQuery.data), [registryQuery.data]);
  const registryName = useMemo(() => decodeMoveString(registryFields?.name), [registryFields]);
  const registryIssuer = useMemo(() => (registryFields?.issuer ? normalizeAddress(String(registryFields.issuer)) : ""), [registryFields]);

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
  const showCreateProgram = !isProgramLocked;
  const currentOrgName = registryName || "";
  const hasNamedOrg = !!currentOrgName.trim();
  const hasLegacyOrg = !!localRegistry && !hasNamedOrg;
  const walletAddress = account?.address ? normalizeAddress(account.address) : "";
  const canSetOrgName = isIssuer && !!localRegistry && (!registryIssuer || registryIssuer === walletAddress);
  const showProgramHistoryPanel = activeStep === 2;
  const issueCount = validRecipients.length;
  const issueTargetLabel = issueCount === 1 ? "recipient" : "recipients";
  const issueLabel = selectedFile ? `Upload and issue to ${issueCount} ${issueTargetLabel}` : `Issue to ${issueCount} ${issueTargetLabel}`;
  const historyTotalPages = Math.max(1, Math.ceil(programHistory.length / SIDEBAR_PAGE_SIZE));
  const historyPageSafe = Math.min(historyPage, historyTotalPages);
  const historyPageItems = programHistory.slice((historyPageSafe - 1) * SIDEBAR_PAGE_SIZE, historyPageSafe * SIDEBAR_PAGE_SIZE);
  const issuedTotalPages = Math.max(1, Math.ceil(issuedList.length / SIDEBAR_PAGE_SIZE));
  const issuedPageSafe = Math.min(issuedPage, issuedTotalPages);
  const issuedPageItems = issuedList.slice((issuedPageSafe - 1) * SIDEBAR_PAGE_SIZE, issuedPageSafe * SIDEBAR_PAGE_SIZE);

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
    setPrefillEnabled(true);
    setIsProgramLocked(false);
    setShowOrgCreate(false);
    setIssuedList([]);
    setIssuedMsg("");
    setIssuedLoaded(false);
    setOrgName("");
    setOrgCreatedAtMs(0);
    setHistoryPage(1);
    setIssuedPage(1);
  }, [account?.address]);

  useEffect(() => {
    setIssuedList([]);
    setIssuedMsg("");
    setIssuedLoaded(false);
    setIssuedPage(1);
  }, [contextId]);

  useEffect(() => {
    setOrgCreatedAtMs(getOrgCreatedAt(localRegistry));
  }, [localRegistry]);

  useEffect(() => {
    setOrgNameDraft(currentOrgName);
  }, [currentOrgName]);

  useEffect(() => {
    if (isIssuer) {
      setShowOrgCreate(false);
    }
  }, [isIssuer]);

  useEffect(() => {
    setContextId("");
    setCtxTitle("");
    setCtxDesc("");
    setIsProgramLocked(false);
    setPrefillEnabled(true);
    setProgramHistory([]);
    setHistoryMsg("");
    setHistoryLoaded(false);
    setIssuedList([]);
    setIssuedMsg("");
    setIssuedLoaded(false);
    setHistoryPage(1);
    setIssuedPage(1);
  }, [localRegistry]);

  const resetWorkflow = useCallback(() => {
    setActiveStep(1);
    setContextId("");
    setCtxTitle("");
    setCtxDesc("");
    setIsProgramLocked(false);
    setPrefillEnabled(true);
    setProgramHistory([]);
    setHistoryMsg("");
    setHistoryLoaded(false);
    setRecipientsInput("");
    setExtraAccessInput("");
    setChunkSize(DEFAULT_CHUNK_SIZE);
    setCredTitle(DEFAULT_CRED_TITLE);
    setDocRef("");
    setSelectedFile(null);
    setUploadError("");
    setUploadMsg("");
    setBulkProgress(null);
    setBulkErrors([]);
    setIsBulkIssuing(false);
    setIssuedList([]);
    setIssuedMsg("");
    setIssuedLoaded(false);
    setLastTx(null);
    setMsg("");
    setHistoryPage(1);
    setIssuedPage(1);
    setShowAdvancedModal(false);
  }, []);

  useEffect(() => {
    if (!showSuccessModal) return;
    const timer = setTimeout(() => {
      setShowSuccessModal(false);
      resetWorkflow();
      onIssuedSuccess?.();
    }, 1600);
    return () => clearTimeout(timer);
  }, [showSuccessModal, resetWorkflow, onIssuedSuccess]);


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
    if (isIssuer) {
      setMsg("This wallet already has an organization profile. Use advanced options to link it here.");
      return;
    }
    const trimmedName = orgName.trim();
    if (!trimmedName) {
      setMsg("Add an organization name before creating the profile.");
      return;
    }
    if (!window.confirm("Creating an organization costs a network fee. Continue?")) {
      setMsg("Organization creation canceled.");
      return;
    }
    setMsg("");
    const tx = new Transaction();
    tx.moveCall({ target: target("create_issuer"), arguments: [tx.pure.string(trimmedName)] });

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
      const createdFromBlock = blockChanges.find((c) => c.type === "created" && typeof c.objectType === "string" && c.objectType.includes("::Registry") && (c.owner?.Shared || c.owner?.shared));
      const eventFromBlock = getEventField(txBlock, "::IssuerCreated", ["registry_id", "registryId"]);
      resolvedRegistryId = createdFromBlock?.objectId || eventFromBlock || "";
    } catch (err) {
      fetchError = String(err);
    }

    if (resolvedRegistryId) {
      setRegistryId(resolvedRegistryId);
      setLocalRegistry(resolvedRegistryId);
      const createdAt = Date.now();
      setOrgCreatedAtMs(createdAt);
      setOrgCreatedAt(resolvedRegistryId, createdAt);
      setShowOrgCreate(false);
      setOrgName(trimmedName);
      setMsg("Setup complete. Organization linked to this browser.");
    } else if (fetchError) {
      setMsg(`Setup complete, but we could not find the organization ID. ${fetchError}`);
    } else {
      setMsg("Setup complete. Use advanced options if you need to view or copy the organization ID.");
    }

    // refresh cap query
    capQuery.refetch();
  }

  async function updateOrgName() {
    if (!account || !issuerCapId) return;
    if (!localRegistry) {
      setMsg("Missing organization ID. Paste the organization ID first.");
      return;
    }
    if (!canSetOrgName) {
      setMsg("Only the issuing wallet can edit the organization name.");
      return;
    }
    const trimmedName = orgNameDraft.trim();
    if (!trimmedName) {
      setMsg("Organization name cannot be empty.");
      return;
    }
    if (trimmedName === currentOrgName.trim()) {
      setMsg("No changes to save yet.");
      return;
    }
    if (!window.confirm("Saving the organization name costs a network fee. Continue?")) {
      setMsg("Name update canceled.");
      return;
    }
    setIsOrgRenaming(true);
    setMsg("");
    const wasBlank = !currentOrgName.trim();
    try {
      const tx = new Transaction();
      tx.moveCall({
        target: target("update_registry_name"),
        arguments: [tx.object(issuerCapId), tx.object(localRegistry), tx.pure.string(trimmedName)],
      });
      const res = await signAndExecute({ transaction: tx });
      setLastTx(res.digest);
      setOrgNameDraft(trimmedName);
      setMsg(wasBlank ? "Organization name saved." : "Organization name updated.");
      registryQuery.refetch();
    } catch (err) {
      setMsg(`Unable to update the organization name. ${String(err)}`);
    } finally {
      setIsOrgRenaming(false);
    }
  }

  async function createContext() {
    if (!account || !issuerCapId) return;
    setMsg("");
    setPrefillEnabled(false);

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
      setIsProgramLocked(true);
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
      setProgramHistory([]);
      setHistoryLoaded(true);
      return;
    }
    if (!isIssuer) {
      setHistoryMsg("Only the organization wallet can view program history.");
      setProgramHistory([]);
      setHistoryLoaded(true);
      return;
    }
    if (!localRegistry || !hasNamedOrg) {
      setHistoryMsg("Select an organization to view program history.");
      setProgramHistory([]);
      setHistoryLoaded(true);
      return;
    }
    if (registryIssuer && walletAddress && registryIssuer !== walletAddress) {
      setHistoryMsg("This organization belongs to another wallet.");
      setProgramHistory([]);
      setHistoryLoaded(true);
      return;
    }

    setIsHistoryLoading(true);
    setHistoryMsg("");
    setProgramHistory([]);

    try {
      const issuerAddress = normalizeAddress(account.address);
      let orgCreatedAt = orgCreatedAtMs;
      if (!orgCreatedAt) {
        const issuerEventType = `${PACKAGE_ID}::${MODULE}::IssuerCreated`;
        const issuerRes = await client.queryEvents({ query: { MoveEventType: issuerEventType }, limit: HISTORY_EVENT_LIMIT });
        const issuerEvents = (issuerRes as any)?.data ?? [];
        const registryIdValue = normalizeAddress(localRegistry);
        const issuerMatch = issuerEvents.find((event: any) => {
          const eventRegistry = normalizeAddress(getParsedEventField(event, ["registry_id", "registryId"]));
          return eventRegistry && eventRegistry === registryIdValue;
        });
        const issuerTimestamp = issuerMatch ? getEventTimestamp(issuerMatch) : 0;
        if (issuerTimestamp) {
          orgCreatedAt = issuerTimestamp;
          setOrgCreatedAtMs(issuerTimestamp);
          setOrgCreatedAt(localRegistry, issuerTimestamp);
        }
      }

      const contextEventType = `${PACKAGE_ID}::${MODULE}::ContextCreated`;
      const credentialEventType = `${PACKAGE_ID}::${MODULE}::CredentialIssued`;

      const [contextRes, credentialRes] = await Promise.all([client.queryEvents({ query: { MoveEventType: contextEventType }, limit: HISTORY_EVENT_LIMIT }), client.queryEvents({ query: { MoveEventType: credentialEventType }, limit: HISTORY_EVENT_LIMIT })]);

      const rawContextEvents = (contextRes as any)?.data ?? [];
      const rawCredentialEvents = (credentialRes as any)?.data ?? [];
      const shouldFilterByTime = orgCreatedAt > 0;
      const contextEvents = shouldFilterByTime
        ? rawContextEvents.filter((event: any) => {
            const ts = getEventTimestamp(event);
            return ts > 0 && ts >= orgCreatedAt;
          })
        : rawContextEvents;
      const credentialEvents = shouldFilterByTime
        ? rawCredentialEvents.filter((event: any) => {
            const ts = getEventTimestamp(event);
            return ts > 0 && ts >= orgCreatedAt;
          })
        : rawCredentialEvents;

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
      setHistoryPage(1);

      if (prefillEnabled && !contextId && items.length > 0 && orgCreatedAt > 0) {
        const latest = items[0];
        setContextId(latest.id);
        setCtxTitle(latest.title);
        setCtxDesc(latest.description || "");
        setMsg("Loaded your most recent program.");
        setIsProgramLocked(true);
        setPrefillEnabled(false);
      }

      let summary = items.length
        ? `Loaded ${items.length} program${items.length === 1 ? "" : "s"}.`
        : "No history available for this organization yet.";
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
  }, [account, client, contextId, hasNamedOrg, isIssuer, localRegistry, orgCreatedAtMs, prefillEnabled, registryIssuer, walletAddress]);

  useEffect(() => {
    if (activeStep !== 2) return;
    if (!account || !isIssuer || historyLoaded) return;
    loadProgramHistory();
  }, [activeStep, account, isIssuer, historyLoaded, loadProgramHistory]);

  const loadIssuedCertificates = useCallback(async () => {
    if (!account) {
      setIssuedMsg("Connect your wallet to load certificates.");
      setIssuedList([]);
      setIssuedLoaded(true);
      return;
    }
    if (!isIssuer) {
      setIssuedMsg("Only the organization wallet can view issued certificates.");
      setIssuedList([]);
      setIssuedLoaded(true);
      return;
    }
    if (!localRegistry || !hasNamedOrg) {
      setIssuedMsg("Select an organization to view issued certificates.");
      setIssuedList([]);
      setIssuedLoaded(true);
      return;
    }
    if (registryIssuer && walletAddress && registryIssuer !== walletAddress) {
      setIssuedMsg("This organization belongs to another wallet.");
      setIssuedList([]);
      setIssuedLoaded(true);
      return;
    }

    setIsIssuedLoading(true);
    setIssuedMsg("");
    setIssuedList([]);

    try {
      const issuerAddress = normalizeAddress(account.address);
      const contextFilter = contextId ? normalizeAddress(contextId) : "";
      let orgCreatedAt = orgCreatedAtMs;
      if (!orgCreatedAt) {
        const issuerEventType = `${PACKAGE_ID}::${MODULE}::IssuerCreated`;
        const issuerRes = await client.queryEvents({ query: { MoveEventType: issuerEventType }, limit: HISTORY_EVENT_LIMIT });
        const issuerEvents = (issuerRes as any)?.data ?? [];
        const registryIdValue = normalizeAddress(localRegistry);
        const issuerMatch = issuerEvents.find((event: any) => {
          const eventRegistry = normalizeAddress(getParsedEventField(event, ["registry_id", "registryId"]));
          return eventRegistry && eventRegistry === registryIdValue;
        });
        const issuerTimestamp = issuerMatch ? getEventTimestamp(issuerMatch) : 0;
        if (issuerTimestamp) {
          orgCreatedAt = issuerTimestamp;
          setOrgCreatedAtMs(issuerTimestamp);
          setOrgCreatedAt(localRegistry, issuerTimestamp);
        }
      }

      const credentialEventType = `${PACKAGE_ID}::${MODULE}::CredentialIssued`;
      const res = await client.queryEvents({ query: { MoveEventType: credentialEventType }, limit: HISTORY_EVENT_LIMIT });
      const rawEvents = (res as any)?.data ?? [];
      const events = orgCreatedAt > 0
        ? rawEvents.filter((event: any) => {
            const ts = getEventTimestamp(event);
            return ts > 0 && ts >= orgCreatedAt;
          })
        : rawEvents;

      const items: IssuedCredentialItem[] = [];
      for (const event of events) {
        const issuer = normalizeAddress(getParsedEventField(event, ["issuer"]));
        if (!issuer || issuer !== issuerAddress) continue;
        const context = getParsedEventField(event, ["context", "context_id", "contextId"]);
        if (contextFilter && normalizeAddress(context) !== contextFilter) continue;
        const recipient = getParsedEventField(event, ["recipient"]);
        const credentialId = getParsedEventField(event, ["credential_id", "credentialId"]);
        if (!credentialId) continue;
        items.push({ id: credentialId, recipient, context: context || "" });
      }

      setIssuedList(items);
      setIssuedPage(1);

      const scopeLabel = contextFilter ? "this program" : "this organization";
      let summary = items.length
        ? `Loaded ${items.length} recent certificates for ${scopeLabel}.`
        : `No issued certificates for ${scopeLabel} yet.`;
      if ((res as any)?.hasNextPage) {
        summary += " Showing the latest results only.";
      }
      setIssuedMsg(summary);
    } catch (err) {
      setIssuedMsg(`Unable to load certificates. ${String(err)}`);
    } finally {
      setIsIssuedLoading(false);
      setIssuedLoaded(true);
    }
  }, [account, client, contextId, hasNamedOrg, isIssuer, localRegistry, orgCreatedAtMs, registryIssuer, walletAddress]);

  useEffect(() => {
    if (!account || !isIssuer || !hasNamedOrg || issuedLoaded) return;
    loadIssuedCertificates();
  }, [account, hasNamedOrg, isIssuer, issuedLoaded, loadIssuedCertificates]);

  async function issueCredentialsBulk() {
    if (!account || !issuerCapId) return;
    if (!localRegistry) return setMsg("Missing organization ID. Run setup once, or paste the organization ID.");
    if (!contextId) return setMsg("Missing program ID. Create a program first (or paste one).");
    if (!validRecipients.length) return setMsg("Add at least one recipient.");
    if (invalidRecipients.length) return setMsg("Remove invalid entries before issuing.");
    if (invalidAccess.length) return setMsg("Remove invalid entries from the access list.");

    const totalRecipients = validRecipients.length;
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
      setBulkProgress({ total: totalRecipients, completed: 0, chunk: 0, chunks: chunks.length });
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
            arguments: [capObj, registryObj, contextObj, tx.pure.address(recipient), tx.pure.string(credTitle), tx.pure.string(docRefForRecipient)],
          });
        }

        const res = await signAndExecute({ transaction: tx });
        setLastTx(res.digest);
        completed += chunk.length;
        setBulkProgress({ total: totalRecipients, completed, chunk: index + 1, chunks: chunks.length });
        setMsg(`Issued ${completed}/${totalRecipients} certificates.`);
      }
      setSuccessCount(totalRecipients);
      setShowSuccessModal(true);
      setMsg(`Success. Issued ${totalRecipients} certificates.`);
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
        const newlyCreated = top?.newlyCreated || top?.newly_created || top?.blobStoreResult?.newlyCreated || top?.blobStoreResult?.newly_created || null;
        const alreadyCertified = top?.alreadyCertified || top?.already_certified || top?.blobStoreResult?.alreadyCertified || top?.blobStoreResult?.already_certified || null;

        const blobObject = newlyCreated?.blobObject || newlyCreated?.blob_object || null;

        blobId = top.blobId || top.blob_id || top?.result?.blobId || top?.result?.blob_id || blobObject?.blobId || blobObject?.blob_id || alreadyCertified?.blob_id || alreadyCertified?.blobId || "";
        objectId = top.id || top?.result?.id || blobObject?.id || alreadyCertified?.object || "";
      }

      if (!blobId && !objectId) {
        throw new Error("Upload completed, but we could not link the file. Please try again.");
      }

      const walrusRefBase = blobId ? (blobId.startsWith("walrus://") ? blobId : `walrus://${blobId}`) : objectId.startsWith("walrus-object://") ? objectId : `walrus-object://${objectId}`;
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

  const issueSidebarTarget = typeof document !== "undefined" ? document.getElementById("issue-sidebar") : null;
  const issueStatusTarget = typeof document !== "undefined" ? document.getElementById("issue-status") : null;
  const shortTx = lastTx ? formatShortId(lastTx) : "";
  const issueSidebar = (
    <>
      {showProgramHistoryPanel && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Program history</h3>
          <p className="small">Use past programs as templates when you want to reissue a familiar setup.</p>
          <button className="btn secondary" style={{ padding: "6px 10px", fontSize: 12 }} disabled={!account || !isIssuer || isHistoryLoading} onClick={loadProgramHistory}>
            {isHistoryLoading ? "Loading history..." : historyLoaded ? "Refresh history" : "Load history"}
          </button>
          {!isIssuer && <p className="small" style={{ marginTop: 8 }}>Connect the organization wallet to load history.</p>}
          {historyMsg && (
            <p className="small" style={{ marginTop: 8 }}>
              {historyMsg}
            </p>
          )}
          {historyLoaded && !isHistoryLoading && programHistory.length === 0 && !historyMsg && (
            <p className="small" style={{ marginTop: 8 }}>
              No history available for this organization yet.
            </p>
          )}
          {historyPageItems.length > 0 && (
            <div className="cards-grid" style={{ marginTop: 12 }}>
              {historyPageItems.map((item) => (
                <div key={item.id} className="card">
                  <h4 style={{ margin: 0 }}>{item.title}</h4>
                  {item.description && (
                    <p className="small" style={{ marginTop: 6 }}>
                      {item.description}
                    </p>
                  )}
                  <p className="small" style={{ marginTop: 8 }}>
                    Issued so far: <span className="badge">{item.issuedCount}</span>
                  </p>
                  <button
                    className="btn secondary"
                    style={{ padding: "6px 10px", fontSize: 12 }}
                    onClick={() => {
                      setContextId(item.id);
                      setCtxTitle(item.title);
                      setCtxDesc(item.description || "");
                      setPrefillEnabled(false);
                      setIsProgramLocked(true);
                      setMsg("Program selected. You can issue certificates now.");
                    }}
                  >
                    Use this program
                  </button>
                </div>
              ))}
            </div>
          )}
          {historyTotalPages > 1 && (
            <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <button className="btn secondary" style={{ padding: "6px 10px", fontSize: 12 }} disabled={historyPageSafe <= 1} onClick={() => setHistoryPage((prev) => Math.max(1, prev - 1))}>
                Prev
              </button>
              <span className="small">Page {historyPageSafe} of {historyTotalPages}</span>
              <button className="btn secondary" style={{ padding: "6px 10px", fontSize: 12 }} disabled={historyPageSafe >= historyTotalPages} onClick={() => setHistoryPage((prev) => Math.min(historyTotalPages, prev + 1))}>
                Next
              </button>
            </div>
          )}
        </div>
      )}
      <div className="card" style={{ marginTop: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <h3 style={{ margin: 0 }}>Recent certificates issued</h3>
          <button className="btn secondary" style={{ padding: "6px 10px", fontSize: 12 }} disabled={!account || !isIssuer || isIssuedLoading} onClick={loadIssuedCertificates}>
            {isIssuedLoading ? "Loading list..." : issuedLoaded ? "Refresh list" : "Load list"}
          </button>
        </div>
        <div style={{ marginTop: 12 }}>
          <p className="small">Latest results for {contextId ? "this program" : "this organization"}.</p>
          {!isIssuer && <p className="small" style={{ marginTop: 8 }}>Connect the organization wallet to load issued certificates.</p>}
          {issuedMsg && (
            <p className="small" style={{ marginTop: 8 }}>
              {issuedMsg}
            </p>
          )}
          {issuedLoaded && !isIssuedLoading && issuedList.length === 0 && !issuedMsg && (
            <p className="small" style={{ marginTop: 8 }}>
              No issued certificates for this organization yet.
            </p>
          )}
          {issuedPageItems.length > 0 && (
            <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
              {issuedPageItems.map((item) => (
                <div key={item.id} style={{ border: "1px solid var(--stroke)", borderRadius: 12, padding: 12, background: "rgba(255,255,255,0.6)" }}>
                  <p className="small" style={{ margin: 0 }}>Recipient</p>
                  <pre style={{ marginTop: 6 }}>{item.recipient || "(unknown)"}</pre>
                  <p className="small" style={{ marginTop: 6 }}>Certificate ID</p>
                  <pre style={{ marginTop: 6 }}>{item.id}</pre>
                  {item.context && (
                    <>
                      <p className="small" style={{ marginTop: 6 }}>Program</p>
                      <pre style={{ marginTop: 6 }}>{item.context}</pre>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
          {issuedTotalPages > 1 && (
            <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <button className="btn secondary" style={{ padding: "6px 10px", fontSize: 12 }} disabled={issuedPageSafe <= 1} onClick={() => setIssuedPage((prev) => Math.max(1, prev - 1))}>
                Prev
              </button>
              <span className="small">Page {issuedPageSafe} of {issuedTotalPages}</span>
              <button className="btn secondary" style={{ padding: "6px 10px", fontSize: 12 }} disabled={issuedPageSafe >= issuedTotalPages} onClick={() => setIssuedPage((prev) => Math.min(issuedTotalPages, prev + 1))}>
                Next
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );

  return (
    <>
      <div className="card">
      <h2 style={{ marginTop: 0 }}>Issue certificates</h2>
      <p className="small">Create your organization and issue certificates.</p>

      {!account ? (
        <p className="small">Connect your wallet to get started.</p>
      ) : (
        <p className="small">Wallet connected.</p>
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginTop: 12 }}>
        <div className="step-tabs" style={{ marginTop: 0 }}>
          <button type="button" className={`step-tab ${activeStep === 1 ? "active" : ""}`} onClick={() => setActiveStep(1)}>
            Step 1: Organization
          </button>
          <button type="button" className={`step-tab ${activeStep === 2 ? "active" : ""}`} disabled={!step2Enabled} onClick={() => setActiveStep(2)}>
            Step 2: Program
          </button>
          <button type="button" className={`step-tab ${activeStep === 3 ? "active" : ""}`} disabled={!step3Enabled} onClick={() => setActiveStep(3)}>
            Step 3: Issue
          </button>
        </div>
        <button className="btn secondary" style={{ padding: "6px 10px", fontSize: 12 }} onClick={() => setShowAdvancedModal(true)}>
          Advanced options
        </button>
      </div>

      <div className="steps" style={{ marginTop: 12 }}>
        {activeStep === 1 && (
          <div className="card step-card">
            <div className="step-header">
              <div className="step-number">1</div>
              <div className="step-meta">
                <h3 className="step-title">Organization setup</h3>
                <p className="step-desc">Create the organization profile that will issue certificates.</p>
              </div>
            </div>

            <div style={{ marginTop: 12 }}>
              {hasNamedOrg && (
                <div className="card" style={{ padding: 12 }}>
                  <p className="small" style={{ margin: 0 }}>Current organization</p>
                  <p style={{ marginTop: 6, fontWeight: 600 }}>{currentOrgName}</p>
                </div>
              )}
              {!hasNamedOrg && (
                <div className="card" style={{ padding: 12 }}>
                  <p className="small" style={{ margin: 0 }}>Current organization</p>
                  <p className="small" style={{ marginTop: 8 }}>
                    {hasLegacyOrg
                      ? isIssuer
                        ? "A previous organization was found, but it has no name yet. Add a name in advanced options."
                        : "A previous organization was found, but it has no name. Create a new organization to continue."
                      : isIssuer
                        ? "This wallet already has an organization profile. Paste the organization ID in advanced options to link it here."
                        : "No organization linked yet."}
                  </p>
                </div>
              )}

              <div style={{ marginTop: 12 }}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {!isIssuer && !showOrgCreate && (
                    <button className="btn secondary" style={{ padding: "6px 10px", fontSize: 12 }} onClick={() => setShowOrgCreate(true)}>
                      Create a new organization
                    </button>
                  )}
                </div>
                {isIssuer && !showOrgCreate && (
                  <p className="small" style={{ marginTop: 8 }}>
                    This wallet can have only one organization profile.
                  </p>
                )}
                {showOrgCreate && !isIssuer && (
                  <div style={{ marginTop: 8 }}>
                    <label className="small">Organization name</label>
                    <input value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="e.g., Acme Academy" />
                    <p className="small">Used when creating a new organization profile. Creating it costs a network fee. You can edit it later in advanced options.</p>

                    <button className="btn" disabled={!account || isPending || !orgName.trim()} onClick={createIssuer}>
                      Create organization profile
                    </button>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                      <button
                        className="btn secondary"
                        style={{ padding: "6px 10px", fontSize: 12 }}
                        onClick={() => {
                          setShowOrgCreate(false);
                          setOrgName("");
                        }}
                      >
                        Hide
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {capQuery.isPending && <p className="small">Checking admin access...</p>}
            </div>


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
            </div>

            <div style={{ marginTop: 12 }}>
              <label className="small">Program title</label>
              <input
                value={ctxTitle}
                readOnly={isProgramLocked}
                onChange={(e) => {
                  setCtxTitle(e.target.value);
                  setPrefillEnabled(false);
                }}
              />
              <label className="small" style={{ marginTop: 8, display: "block" }}>
                Description
              </label>
              <input
                value={ctxDesc}
                readOnly={isProgramLocked}
                onChange={(e) => {
                  setCtxDesc(e.target.value);
                  setPrefillEnabled(false);
                }}
              />

              {showCreateProgram && (
                <button className="btn" style={{ marginTop: 12 }} disabled={!account || !isIssuer || isPending} onClick={createContext}>
                  Create program
                </button>
              )}
              {isProgramLocked && (
                <button
                  className="btn secondary"
                  style={{ marginTop: 12, padding: "6px 10px", fontSize: 12 }}
                  onClick={() => {
                    setContextId("");
                    setCtxTitle("");
                    setCtxDesc("");
                    setPrefillEnabled(false);
                    setIsProgramLocked(false);
                    setMsg("Ready to create a new program.");
                  }}
                >
                  Create a new program
                </button>
              )}
              {isProgramLocked ? (
                <p className="small">This program is loaded from history. Create a new one if you need different details.</p>
              ) : (
                <p className="small">Create a new program when you want a fresh set of certificates.</p>
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
            </div>

            <div style={{ marginTop: 12 }}>
              <label className="small">Certificate title</label>
              <input value={credTitle} onChange={(e) => setCredTitle(e.target.value)} />

              <label className="small" style={{ marginTop: 8, display: "block" }}>
                Recipient list (paste or import)
              </label>
              <textarea rows={6} value={recipientsInput} onChange={(e) => setRecipientsInput(e.target.value)} placeholder="Paste recipients (one per line or comma-separated)" />
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
                      <p className="small" style={{ margin: 0 }}>
                        Selected file
                      </p>
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
                  {previewUrl && selectedFile.type.startsWith("image/") && <img src={previewUrl} alt="Attachment preview" style={{ width: "100%", marginTop: 12, borderRadius: 12, border: "1px solid var(--stroke)" }} />}
                  {previewUrl && selectedFile.type === "application/pdf" && <iframe title="Attachment preview" src={previewUrl} style={{ width: "100%", marginTop: 12, borderRadius: 12, border: "1px solid var(--stroke)", height: 280 }} />}
                  {previewUrl && !selectedFile.type.startsWith("image/") && selectedFile.type !== "application/pdf" && (
                    <p className="small" style={{ marginTop: 8 }}>
                      Preview not available for this file type.
                    </p>
                  )}
                </div>
              )}

              {uploadMsg && (
                <p className="small" style={{ marginTop: 8 }}>
                  {uploadMsg}
                </p>
              )}
              {uploadError && (
                <p className="small" style={{ marginTop: 8 }}>
                  {uploadError}
                </p>
              )}

              {bulkProgress && (
                <p className="small" style={{ marginTop: 8 }}>
                  Progress: {bulkProgress.completed}/{bulkProgress.total} (chunk {bulkProgress.chunk}/{bulkProgress.chunks})
                </p>
              )}
              {bulkErrors.length > 0 && <pre style={{ marginTop: 8 }}>{bulkErrors.join("\n")}</pre>}

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

      </div>
      {showAdvancedModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15,25,27,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
            zIndex: 50,
          }}
        >
          <div className="card" style={{ maxWidth: 540, width: "100%" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <h3 style={{ margin: 0 }}>Advanced options</h3>
              <button className="btn secondary" style={{ padding: "6px 10px", fontSize: 12 }} onClick={() => setShowAdvancedModal(false)}>
                Close
              </button>
            </div>
            <p className="small" style={{ marginTop: 8 }}>IDs and bulk settings live here.</p>

            <details open style={{ marginTop: 16, border: "1px solid var(--stroke)", borderRadius: 12, padding: 12, background: "rgba(255,255,255,0.4)" }}>
              <summary style={{ cursor: "pointer", fontWeight: 600 }}>Organization</summary>
              <div style={{ marginTop: 12 }}>
                <label className="small">Organization ID</label>
                <input
                  value={localRegistry}
                  onChange={(e) => {
                    setLocalRegistry(e.target.value);
                    setRegistryId(e.target.value);
                  }}
                  placeholder="0x... organization id"
                />
                {localRegistry && (
                  <button className="btn secondary" style={{ marginTop: 8, padding: "6px 10px", fontSize: 12 }} onClick={() => copyToClipboard("Organization ID", localRegistry)}>
                    Copy organization ID
                  </button>
                )}
                <p className="small" style={{ marginTop: 6 }}>Use this only if you are switching browsers or accounts.</p>
                {localRegistry ? (
                  <div style={{ marginTop: 12 }}>
                    <label className="small">Organization name</label>
                    <input
                      value={orgNameDraft}
                      disabled={!canSetOrgName || registryQuery.isPending}
                      onChange={(e) => {
                        setOrgNameDraft(e.target.value);
                      }}
                      placeholder="e.g., Acme Academy"
                    />
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                      <button
                        className="btn"
                        disabled={!canSetOrgName || !orgNameDraft.trim() || isPending || isOrgRenaming || orgNameDraft.trim() === currentOrgName.trim()}
                        onClick={updateOrgName}
                      >
                        {currentOrgName ? "Save changes" : "Save name"}
                      </button>
                    </div>
                    {!canSetOrgName && (
                      <p className="small" style={{ marginTop: 6 }}>
                        Only the issuing wallet can edit the organization name.
                      </p>
                    )}
                    <p className="small" style={{ marginTop: 6 }}>
                      Saving changes costs a network fee.
                    </p>
                  </div>
                ) : (
                  <p className="small" style={{ marginTop: 8 }}>
                    Paste an organization ID to edit the name.
                  </p>
                )}
              </div>
            </details>

            <details style={{ marginTop: 12, border: "1px solid var(--stroke)", borderRadius: 12, padding: 12, background: "rgba(255,255,255,0.4)" }}>
              <summary style={{ cursor: "pointer", fontWeight: 600 }}>Program</summary>
              <div style={{ marginTop: 12 }}>
                <label className="small">Program ID</label>
                <input
                  value={contextId}
                  readOnly={isProgramLocked}
                  onChange={(e) => {
                    const next = e.target.value;
                    setContextId(next);
                    setPrefillEnabled(false);
                    setIsProgramLocked(!!next);
                  }}
                  placeholder="0x... program id"
                />
                {contextId && (
                  <button className="btn secondary" style={{ marginTop: 8, padding: "6px 10px", fontSize: 12 }} onClick={() => copyToClipboard("Program ID", contextId)}>
                    Copy program ID
                  </button>
                )}
                <p className="small" style={{ marginTop: 6 }}>Use this only if you are switching browsers or accounts.</p>
              </div>
            </details>

            <details style={{ marginTop: 12, border: "1px solid var(--stroke)", borderRadius: 12, padding: 12, background: "rgba(255,255,255,0.4)" }}>
              <summary style={{ cursor: "pointer", fontWeight: 600 }}>Issuing</summary>
              <div style={{ marginTop: 12 }}>
                <label className="small">Batch size (per approval)</label>
                <input type="number" min={1} max={50} value={chunkSize} onChange={(e) => setChunkSize(Math.max(1, Number(e.target.value) || 1))} />
                <p className="small">Smaller batches are safer but need more approvals.</p>

                <label className="small" style={{ marginTop: 12, display: "block" }}>
                  Extra viewers (optional)
                </label>
                <textarea rows={3} value={extraAccessInput} onChange={(e) => setExtraAccessInput(e.target.value)} placeholder="Paste wallet addresses" />
                {invalidAccess.length > 0 && (
                  <p className="small">
                    Invalid entries: {invalidAccess.slice(0, 5).join(", ")}
                    {invalidAccess.length > 5 ? "..." : ""}
                  </p>
                )}
                <p className="small">Recipients can always open the attachment. Extra viewers can see the download button in this app.</p>

                <label className="small" style={{ marginTop: 12, display: "block" }}>
                  Attachment link (optional)
                </label>
                <input value={docRef} onChange={(e) => setDocRef(e.target.value)} placeholder="Paste an existing attachment link" />
                <p className="small">Use this if you already have a link and do not want to upload.</p>
              </div>
            </details>
          </div>
        </div>
      )}
      {showSuccessModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15,25,27,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
            zIndex: 50,
          }}
        >
          <div className="card" style={{ maxWidth: 420, width: "100%", textAlign: "center" }}>
            <h3 style={{ marginTop: 0 }}>Issuance complete</h3>
            <p className="small" style={{ marginTop: 8 }}>
              {successCount ? `${successCount} certificates issued successfully.` : "Certificates issued successfully."}
            </p>
            <p className="small">Returning you to organization setup.</p>
          </div>
        </div>
      )}
      {issueSidebarTarget && createPortal(issueSidebar, issueSidebarTarget)}
      {issueStatusTarget && (msg || lastTx) && createPortal(
        <div className="hero-status-content" title={msg || undefined}>
          {msg && <span className="status-text">{msg}</span>}
          {lastTx && (
            <span className="status-pill" title={lastTx}>
              Tx {shortTx}
            </span>
          )}
        </div>,
        issueStatusTarget
      )}
    </>
  );
}
