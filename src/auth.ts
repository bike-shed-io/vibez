import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";

export type SessionUser = {
  typ: "session";
  email: string;
  name: string;
  givenName: string;
  picture: string | null;
  exp: number;
};

type StateToken = {
  typ: "state";
  client: AuthClient;
  nonce: string;
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

export function verifyToken<T extends { exp: number } = { exp: number }>(token: string, secret: string, now: number): T | null {
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

export function createSessionToken(user: Omit<SessionUser, "exp" | "typ">, secret: string, now: number): string {
  return signToken({ ...user, typ: "session", exp: now + SESSION_TTL_MS }, secret);
}

export function sessionFromHeaders(
  headers: { cookie?: string | null; authorization?: string | null },
  config: AuthConfig,
  now: number,
): SessionUser | null {
  const bearer = headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const cookie = headers.cookie?.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`))?.[1];
  const token = bearer ?? cookie;
  if (!token) return null;
  const user = verifyToken<SessionUser>(token, config.sessionSecret, now);
  if (!user || user.typ !== "session" || typeof user.email !== "string") return null;
  if (config.bannedEmails.has(user.email.toLowerCase())) return null;
  return user;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type AuthClient = "web" | "mac";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const part = jwt.split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function stringClaim(claims: Record<string, unknown>, key: string): string {
  const value = claims[key];
  return typeof value === "string" ? value.trim() : "";
}

export function createAuthRoutes(config: AuthConfig, deps: { fetch?: FetchLike; now?: () => number } = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const redirectUri = `${config.radioUrl}/auth/google/callback`;
  const routes = new Hono();

  routes.get("/google", (c) => {
    if (!config.googleClientId) {
      console.warn("[auth] GOOGLE_CLIENT_ID not set — Google sign-in disabled");
      return c.redirect("/?auth_error=1");
    }
    const client: AuthClient = c.req.query("client") === "mac" ? "mac" : "web";
    // ponytail: state is signed but not bound to a browser cookie; login-CSRF only lets an attacker sign you into their account
    const state = signToken(
      { typ: "state", client, nonce: randomBytes(8).toString("hex"), exp: now() + STATE_TTL_MS },
      config.sessionSecret,
    );
    const params = new URLSearchParams({
      client_id: config.googleClientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      prompt: "select_account",
    });
    return c.redirect(`${GOOGLE_AUTH_URL}?${params}`);
  });

  routes.get("/google/callback", async (c) => {
    const rawState = verifyToken<StateToken>(c.req.query("state") ?? "", config.sessionSecret, now());
    const state = rawState && rawState.typ === "state" ? rawState : null;
    const fail = () => c.redirect(state?.client === "mac" ? "vibez://auth?error=1" : "/?auth_error=1");
    const code = c.req.query("code");
    if (!state || !code) return fail();

    let claims: Record<string, unknown> | null = null;
    try {
      const response = await fetchImpl(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: config.googleClientId,
          client_secret: config.googleClientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }).toString(),
      });
      if (!response.ok) throw new Error(`Google token exchange failed with status ${response.status}`);
      const body = (await response.json()) as { id_token?: string };
      // The ID token comes straight from Google's token endpoint over TLS, so its signature needs no extra check.
      claims = body.id_token ? decodeJwtPayload(body.id_token) : null;
    } catch (err) {
      console.warn("[auth] Google sign-in failed", err);
      return fail();
    }

    const email = claims ? stringClaim(claims, "email").toLowerCase() : "";
    if (!claims || claims.aud !== config.googleClientId || claims.email_verified !== true || !email || config.bannedEmails.has(email)) {
      return fail();
    }

    const name = stringClaim(claims, "name") || email.split("@")[0];
    const token = createSessionToken(
      {
        email,
        name,
        givenName: stringClaim(claims, "given_name") || name,
        picture: stringClaim(claims, "picture") || null,
      },
      config.sessionSecret,
      now(),
    );

    if (state.client === "mac") return c.redirect(`vibez://auth?token=${encodeURIComponent(token)}`);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: config.radioUrl.startsWith("https://"),
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_TTL_MS / 1000,
    });
    return c.redirect("/");
  });

  routes.post("/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.body(null, 204);
  });

  routes.get("/me", (c) => {
    const user = sessionFromHeaders(
      { cookie: c.req.header("cookie"), authorization: c.req.header("authorization") },
      config,
      now(),
    );
    if (!user) return c.json({ error: "unauthorized" }, 401);
    return c.json({
      email: user.email,
      name: user.name,
      givenName: user.givenName,
      picture: user.picture,
      isAdmin: config.adminEmails.has(user.email.toLowerCase()),
    });
  });

  return routes;
}
