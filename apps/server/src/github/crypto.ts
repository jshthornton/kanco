import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const ALGO = "aes-256-gcm";

export function resolveSecret(dataDir: string): Buffer {
  const envSecret = process.env.KANCO_SECRET;
  if (envSecret && envSecret.length >= 16) {
    return scryptSync(envSecret, "kanco-v1", 32);
  }
  const path = `${dataDir}/.secret`;
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  const material = readFileSync(path, "utf8");
  return scryptSync(material, "kanco-v1", 32);
}

export function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64url"), tag.toString("base64url"), enc.toString("base64url")].join(
    ".",
  );
}

export function decrypt(key: Buffer, blob: string): string {
  const [iv, tag, enc] = blob.split(".");
  if (!iv || !tag || !enc) throw new Error("bad ciphertext");
  const decipher = createDecipheriv(ALGO, key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  const out = Buffer.concat([
    decipher.update(Buffer.from(enc, "base64url")),
    decipher.final(),
  ]);
  return out.toString("utf8");
}
