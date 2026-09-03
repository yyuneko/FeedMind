const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function keyFromSecret(secret: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try { raw = base64ToBytes(secret); } catch { throw new Error("invalid_credentials_key"); }
  if (raw.byteLength !== 32) throw new Error("invalid_credentials_key");
  return crypto.subtle.importKey("raw", raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptCredentials(secret: string, value: Record<string, string>): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await keyFromSecret(secret), encoder.encode(JSON.stringify(value)));
  return `v1.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(encrypted))}`;
}

export async function decryptCredentials(secret: string, payload: string): Promise<Record<string, string>> {
  const [version, encodedIv, encodedCiphertext] = payload.split(".");
  if (version !== "v1" || !encodedIv || !encodedCiphertext) throw new Error("invalid_encrypted_credentials");
  try {
    const iv = base64ToBytes(encodedIv); const ciphertext = base64ToBytes(encodedCiphertext);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer },
      await keyFromSecret(secret), ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength) as ArrayBuffer);
    const parsed = JSON.parse(decoder.decode(plain));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, string>;
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_credentials_key") throw error;
    throw new Error("credentials_decryption_failed");
  }
}
