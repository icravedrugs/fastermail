import crypto from "crypto";

// HMAC signing for action links embedded in digest emails (/email-action, /r).
// These URLs sit in the mailbox forever, so they must not be forgeable or
// replayable against other emails/targets. The key is derived from JMAP_TOKEN
// rather than a new env var: it is already secret, already deployed, and
// rotating it invalidates old links along with the old JMAP session — which is
// the behavior we want anyway.

let cachedKey: Buffer | null = null;

function signingKey(): Buffer {
  if (!cachedKey) {
    const secret = process.env.JMAP_TOKEN;
    if (!secret) {
      throw new Error("JMAP_TOKEN is required to sign action links");
    }
    cachedKey = crypto
      .createHash("sha256")
      .update(`fastermail-action-v1:${secret}`)
      .digest();
  }
  return cachedKey;
}

export function signActionToken(parts: string[]): string {
  return crypto
    .createHmac("sha256", signingKey())
    .update(parts.join("\n"))
    .digest("base64url")
    .slice(0, 22); // 132 bits of the MAC — ample for a URL token
}

export function verifyActionToken(
  parts: string[],
  token: string | null
): boolean {
  if (!token) return false;
  const expected = Buffer.from(signActionToken(parts));
  const provided = Buffer.from(token);
  return (
    expected.length === provided.length &&
    crypto.timingSafeEqual(expected, provided)
  );
}
