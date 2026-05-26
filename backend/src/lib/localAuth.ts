import crypto from "crypto";

export type PasswordRecord = {
  passwordHash: string;
  passwordSalt: string;
};

export type SessionUser = {
  userId: string;
  email: string;
};

type SessionPayload = SessionUser & {
  exp: number;
};

const PASSWORD_ITERATIONS = 210_000;
const PASSWORD_KEY_LENGTH = 32;
const PASSWORD_DIGEST = "sha256";

function b64urlEncode(value: Buffer | string): string {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function b64urlDecode(value: string): Buffer {
  let normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  while (normalized.length % 4) normalized += "=";
  return Buffer.from(normalized, "base64");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function passwordPepper(): string {
  return process.env.PASSWORD_PEPPER ?? "";
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function derivePasswordHash(password: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(
      `${password}${passwordPepper()}`,
      salt,
      PASSWORD_ITERATIONS,
      PASSWORD_KEY_LENGTH,
      PASSWORD_DIGEST,
      (err, derivedKey) => {
        if (err) reject(err);
        else resolve(derivedKey.toString("base64"));
      },
    );
  });
}

export async function createPasswordHash(
  password: string,
): Promise<PasswordRecord> {
  const passwordSalt = crypto.randomBytes(16).toString("base64");
  const passwordHash = await derivePasswordHash(password, passwordSalt);
  return { passwordHash, passwordSalt };
}

export async function verifyPassword(
  password: string,
  record: PasswordRecord,
): Promise<boolean> {
  const candidate = await derivePasswordHash(password, record.passwordSalt);
  return timingSafeEqual(candidate, record.passwordHash);
}

export function getSessionSecret(): string {
  const secret = process.env.AUTH_JWT_SECRET ?? "";
  if (!secret) {
    throw new Error("AUTH_JWT_SECRET must be set");
  }
  return secret;
}

export function signSessionToken(params: SessionUser & {
  expiresInSeconds: number;
  secret?: string;
}): string {
  const header = b64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload: SessionPayload = {
    userId: params.userId,
    email: normalizeEmail(params.email),
    exp: Math.floor(Date.now() / 1000) + params.expiresInSeconds,
  };
  const body = `${header}.${b64urlEncode(JSON.stringify(payload))}`;
  const signature = crypto
    .createHmac("sha256", params.secret ?? getSessionSecret())
    .update(body)
    .digest();
  return `${body}.${b64urlEncode(signature)}`;
}

export function verifySessionToken(
  token: string,
  secret = getSessionSecret(),
): SessionUser | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  const body = `${header}.${payload}`;
  const expected = b64urlEncode(
    crypto.createHmac("sha256", secret).update(body).digest(),
  );
  if (!timingSafeEqual(signature, expected)) return null;

  try {
    const parsed = JSON.parse(b64urlDecode(payload).toString("utf8")) as
      | SessionPayload
      | null;
    if (!parsed?.userId || !parsed.email || !parsed.exp) return null;
    if (parsed.exp <= Math.floor(Date.now() / 1000)) return null;
    return {
      userId: parsed.userId,
      email: normalizeEmail(parsed.email),
    };
  } catch {
    return null;
  }
}
