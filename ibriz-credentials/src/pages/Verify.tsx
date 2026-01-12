import { useMemo, useState } from "react";
import { useCurrentAccount, useSuiClientQuery } from "@mysten/dapp-kit";
import { TYPES, WALRUS_VIEW_URL, getRegistryId, setRegistryId as setStoredRegistryId } from "../config";
import { asMoveFields, decodeMoveString, extractVecSetAddresses } from "../lib/move";
import { buildWalrusBlobUrl, parseWalrusRef } from "../lib/walrus";

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseAccessList(value: string | undefined): string[] {
  if (!value) return [];
  const decoded = safeDecode(value);
  return decoded
    .split(",")
    .map((addr) => normalizeAddress(addr))
    .filter(Boolean);
}

function formatIssuedAt(value: unknown): string {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return String(value ?? "");
  return new Date(num).toLocaleString();
}

export default function Verify() {
  const account = useCurrentAccount();
  const [registryId, setRegistryId] = useState(() => getRegistryId());

  const ownedQuery = useSuiClientQuery(
    "getOwnedObjects",
    {
      owner: account?.address ?? "0x0",
      filter: { StructType: TYPES.Credential },
      options: { showContent: true, showType: true },
    },
    { enabled: !!account }
  );

  const registryQuery = useSuiClientQuery(
    "getObject",
    { id: registryId || "0x0", options: { showContent: true, showType: true } },
    { enabled: !!registryId }
  );

  const credentials = useMemo(() => {
    const items = ownedQuery.data?.data ?? [];
    return items
      .map((item) => ({
        id: item?.data?.objectId || "",
        fields: asMoveFields(item),
      }))
      .filter((item) => item.id && item.fields);
  }, [ownedQuery.data]);

  const regFields = useMemo(() => asMoveFields(registryQuery.data), [registryQuery.data]);
  const revokedSet = useMemo(() => {
    const revoked = extractVecSetAddresses(regFields?.revoked);
    return new Set(revoked.map((addr) => normalizeAddress(addr)));
  }, [regFields]);

  const viewerAddress = account?.address ? normalizeAddress(account.address) : "";

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>My Certificates</h2>
      <p className="small">Certificates appear automatically when your wallet is connected.</p>

      {!account && <p className="small">Connect your wallet to view your certificates.</p>}

      {!!account && (
        <div style={{ marginTop: 12 }}>
          <label className="small">Organization ID (optional, for revocation checks)</label>
          <input
            value={registryId}
            onChange={(e) => {
              setRegistryId(e.target.value);
              setStoredRegistryId(e.target.value);
            }}
            placeholder="0x... organization id"
          />
          <p className="small">Ask the issuer for this ID if you want revocation status.</p>
        </div>
      )}

      {!!account && ownedQuery.isPending && (
        <p className="small" style={{ marginTop: 12 }}>
          Loading your certificates...
        </p>
      )}
      {!!account && ownedQuery.error && <p style={{ marginTop: 12 }}>Error: {String(ownedQuery.error)}</p>}

      {!!account && !ownedQuery.isPending && credentials.length === 0 && (
        <p className="small" style={{ marginTop: 12 }}>
          No certificates found for this wallet yet.
        </p>
      )}

      {!!account && credentials.length > 0 && (
        <div className="cards-grid" style={{ marginTop: 12 }}>
          {credentials.map(({ id, fields }) => {
            const docRef = decodeMoveString(fields?.doc_ref);
            const walrusRef = parseWalrusRef(docRef);
            const walrusUrl = buildWalrusBlobUrl(WALRUS_VIEW_URL, walrusRef);
            const allowList = parseAccessList(walrusRef?.meta?.acl);
            const recipient = normalizeAddress(String(fields?.recipient ?? ""));
            const canAccess = viewerAddress && (viewerAddress === recipient || allowList.includes(viewerAddress));
            const isRevoked = registryId ? revokedSet.has(normalizeAddress(id)) : false;
            const attachmentName = walrusRef?.meta?.name ? safeDecode(walrusRef.meta.name) : "attachment";

            return (
              <div key={id} className="card">
                <div className="row" style={{ alignItems: "center" }}>
                  <h3 style={{ margin: 0, flex: 1 }}>{decodeMoveString(fields?.title) || "Certificate"}</h3>
                  {registryId ? (
                    isRevoked ? <span className="badge bad">Revoked</span> : <span className="badge ok">Valid</span>
                  ) : (
                    <span className="badge">No revocation check</span>
                  )}
                </div>

                <div style={{ marginTop: 12 }}>
                  <p className="small">Certificate ID</p>
                  <pre>{id}</pre>

                  <p className="small">Issued by</p>
                  <pre>{fields?.issuer || "(missing)"}</pre>

                  <p className="small">Issued to</p>
                  <pre>{fields?.recipient || "(missing)"}</pre>

                  <p className="small">Program</p>
                  <pre>{fields?.context || "(missing)"}</pre>

                  <p className="small">Issued at</p>
                  <pre>{formatIssuedAt(fields?.issued_at_ms)}</pre>

                  <p className="small">Attachment link</p>
                  <pre>{docRef || "(none)"}</pre>

                  {walrusUrl && canAccess && (
                    <p className="small" style={{ marginTop: 8 }}>
                      Attachment:{" "}
                      <a href={walrusUrl} target="_blank" rel="noreferrer" download={attachmentName}>
                        Download file
                      </a>
                    </p>
                  )}
                  {walrusUrl && !canAccess && (
                    <p className="small" style={{ marginTop: 8 }}>
                      Attachment available to listed wallets only.
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!!account && (
        <p className="small" style={{ marginTop: 12 }}>
          Connected wallet: <span className="badge">{account.address}</span>
        </p>
      )}

      {!!account && (
        <div className="card" style={{ marginTop: 12 }}>
          <h3 style={{ marginTop: 0 }}>How revocation is checked</h3>
          <p className="small">We read the organization list and see if your certificate ID is revoked.</p>
          {registryQuery.isPending && <p className="small">Loading organization list...</p>}
          {registryQuery.error && <p>Error: {String(registryQuery.error)}</p>}
          {registryId && !regFields && !registryQuery.isPending && (
            <p className="small">Organization list loaded, but details could not be read.</p>
          )}
        </div>
      )}
    </div>
  );
}
