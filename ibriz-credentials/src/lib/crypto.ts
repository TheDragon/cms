const textEncoder = new TextEncoder();

export const DEFAULT_PBKDF2_ITERATIONS = 100000;
export const AES_GCM_IV_BYTES = 12;
export const SALT_BYTES = 16;

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array {
  let base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = base64.length % 4;
  if (padding) {
    base64 += "=".repeat(4 - padding);
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey("raw", textEncoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptWithPassphrase(
  plaintext: ArrayBuffer,
  passphrase: string,
  salt: Uint8Array,
  iv: Uint8Array,
  iterations: number
): Promise<ArrayBuffer> {
  const key = await deriveKey(passphrase, salt, iterations);
  return crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
}

export async function decryptWithPassphrase(
  ciphertext: ArrayBuffer,
  passphrase: string,
  salt: Uint8Array,
  iv: Uint8Array,
  iterations: number
): Promise<ArrayBuffer> {
  const key = await deriveKey(passphrase, salt, iterations);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
}
