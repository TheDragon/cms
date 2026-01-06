export const NETWORK = (import.meta.env.VITE_NETWORK || "testnet") as
  | "testnet"
  | "devnet"
  | "mainnet"
  | "localnet";

export const PACKAGE_ID = import.meta.env.VITE_PACKAGE_ID as string;
export const MODULE = (import.meta.env.VITE_MODULE || "credentials") as string;

export const WALRUS_UPLOAD_URL = import.meta.env.VITE_WALRUS_UPLOAD_URL as string | undefined;
export const WALRUS_VIEW_URL = import.meta.env.VITE_WALRUS_VIEW_URL as string | undefined;

// Single ABC issuer registry (shared object). You can set via .env or let the app store it in localStorage once.
const REGISTRY_STORAGE_KEY = "IBRIZ_REGISTRY_ID";

export function getRegistryId(): string {
  const fromEnv = import.meta.env.VITE_REGISTRY_ID as string | undefined;
  if (fromEnv) return fromEnv;
  if (typeof window === "undefined") return "";
  return localStorage.getItem(REGISTRY_STORAGE_KEY) || "";
}

export function setRegistryId(value: string) {
  if (typeof window === "undefined") return;
  if (!value) {
    localStorage.removeItem(REGISTRY_STORAGE_KEY);
    return;
  }
  localStorage.setItem(REGISTRY_STORAGE_KEY, value);
}

export const TYPES = {
  IssuerCap: `${PACKAGE_ID}::${MODULE}::IssuerCap`,
  Registry: `${PACKAGE_ID}::${MODULE}::Registry`,
  Context: `${PACKAGE_ID}::${MODULE}::Context`,
  Credential: `${PACKAGE_ID}::${MODULE}::Credential`,
};
