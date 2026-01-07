export type WalrusScheme = "walrus" | "walrus-object";

export type WalrusRef = {
  scheme: WalrusScheme;
  id: string;
  meta: Record<string, string>;
  raw: string;
};

export function parseWalrusRef(ref: string): WalrusRef | null {
  if (!ref) return null;
  const trimmed = ref.trim();
  if (!trimmed) return null;

  const [base, fragment] = trimmed.split("#", 2);
  let scheme: WalrusScheme | null = null;
  let id = "";

  if (base.startsWith("walrus://")) {
    scheme = "walrus";
    id = base.slice("walrus://".length).trim();
  } else if (base.startsWith("walrus-object://")) {
    scheme = "walrus-object";
    id = base.slice("walrus-object://".length).trim();
  } else {
    return null;
  }

  if (!id) return null;

  const meta: Record<string, string> = {};
  if (fragment) {
    const parts = fragment.split(";");
    for (const part of parts) {
      if (!part) continue;
      const [key, ...valueParts] = part.split("=");
      if (!key) continue;
      meta[key] = valueParts.join("=");
    }
  }

  return { scheme, id, meta, raw: trimmed };
}

export function buildWalrusBlobUrl(base: string | undefined, ref: WalrusRef | null): string {
  if (!base || !ref) return "";
  const normalized = base.replace(/\/$/, "");
  const baseUrl = normalized.includes("/v1/blobs") ? normalized : `${normalized}/v1/blobs`;
  if (ref.scheme === "walrus") {
    return `${baseUrl}/${ref.id}`;
  }
  return `${baseUrl}/by-object-id/${ref.id}`;
}
