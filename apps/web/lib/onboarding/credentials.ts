import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VERSION = "v1";

function key(): Buffer {
  const secret = process.env.CONNECTOR_ENCRYPTION_KEY ?? process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("Connector encryption is not configured.");
  return createHash("sha256").update(`seo-autopilot:connectors:${secret}`).digest();
}

export function encryptCredential(value: string): string {
  if (!value.trim()) throw new Error("Credential cannot be empty.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptCredential(envelope: string): string {
  const [version, iv, tag, ciphertext] = envelope.split(".");
  if (version !== VERSION || !iv || !tag || !ciphertext) throw new Error("Credential envelope is invalid.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Credential envelope could not be decrypted.");
  }
}
