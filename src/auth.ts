import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type SessionUser = {
  email: string;
  name: string;
  givenName: string;
  picture: string | null;
  exp: number;
};

export type AuthConfig = {
  googleClientId: string;
  googleClientSecret: string;
  sessionSecret: string;
  radioUrl: string;
  adminEmails: Set<string>;
  bannedEmails: Set<string>;
};

export const SESSION_COOKIE = "vibez_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const STATE_TTL_MS = 10 * 60 * 1000;

export function parseEmailList(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function loadAuthConfig(env: Record<string, string | undefined> = process.env): AuthConfig {
  let sessionSecret = env.SESSION_SECRET ?? "";
  if (!sessionSecret) {
    // ponytail: random per-process secret for local dev; every restart signs everyone out
    sessionSecret = randomBytes(32).toString("hex");
    console.warn("[auth] SESSION_SECRET not set — using a random secret, sessions reset on restart");
  }
  return {
    googleClientId: env.GOOGLE_CLIENT_ID ?? "",
    googleClientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
    sessionSecret,
    radioUrl: (env.RADIO_URL ?? "http://localhost:3005").replace(/\/$/, ""),
    adminEmails: parseEmailList(env.ADMIN_EMAILS),
    bannedEmails: parseEmailList(env.BANNED_EMAILS),
  };
}

function hmac(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function signToken(payload: object, secret: string): string {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${data}.${hmac(data, secret)}`;
}

export function verifyToken(token: string, secret: string, now: number): any;
export function verifyToken<T extends { exp: number }>(token: string, secret: string, now: number): T | null;
export function verifyToken<T extends { exp: number }>(token: string, secret: string, now: number): T | null {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [data, signature] = parts;
  const expected = Buffer.from(hmac(data, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as T;
    if (typeof payload.exp !== "number" || payload.exp <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

export function createSessionToken(user: Omit<SessionUser, "exp">, secret: string, now: number): string {
  return signToken({ ...user, exp: now + SESSION_TTL_MS }, secret);
}

export function sessionFromHeaders(
  headers: { cookie?: string | null; authorization?: string | null },
  config: AuthConfig,
  now: number,
): SessionUser | null {
  const bearer = headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const cookie = headers.cookie?.match(/(?:^|;\s*)vibez_session=([^;]+)/)?.[1];
  const token = bearer ?? cookie;
  if (!token) return null;
  const user = verifyToken<SessionUser>(token, config.sessionSecret, now);
  if (!user || config.bannedEmails.has(user.email.toLowerCase())) return null;
  return user;
}
