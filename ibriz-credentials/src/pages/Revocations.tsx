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
    {
      owner: account?.address ?? "0x0",
      filter: { StructType: TYPES.IssuerCap },
      options: { showType: true },
    },
    { enabled: !!account }
  );

  const issuerCapId = useMemo(() => capQuery.data?.data?.[0]?.data?.objectId || "", [capQuery.data]);
  const isIssuer = !!issuerCapId;

  const registryQuery = useSuiClientQuery(
    "getObject",
    { id: registryId || "0x0", options: { showContent: true, showType: true } },
    { enabled: !!registryId }
  );

  const regFields = useMemo(() => asMoveFields(registryQuery.data), [registryQuery.data]);
  const revoked = useMemo(() => extractVecSetAddresses(regFields?.revoked), [regFields]);

  async function revoke() {
    if (!account) return;
    if (!isIssuer) return setMsg("This wallet does not have admin access.");
    if (!registryId) return setMsg("Please enter the registry ID.");
    if (!credentialId.startsWith("0x")) return setMsg("Certificate ID must start with 0x.");
    setMsg("");

    const tx = new Transaction();
    tx.moveCall({
      target: target("revoke"),
      arguments: [tx.object(issuerCapId), tx.object(registryId), tx.pure.address(credentialId)],
    });

    const res = await signAndExecute({ transaction: tx });

    setLastTx(res.digest);
    setMsg("Revoke submitted. If approved, it will be marked as revoked.");
    registryQuery.refetch();
  }

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Revoke Certificates (Admin only)</h2>

      {!account ? <p className="small">Connect the admin wallet to revoke certificates.</p> : <p className="small">Admin access detected: {isIssuer ? <span className="badge ok">Yes</span> : <span className="badge bad">No</span>}</p>}

      <div className="row" style={{ marginTop: 12 }}>
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
        <div>
          <label className="small">Certificate ID to revoke</label>
          <input value={credentialId} onChange={(e) => setCredentialId(e.target.value)} placeholder="0x... certificate id" />
        </div>
      </div>

      <button className="btn" style={{ marginTop: 12 }} disabled={!account || !isIssuer || isPending} onClick={revoke}>
        Revoke Certificate
      </button>

      {msg && <p style={{ marginTop: 12 }}>{msg}</p>}
      {lastTx && (
        <p className="small">
          Last transaction: <span className="badge">{lastTx}</span>
        </p>
      )}

      <div className="card" style={{ marginTop: 12 }}>
        <h3 style={{ marginTop: 0 }}>Revoked certificates (from registry)</h3>
        {registryQuery.isPending && <p className="small">Loading registry...</p>}
        {registryQuery.error && <p>Error: {String(registryQuery.error)}</p>}
        {!registryQuery.isPending && <pre>{revoked.length ? revoked.join("\n") : "(none found or registry format changed)"}</pre>}
      </div>
    </div>
  );
}
