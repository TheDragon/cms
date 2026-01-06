// Helpers to extract Move fields safely (best-effort decoding).
export function asMoveFields(obj: any): any | null {
  const content = obj?.data?.content;
  if (!content || content.dataType !== "moveObject") return null;
  return content.fields || null;
}

export function decodeMoveString(v: any): string {
  if (typeof v === "string") return v;

  const bytes = v?.fields?.bytes;
  if (typeof bytes !== "string") return String(v ?? "");

  // bytes can be base64 or hex-ish depending on tooling; try both.
  try {
    if (bytes.startsWith("0x")) {
      const hex = bytes.slice(2);
      const arr = new Uint8Array(hex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
      return new TextDecoder().decode(arr);
    }
  } catch {}

  try {
    const raw = atob(bytes);
    const arr = new Uint8Array([...raw].map((c) => c.charCodeAt(0)));
    return new TextDecoder().decode(arr);
  } catch {}

  return String(bytes);
}

export function extractVecSetAddresses(v: any): string[] {
  // VecSet format can vary; try common shapes.
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String);
  if (Array.isArray(v?.fields?.contents)) return v.fields.contents.map(String);
  if (Array.isArray(v?.fields?.vec)) return v.fields.vec.map(String);
  if (Array.isArray(v?.fields?.items)) return v.fields.items.map(String);
  if (Array.isArray(v?.contents)) return v.contents.map(String);
  return [];
}
