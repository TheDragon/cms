import { useMemo, useState } from "react";
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClientQuery } from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { MODULE, PACKAGE_ID, TYPES, getRegistryId, setRegistryId as setStoredRegistryId } from "../config";
import { asMoveFields, extractVecSetAddresses } from "../lib/move";

function target(fn: string) {
  return `${PACKAGE_ID}::${MODULE}::${fn}`;
}

export default function Revocations() {
  const account = useCurrentAccount();
  const [registryId, setRegistryId] = useState(() => getRegistryId());
  const [credentialId, setCredentialId] = useState("");
  const [msg, setMsg] = useState("");
  const [lastTx, setLastTx] = useState<string | null>(null);

  const { mutateAsync: signAndExecute, isPending } = useSignAndExecuteTransaction();

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

  const issuerCapId = useMemo(() => capQuery.data?.data?.[0]?.data?.objectId || "", [capQuery.data]);
  const isIssuer = !!issuerCapId;

  const registryQuery = useSuiClientQuery("getObject", registryId ? { id: registryId, options: { showContent: true, showType: true } } : null);

  const regFields = useMemo(() => asMoveFields(registryQuery.data), [registryQuery.data]);
  const revoked = useMemo(() => extractVecSetAddresses(regFields?.revoked), [regFields]);

  async function revoke() {
    if (!account) return;
    if (!isIssuer) return setMsg("❌ This wallet is not the ABC issuer (no IssuerCap).");
    if (!registryId) return setMsg("❌ Missing Registry ID.");
    if (!credentialId.startsWith("0x")) return setMsg("❌ Credential ID must be 0x...");
    setMsg("");

    const tx = new Transaction();
    tx.moveCall({
      target: target("revoke"),
      arguments: [tx.object(issuerCapId), tx.object(registryId), tx.pure.address(credentialId)],
    });

    const res = await signAndExecute({
      transaction: tx,
      options: { showEffects: true, showObjectChanges: true },
    });

    setLastTx(res.digest);
    setMsg("✅ Revoked (if the contract accepted it).");
    registryQuery.refetch();
  }

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Revocations (Issuer Only)</h2>

      {!account ? <p className="small">Connect issuer wallet to revoke credentials.</p> : <p className="small">IssuerCap detected: {isIssuer ? <span className="badge ok">Yes</span> : <span className="badge bad">No</span>}</p>}

      <div className="row" style={{ marginTop: 12 }}>
        <div>
          <label className="small">Registry ID</label>
          <input
            value={registryId}
            onChange={(e) => {
              setRegistryId(e.target.value);
              setStoredRegistryId(e.target.value);
            }}
            placeholder="0x... shared registry id"
          />
        </div>
        <div>
          <label className="small">Credential ID to revoke</label>
          <input value={credentialId} onChange={(e) => setCredentialId(e.target.value)} placeholder="0x... credential id" />
        </div>
      </div>

      <button className="btn" style={{ marginTop: 12 }} disabled={!account || !isIssuer || isPending} onClick={revoke}>
        Revoke Credential
      </button>

      {msg && <p style={{ marginTop: 12 }}>{msg}</p>}
      {lastTx && (
        <p className="small">
          Last tx digest: <span className="badge">{lastTx}</span>
        </p>
      )}

      <div className="card" style={{ marginTop: 12 }}>
        <h3 style={{ marginTop: 0 }}>Revoked IDs (from Registry)</h3>
        {registryQuery.isPending && <p className="small">Loading registry…</p>}
        {registryQuery.error && <p>❌ {String(registryQuery.error)}</p>}
        {!registryQuery.isPending && <pre>{revoked.length ? revoked.join("\n") : "(none found / or registry parsing differs)"}</pre>}
      </div>
    </div>
  );
}
