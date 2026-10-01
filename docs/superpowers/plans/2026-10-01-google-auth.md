# Google Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the shared basic-auth password with "Sign in with Google" for any Google account; listening stays public, `dj:claim` and `queue:add` require sign-in.

**Architecture:** A new `src/auth.ts` holds stateless HMAC session tokens, the Google OAuth code flow as Hono routes under `/auth`, and a `sessionFromHeaders` helper. `src/index.ts` drops basic auth, mounts the routes, and resolves the user at WebSocket upgrade from the `vibez_session` cookie (web) or `Authorization: Bearer` (Mac). `src/ws.ts` stores the user per connection and gates `dj:claim` / `queue:add`. Web and Mac clients get sign-in UI; the Mac stores its token in Keychain.

**Tech Stack:** Bun, Hono 4.12 (`hono/cookie`), `node:crypto`, plain JS web client, SwiftUI macOS 14 app (Swift 6, XcodeGen), `AuthenticationServices`.

**Spec:** `docs/superpowers/specs/2026-09-28-google-auth-design.md`

## Global Constraints

- No new npm or SPM dependencies.
- Bun is not installed globally on this machine. Run tests with `npx -y bun test <file>`; if `which bun` finds a binary, plain `bun test` works too. Type-check with `npx -y bun x tsc --noEmit -p .`.
- `src/playlist.test.ts` calls SoundCloud live; it is slow (~20 s) and can flake on network. Re-run once before treating a failure as real.
- Exact names: cookie `vibez_session`; env vars `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `ADMIN_EMAILS`, `BANNED_EMAILS`; WebSocket error text `Sign in to DJ`; Keychain service `io.bike-shed.vibez.mac`, account `session`.
- Session tokens last 30 days; OAuth `state` lasts 10 minutes; Google scopes are exactly `openid email profile`.
- Redirects: web success `/`, web failure `/?auth_error=1`; Mac success `vibez://auth?token=<token>`, Mac failure `vibez://auth?error=1`.
- Never needs sign-in: loading pages, WebSocket connect, `join`, `vibez:boost`, `stream:refresh`. Needs sign-in: `dj:claim`, `queue:add` (all other `dj:*` / `queue:*` already require being the DJ).
- Emails are compared lowercased.
- Git: work on branch `feat/google-auth`. **Never push to `main`** — a push to `main` deploys production and releases the Mac app. Append commits only; no `--amend`, no rebase, no force-push. End every commit message with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|---|---|
| `src/auth.ts` (create) | Tokens, config, header parsing, Google OAuth routes |
| `src/auth.test.ts` (create) | Unit + route tests with a fake Google |
| `src/index.ts` (modify) | Remove basic auth, mount `/auth`, resolve user on WS upgrade |
| `src/ws.ts` (modify) | `Conn.user`, gate `dj:claim` / `queue:add`, `djName` on claim |
| `src/ws.test.ts`, `src/playlist.test.ts` (modify) | Pass users into `handleOpen` |
| `scripts/dev-session.ts` (create) | Mint a local session token without Google |
| `public/index.html`, `public/radio.js`, `public/style.css` (modify) | Sign-in UI, error toast, gated controls |
| `macos/VibezMac/Sources/VibezAuth.swift` (create) | Keychain token store, `ASWebAuthenticationSession`, `VibezUser` |
| `macos/VibezMac/Sources/VibezConfiguration.swift`, `VibezAppModel.swift`, `SetupView.swift`, `MenuBarContentView.swift`, `MainWindowView.swift` (modify) | Drop password, Bearer header, sign-in UI |
| `env/prod.env.tpl`, `env/prod.env.example`, `.env.example`, `.github/workflows/deploy.yml`, `macos/VibezMac/README.md` (modify) | Config and docs |

---

### Task 1: Session tokens and auth config

**Files:**
- Create: `src/auth.ts`
- Test: `src/auth.test.ts`

**Interfaces:**
- Produces (used by Tasks 2–5):
  - `type SessionUser = { email: string; name: string; givenName: string; picture: string | null; exp: number }`
  - `type AuthConfig = { googleClientId: string; googleClientSecret: string; sessionSecret: string; radioUrl: string; adminEmails: Set<string>; bannedEmails: Set<string> }`
  - `SESSION_COOKIE = "vibez_session"`, `SESSION_TTL_MS`, `STATE_TTL_MS`
  - `parseEmailList(value: string | undefined): Set<string>`
  - `loadAuthConfig(env?: Record<string, string | undefined>): AuthConfig`
  - `signToken(payload: object, secret: string): string`
  - `verifyToken<T extends { exp: number }>(token: string, secret: string, now: number): T | null`
  - `createSessionToken(user: Omit<SessionUser, "exp">, secret: string, now: number): string`
  - `sessionFromHeaders(headers: { cookie?: string | null; authorization?: string | null }, config: AuthConfig, now: number): SessionUser | null`

- [ ] **Step 1: Confirm the branch**

Run: `git branch --show-current`
Expected: `feat/google-auth`. If not, stop and report; do not create branches yourself.

- [ ] **Step 2: Write the failing tests** — create `src/auth.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  createSessionToken,
  loadAuthConfig,
  parseEmailList,
  sessionFromHeaders,
  signToken,
  verifyToken,
  SESSION_TTL_MS,
} from "./auth";

const SECRET = "test-secret";
const NOW = 1_000_000;
const USER = { email: "patrick@example.com", name: "Patrick O", givenName: "Patrick", picture: null };

function config(env: Record<string, string> = {}) {
  return loadAuthConfig({ SESSION_SECRET: SECRET, RADIO_URL: "https://vibez.test", ...env });
}

describe("signToken / verifyToken", () => {
  test("round trips a payload", () => {
    const token = signToken({ a: 1, exp: NOW + 1_000 }, SECRET);
    expect(verifyToken(token, SECRET, NOW)).toEqual({ a: 1, exp: NOW + 1_000 });
  });

  test("rejects a tampered payload", () => {
    const [, signature] = signToken({ a: 1, exp: NOW + 1_000 }, SECRET).split(".");
    const forged = `${Buffer.from(JSON.stringify({ a: 2, exp: NOW + 1_000 })).toString("base64url")}.${signature}`;
    expect(verifyToken(forged, SECRET, NOW)).toBeNull();
  });

  test("rejects a token signed with another secret", () => {
    expect(verifyToken(signToken({ exp: NOW + 1_000 }, "other"), SECRET, NOW)).toBeNull();
  });

  test("rejects an expired token", () => {
    expect(verifyToken(signToken({ exp: NOW }, SECRET), SECRET, NOW)).toBeNull();
  });

  test("rejects garbage", () => {
    expect(verifyToken("", SECRET, NOW)).toBeNull();
    expect(verifyToken("abc", SECRET, NOW)).toBeNull();
    expect(verifyToken("a.b.c", SECRET, NOW)).toBeNull();
  });
});

describe("parseEmailList", () => {
  test("splits, trims and lowercases", () => {
    expect([...parseEmailList(" A@x.com, b@Y.com ,,")]).toEqual(["a@x.com", "b@y.com"]);
  });

  test("handles undefined", () => {
    expect(parseEmailList(undefined).size).toBe(0);
  });
});

describe("createSessionToken", () => {
  test("expires after 30 days", () => {
    const token = createSessionToken(USER, SECRET, NOW);
    expect(verifyToken(token, SECRET, NOW + SESSION_TTL_MS - 1)?.email).toBe("patrick@example.com");
    expect(verifyToken(token, SECRET, NOW + SESSION_TTL_MS)).toBeNull();
  });
});

describe("sessionFromHeaders", () => {
  const token = createSessionToken(USER, SECRET, NOW);

  test("reads the session cookie", () => {
    const user = sessionFromHeaders({ cookie: `other=1; vibez_session=${token}` }, config(), NOW);
    expect(user?.email).toBe("patrick@example.com");
  });

  test("reads a Bearer token", () => {
    const user = sessionFromHeaders({ authorization: `Bearer ${token}` }, config(), NOW);
    expect(user?.givenName).toBe("Patrick");
  });

  test("ignores Basic auth from old Mac apps", () => {
    expect(sessionFromHeaders({ authorization: "Basic dTpw" }, config(), NOW)).toBeNull();
  });

  test("rejects banned emails", () => {
    const cfg = config({ BANNED_EMAILS: "Patrick@Example.com" });
    expect(sessionFromHeaders({ authorization: `Bearer ${token}` }, cfg, NOW)).toBeNull();
  });

  test("returns null without credentials", () => {
    expect(sessionFromHeaders({}, config(), NOW)).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx -y bun test src/auth.test.ts`
Expected: FAIL — `Cannot find module './auth'` (or equivalent).

- [ ] **Step 4: Implement** — create `src/auth.ts`:

```ts
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx -y bun test src/auth.test.ts`
Expected: PASS (all tests).

- [ ] **Step 6: Commit**

```bash
git add src/auth.ts src/auth.test.ts
git commit -m "feat: add signed session tokens for Google auth

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Google OAuth routes

**Files:**
- Modify: `src/auth.ts` (append)
- Test: `src/auth.test.ts` (append)

**Interfaces:**
- Consumes: everything from Task 1.
- Produces: `createAuthRoutes(config: AuthConfig, deps?: { fetch?: (input: string, init?: RequestInit) => Promise<Response>; now?: () => number }): Hono` exposing `GET /google`, `GET /google/callback`, `POST /logout`, `GET /me` (mounted at `/auth` in Task 3). `GET /me` returns `{ email, name, givenName, picture, isAdmin }` or 401 `{ error: "unauthorized" }`.

- [ ] **Step 1: Write the failing tests** — append to `src/auth.test.ts` (add `createAuthRoutes` to the import list at the top):

```ts
describe("createAuthRoutes", () => {
  const CLIENT_ID = "client-123.apps.googleusercontent.com";
  const cfg = () =>
    config({ GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: "shh", ADMIN_EMAILS: "admin@example.com", BANNED_EMAILS: "bad@example.com" });

  function fakeIdToken(claims: Record<string, unknown>) {
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${part({ alg: "RS256" })}.${part(claims)}.signature`;
  }

  function googleReturning(claims: Record<string, unknown>) {
    const calls: Array<{ url: string; body: string }> = [];
    const fetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, body: String(init?.body) });
      return new Response(JSON.stringify({ id_token: fakeIdToken(claims) }), { status: 200 });
    };
    return { fetch, calls };
  }

  const verifiedClaims = {
    aud: CLIENT_ID,
    email: "Patrick@Example.com",
    email_verified: true,
    name: "Patrick O",
    given_name: "Patrick",
    picture: "https://example.com/p.png",
  };

  async function startState(app: ReturnType<typeof createAuthRoutes>, client: "web" | "mac") {
    const res = await app.request(`/google?client=${client}`);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(location.searchParams.get("scope")).toBe("openid email profile");
    expect(location.searchParams.get("redirect_uri")).toBe("https://vibez.test/auth/google/callback");
    return location.searchParams.get("state")!;
  }

  test("web sign-in sets the session cookie and redirects home", async () => {
    const google = googleReturning(verifiedClaims);
    const app = createAuthRoutes(cfg(), { fetch: google.fetch, now: () => NOW });
    const state = await startState(app, "web");

    const res = await app.request(`/google/callback?code=abc&state=${encodeURIComponent(state)}`);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain("vibez_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(google.calls[0].url).toBe("https://oauth2.googleapis.com/token");
    expect(google.calls[0].body).toContain("code=abc");
    const token = cookie.match(/vibez_session=([^;]+)/)![1];
    expect(sessionFromHeaders({ cookie: `vibez_session=${token}` }, cfg(), NOW)?.email).toBe("patrick@example.com");
  });

  test("mac sign-in redirects to the vibez scheme with a token", async () => {
    const app = createAuthRoutes(cfg(), { fetch: googleReturning(verifiedClaims).fetch, now: () => NOW });
    const state = await startState(app, "mac");

    const res = await app.request(`/google/callback?code=abc&state=${encodeURIComponent(state)}`);

    const location = res.headers.get("location")!;
    expect(location.startsWith("vibez://auth?token=")).toBe(true);
    const token = decodeURIComponent(location.slice("vibez://auth?token=".length));
    expect(sessionFromHeaders({ authorization: `Bearer ${token}` }, cfg(), NOW)?.givenName).toBe("Patrick");
  });

  test("unverified email is rejected", async () => {
    const app = createAuthRoutes(cfg(), { fetch: googleReturning({ ...verifiedClaims, email_verified: false }).fetch, now: () => NOW });
    const state = await startState(app, "web");
    const res = await app.request(`/google/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(res.headers.get("location")).toBe("/?auth_error=1");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("banned email is rejected", async () => {
    const app = createAuthRoutes(cfg(), { fetch: googleReturning({ ...verifiedClaims, email: "bad@example.com" }).fetch, now: () => NOW });
    const state = await startState(app, "mac");
    const res = await app.request(`/google/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(res.headers.get("location")).toBe("vibez://auth?error=1");
  });

  test("token for another Google client is rejected", async () => {
    const app = createAuthRoutes(cfg(), { fetch: googleReturning({ ...verifiedClaims, aud: "someone-else" }).fetch, now: () => NOW });
    const state = await startState(app, "web");
    const res = await app.request(`/google/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(res.headers.get("location")).toBe("/?auth_error=1");
  });

  test("missing or expired state is rejected without calling Google", async () => {
    const google = googleReturning(verifiedClaims);
    const app = createAuthRoutes(cfg(), { fetch: google.fetch, now: () => NOW });
    const expired = signToken({ client: "web", exp: NOW }, SECRET);
    expect((await app.request(`/google/callback?code=abc`)).headers.get("location")).toBe("/?auth_error=1");
    expect((await app.request(`/google/callback?code=abc&state=${expired}`)).headers.get("location")).toBe("/?auth_error=1");
    expect(google.calls).toHaveLength(0);
  });

  test("sign-in is disabled without a Google client id", async () => {
    const app = createAuthRoutes(config(), { now: () => NOW });
    const res = await app.request("/google?client=web");
    expect(res.headers.get("location")).toBe("/?auth_error=1");
  });

  test("/me returns the signed-in user", async () => {
    const app = createAuthRoutes(cfg(), { now: () => NOW });
    const token = createSessionToken({ ...USER, email: "admin@example.com" }, SECRET, NOW);
    const res = await app.request("/me", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "admin@example.com", name: "Patrick O", givenName: "Patrick", picture: null, isAdmin: true });
    expect((await app.request("/me")).status).toBe(401);
  });

  test("/logout clears the cookie", async () => {
    const app = createAuthRoutes(cfg(), { now: () => NOW });
    const res = await app.request("/logout", { method: "POST" });
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toContain("vibez_session=;");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx -y bun test src/auth.test.ts`
Expected: FAIL — `createAuthRoutes` is not exported.

- [ ] **Step 3: Implement** — add these imports at the top of `src/auth.ts`:

```ts
import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
```

and append to `src/auth.ts`:

```ts
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
      { client, nonce: randomBytes(8).toString("hex"), exp: now() + STATE_TTL_MS },
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
    const state = verifyToken<{ client: AuthClient; exp: number }>(c.req.query("state") ?? "", config.sessionSecret, now());
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx -y bun test src/auth.test.ts`
Expected: PASS. If the `/logout` assertion fails only because Hono formats the cleared cookie differently, assert on `Max-Age=0` instead of `vibez_session=;` — the behavior (cookie cleared) is what matters.

- [ ] **Step 5: Commit**

```bash
git add src/auth.ts src/auth.test.ts
git commit -m "feat: add Google OAuth sign-in routes

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Wire auth into the server and gate DJ/queue actions

**Files:**
- Modify: `src/index.ts` (whole file, 60 lines)
- Modify: `src/ws.ts` (`Conn` type ~line 12, `handleOpen` ~line 80, `dj:claim` ~line 122, `queue:add` ~line 247)
- Modify: `src/ws.test.ts`, `src/playlist.test.ts` (helpers that call `handleOpen`)
- Modify: `env/prod.env.tpl`, `env/prod.env.example`, `.env.example`, `.github/workflows/deploy.yml`

**Interfaces:**
- Consumes: `loadAuthConfig`, `createAuthRoutes`, `sessionFromHeaders`, `SessionUser` (Tasks 1–2).
- Produces: `handleOpen(ws: WSContext, id: string, user?: SessionUser | null)`; `dj:claim` accepts `{ type: "dj:claim", djName?: string }`; anonymous `dj:claim` / `queue:add` answer `{ type: "error", message: "Sign in to DJ" }`.

- [ ] **Step 1: Write the failing tests** — replace the body of `src/ws.test.ts` from the line `const originalNotifyDjStarted = notifications.notifyDjStarted;` to the end of the file with:

```ts
const originalNotifyDjStarted = notifications.notifyDjStarted;

function testUser(email: string, givenName: string) {
  return { email, name: `${givenName} Example`, givenName, picture: null, exp: Date.now() + 60_000 };
}

async function connect(id: string, name: string, user: ReturnType<typeof testUser> | null = null) {
  const fake = createFakeWs();
  handleOpen(fake.ws, id, user);
  await handleMessage(id, JSON.stringify({ type: "join", name }));
  fake.sent.length = 0;
  return fake;
}

describe("websocket auth and Slack notifications", () => {
  let notified: string[];

  beforeEach(() => {
    resetStation();
    notified = [];
    notifications.notifyDjStarted = async (name) => {
      notified.push(name);
    };
  });

  afterEach(() => {
    for (const id of ["anon", "pat", "lisa"]) handleClose(id);
    notifications.notifyDjStarted = originalNotifyDjStarted;
    resetStation();
  });

  test("does not notify Slack when a listener joins while music is playing", async () => {
    station.trackUrl = "https://soundcloud.com/example/track";
    station.isPlaying = true;
    const { ws, sent } = createFakeWs();
    handleOpen(ws, "lisa");

    await handleMessage("lisa", JSON.stringify({ type: "join", name: "Lisa" }));

    expect(notified).toEqual([]);
    expect(sent.find((msg: any) => msg.type === "sync")).toBeDefined();
  });

  test("anonymous listeners cannot claim the DJ booth", async () => {
    const { sent } = await connect("anon", "Anon");

    await handleMessage("anon", JSON.stringify({ type: "dj:claim" }));

    expect(sent).toContainEqual({ type: "error", message: "Sign in to DJ" });
    expect(station.djId).toBeNull();
    expect(notified).toEqual([]);
  });

  test("signed-in users claim the booth under their DJ name and notify Slack once", async () => {
    await connect("pat", "Patrick", testUser("pat@example.com", "Patrick"));

    await handleMessage("pat", JSON.stringify({ type: "dj:claim", djName: "DJ Pat" }));

    expect(station.djId).toBe("pat");
    expect(station.djName).toBe("DJ Pat");
    expect(notified).toEqual(["DJ Pat"]);
  });

  test("anonymous listeners cannot add to the queue", async () => {
    const { sent } = await connect("anon", "Anon");

    await handleMessage("anon", JSON.stringify({ type: "queue:add", url: "https://soundcloud.com/x/y" }));

    expect(sent).toContainEqual({ type: "error", message: "Sign in to DJ" });
    expect(station.queue).toEqual([]);
  });

  test("anonymous listeners can still move the vibez slider", async () => {
    await connect("anon", "Anon");

    await handleMessage("anon", JSON.stringify({ type: "vibez:boost", boost: 0.5 }));

    expect(station.vibezBoost).toBe(0.5);
  });
});
```

Also add `handleClose` to the existing `./ws` import at the top of `src/ws.test.ts` if it is not already imported.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx -y bun test src/ws.test.ts`
Expected: FAIL — anonymous `dj:claim` is accepted (no "Sign in to DJ" error) and `djName` is ignored.

- [ ] **Step 3: Implement the gates in `src/ws.ts`**

Add the import:

```ts
import type { SessionUser } from "./auth";
```

Change the `Conn` type and `handleOpen`:

```ts
type Conn = {
  id: string;
  name: string;
  ws: WSContext;
  user: SessionUser | null;
};
```

```ts
export function handleOpen(ws: WSContext, id: string, user: SessionUser | null = null) {
  // Connection is registered but not yet named — wait for "join" message
  connections.set(id, { id, name: "Anonymous", ws, user });
}
```

Replace the `dj:claim` case with:

```ts
    case "dj:claim": {
      if (!conn.user) {
        conn.ws.send(JSON.stringify({ type: "error", message: "Sign in to DJ" }));
        return;
      }
      if (station.djId && station.djId !== id) {
        const djStillPresent = station.listeners.has(station.djId);
        if (djStillPresent && !djLeaseIsStale()) {
          conn.ws.send(JSON.stringify({ type: "error", message: `${station.djName} is already DJing` }));
          return;
        }
        releaseDj();
      }
      const name = String(msg.djName ?? "").trim().slice(0, 30) || conn.name || conn.user.givenName;
      conn.name = name;
      const listener = station.listeners.get(id);
      if (listener) listener.name = name;
      claimDj(id, name);
      void notifications.notifyDjStarted(name);
      broadcast({ type: "dj:changed", djName: name });
      broadcastListeners();
      break;
    }
```

In the `queue:add` case, directly after `if (!station.listeners.has(id)) return;`, add:

```ts
      if (!conn.user) {
        conn.ws.send(JSON.stringify({ type: "error", message: "Sign in to DJ" }));
        return;
      }
```

- [ ] **Step 4: Update `src/playlist.test.ts` helpers** so DJs and queueing listeners are signed in. Replace `setupDj` and `setupListener` with:

```ts
function testUser(name: string) {
  return { email: `${name.toLowerCase()}@example.com`, name, givenName: name, picture: null, exp: Date.now() + 60_000 };
}

async function setupDj(id: string, name: string) {
  const { ws, sent } = createFakeWs();
  handleOpen(ws, id, testUser(name));
  await handleMessage(id, JSON.stringify({ type: "join", name }));
  claimDj(id, name);
  sent.length = 0; // clear setup messages
  return { ws, sent };
}

async function setupListener(id: string, name: string) {
  const { ws, sent } = createFakeWs();
  handleOpen(ws, id, testUser(name));
  await handleMessage(id, JSON.stringify({ type: "join", name }));
  sent.length = 0;
  return { ws, sent };
}
```

- [ ] **Step 5: Replace `src/index.ts`** with:

```ts
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { createBunWebSocket } from "hono/bun";
import { handleOpen, handleClose, handleMessage } from "./ws";
import { startSlack } from "./slack";
import { createAuthRoutes, loadAuthConfig, sessionFromHeaders } from "./auth";

const { upgradeWebSocket, websocket } = createBunWebSocket();
const authConfig = loadAuthConfig();

const app = new Hono();

app.route("/auth", createAuthRoutes(authConfig));

// WebSocket endpoint — everyone may listen; the session (cookie or Bearer) only unlocks DJ/queue actions
app.get(
  "/ws",
  upgradeWebSocket((c) => {
    const id = crypto.randomUUID();
    const user = sessionFromHeaders(
      { cookie: c.req.header("cookie"), authorization: c.req.header("authorization") },
      authConfig,
      Date.now(),
    );
    return {
      onOpen(_evt, ws) {
        handleOpen(ws, id, user);
      },
      onMessage(evt, _ws) {
        // Bun delivers text frames as strings and binary frames as buffers, never Blobs
        handleMessage(id, evt.data as string | ArrayBuffer);
      },
      onClose() {
        handleClose(id);
      },
    };
  })
);

// Static files
app.use("/*", serveStatic({ root: "./public" }));

// Start
const port = Number(process.env.PORT) || 3005;

startSlack().catch((err) => {
  console.error("[slack] Failed to start Slack bot:", err.message);
});

export default {
  port,
  fetch: app.fetch,
  websocket,
};

console.log(`[vibez] Team Radio running at http://localhost:${port}`);
```

- [ ] **Step 6: Update config files**

`env/prod.env.tpl` — replace the `AUTH_PASSWORD=...` line with:

```text
GOOGLE_CLIENT_ID={{ op://infra/vibez/google-client-id }}
GOOGLE_CLIENT_SECRET={{ op://infra/vibez/google-client-secret }}
SESSION_SECRET={{ op://infra/vibez/session-secret }}
ADMIN_EMAILS={{ op://infra/vibez/admin-emails }}
BANNED_EMAILS={{ op://infra/vibez/banned-emails }}
```

`env/prod.env.example` — replace the `AUTH_PASSWORD=` line with:

```text
GOOGLE_CLIENT_ID=      # op://infra/vibez/google-client-id
GOOGLE_CLIENT_SECRET=  # op://infra/vibez/google-client-secret
SESSION_SECRET=        # op://infra/vibez/session-secret (openssl rand -hex 32)
ADMIN_EMAILS=          # op://infra/vibez/admin-emails, comma-separated
BANNED_EMAILS=         # op://infra/vibez/banned-emails, comma-separated, may be empty
```

`.env.example` — append:

```text

# Google sign-in (OAuth client of type "Web application")
# Redirect URI: <RADIO_URL>/auth/google/callback
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Signs session tokens. Empty = random per process (everyone is signed out on restart)
SESSION_SECRET=

# Comma-separated emails
ADMIN_EMAILS=
BANNED_EMAILS=
```

`.github/workflows/deploy.yml`:
- In the header comment, replace the `AUTH_PASSWORD` line with:

```text
#   GOOGLE_CLIENT_ID                - Google OAuth client id (Web application)
#   GOOGLE_CLIENT_SECRET            - Google OAuth client secret
#   SESSION_SECRET                  - random secret that signs session tokens (openssl rand -hex 32)
```

  and add under "Optional GitHub Secrets":

```text
#   ADMIN_EMAILS                    - comma-separated admin emails
#   BANNED_EMAILS                   - comma-separated banned emails
```

- In the "Generate prod.env" heredoc, replace `AUTH_PASSWORD=${{ secrets.AUTH_PASSWORD }}` with:

```text
          GOOGLE_CLIENT_ID=${{ secrets.GOOGLE_CLIENT_ID }}
          GOOGLE_CLIENT_SECRET=${{ secrets.GOOGLE_CLIENT_SECRET }}
          SESSION_SECRET=${{ secrets.SESSION_SECRET }}
          ADMIN_EMAILS=${{ secrets.ADMIN_EMAILS }}
          BANNED_EMAILS=${{ secrets.BANNED_EMAILS }}
```

- [ ] **Step 7: Run all tests and the type check**

Run: `npx -y bun test`
Expected: PASS (playlist tests may need one re-run on network flakes).

Run: `npx -y bun x tsc --noEmit -p .`
Expected: no errors (the previous `src/index.ts(35,27)` error is gone).

Run: `grep -rn "AUTH_PASSWORD\|basicAuth" src env .github .env.example`
Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts src/ws.ts src/ws.test.ts src/playlist.test.ts env/prod.env.tpl env/prod.env.example .env.example .github/workflows/deploy.yml
git commit -m "feat: require Google sign-in to DJ or queue

Drop the shared basic-auth password. Listening stays public; the
WebSocket resolves the session from the cookie or a Bearer token.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Web sign-in UI and dev session script

**Files:**
- Create: `scripts/dev-session.ts`
- Modify: `public/index.html` (header `:11-17`, DJ toggle `:120-122`, queue add row `:137-153`)
- Modify: `public/radio.js` (state `:3-11`, `join()` `:95-110`, `handleMessage` `error` case `:201`, `#djToggle` handler `:387-407`, `queue:add` sender `:671`, init `:694`)
- Modify: `public/style.css` (append)

**Interfaces:**
- Consumes: `GET /auth/me` → `{ email, name, givenName, picture, isAdmin }` or 401; `POST /auth/logout`; `GET /auth/google?client=web`; `?auth_error=1`; WS `dj:claim { djName }`; WS error `"Sign in to DJ"`; `createSessionToken` (Task 1).
- Produces: nothing other tasks consume.

The web client is one IIFE in `public/radio.js` using `$("id")` lookups and the `.hidden` class (`display:none !important`) for show/hide. The display name lives in `localStorage["vibez:name"]`; a stored name auto-joins on load. That same name is the DJ name.

- [ ] **Step 1: Create `scripts/dev-session.ts`**

```ts
// Mint a session token for local testing without Google:
//   SESSION_SECRET=dev bun scripts/dev-session.ts you@example.com "Your Name"
// Web: set cookie vibez_session=<token> on localhost. Mac:
//   security add-generic-password -U -s io.bike-shed.vibez.mac -a session -w <token>
import { createSessionToken } from "../src/auth";

const [email, name = email?.split("@")[0] ?? ""] = process.argv.slice(2);
const secret = process.env.SESSION_SECRET;
if (!email || !secret) {
  console.error('usage: SESSION_SECRET=... bun scripts/dev-session.ts <email> ["Full Name"]');
  process.exit(1);
}
console.log(createSessionToken({ email, name, givenName: name.split(" ")[0], picture: null }, secret, Date.now()));
```

- [ ] **Step 2: Add markup to `public/index.html`**

Inside `<header>`, after the existing status elements, add:

```html
      <div id="authArea" class="auth-area">
        <a id="signInLink" class="btn-secondary btn-small hidden" href="/auth/google?client=web">Sign in with Google</a>
        <div id="userChip" class="user-chip hidden">
          <img id="userAvatar" class="user-avatar hidden" alt="" referrerpolicy="no-referrer">
          <span id="userName"></span>
          <button id="signOutBtn" class="btn-secondary btn-small" type="button">Sign out</button>
        </div>
      </div>
```

Directly after `</header>`, add:

```html
    <p id="authError" class="notice notice-error hidden">Google sign-in failed. Try again.</p>
    <p id="errorToast" class="notice notice-error hidden"></p>
```

Directly after the `#djToggle` button, add:

```html
        <p id="djSignInHint" class="hint hidden">Sign in to DJ or add tracks.</p>
```

- [ ] **Step 3: Add the auth logic to `public/radio.js`**

Add next to the other state variables at the top of the IIFE:

```js
  let currentUser = null;
  let errorToastTimer = null;
```

Add DOM lookups next to the existing `$` lookups:

```js
  const signInLink = $("signInLink");
  const userChip = $("userChip");
  const userAvatar = $("userAvatar");
  const userName = $("userName");
  const signOutBtn = $("signOutBtn");
  const authError = $("authError");
  const errorToast = $("errorToast");
  const djSignInHint = $("djSignInHint");
```

Add these functions (anywhere inside the IIFE, before the init code at the bottom):

```js
  function showError(message) {
    errorToast.textContent = message;
    errorToast.classList.remove("hidden");
    clearTimeout(errorToastTimer);
    errorToastTimer = setTimeout(() => errorToast.classList.add("hidden"), 4000);
  }

  function renderAuth() {
    signInLink.classList.toggle("hidden", !!currentUser);
    userChip.classList.toggle("hidden", !currentUser);
    djSignInHint.classList.toggle("hidden", !!currentUser);
    djToggle.disabled = !currentUser;
    queueAddBtn.disabled = !currentUser;
    queueUrlInput.disabled = !currentUser;
    if (!currentUser) return;
    userName.textContent = currentUser.name;
    userAvatar.classList.toggle("hidden", !currentUser.picture);
    if (currentUser.picture) userAvatar.src = currentUser.picture;
    if (!nameInput.value) nameInput.value = currentUser.givenName;
  }

  async function loadUser() {
    try {
      const res = await fetch("/auth/me", { credentials: "same-origin" });
      currentUser = res.ok ? await res.json() : null;
    } catch {
      currentUser = null;
    }
    renderAuth();
  }

  signOutBtn.addEventListener("click", async () => {
    await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
    location.reload();
  });

  if (new URLSearchParams(location.search).has("auth_error")) {
    authError.classList.remove("hidden");
    history.replaceState(null, "", location.pathname);
  }
```

Use whatever variable names `radio.js` already uses for `#djToggle`, `#queueAddBtn`, `#queueUrlInput` and `#nameInput`; if they differ from the names above, adapt the four references.

In the incoming `error` case of `handleMessage` (currently only `console.warn`), keep the warn and add:

```js
        showError(msg.message);
        if (msg.message === "Sign in to DJ" && isDj) {
          // The server refused the claim; undo the optimistic DJ state
          djToggle.click();
        }
```

Only keep the `djToggle.click()` undo if clicking the toggle while `isDj` sends `dj:release` and resets the UI (it does today at `:387-407`). Otherwise reset the DJ UI the same way the release branch does.

In the `#djToggle` click handler, change the claim message to include the DJ name:

```js
      ws.send(JSON.stringify({ type: "dj:claim", djName: localStorage.getItem("vibez:name") || nameInput.value.trim() }));
```

At the bottom init (where a stored `vibez:name` auto-joins), call `loadUser();` before the auto-join.

- [ ] **Step 4: Append styles to `public/style.css`**

```css
.auth-area { display: flex; align-items: center; gap: 0.5rem; }
.user-chip { display: flex; align-items: center; gap: 0.5rem; color: var(--text-dim); font-size: 0.85rem; }
.user-avatar { width: 24px; height: 24px; border-radius: 50%; }
.notice { margin: 0.5rem 0; padding: 0.5rem 0.75rem; border-radius: 8px; font-size: 0.85rem; }
.notice-error { background: var(--warm-soft); color: var(--danger); }
.hint { color: var(--text-dim); font-size: 0.8rem; margin-top: 0.25rem; }
button:disabled, input:disabled { opacity: 0.5; cursor: not-allowed; }
```

- [ ] **Step 5: Verify**

```bash
node --check public/radio.js
SESSION_SECRET=dev PORT=3005 npx -y bun run src/index.ts &
sleep 2
curl -s -o /dev/null -w "%{http_code}\n" localhost:3005/            # 200, no password prompt
curl -s -o /dev/null -w "%{http_code}\n" localhost:3005/auth/me     # 401
TOKEN=$(SESSION_SECRET=dev npx -y bun scripts/dev-session.ts pat@example.com "Pat Example")
curl -s -H "cookie: vibez_session=$TOKEN" localhost:3005/auth/me   # {"email":"pat@example.com",...}
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" "localhost:3005/auth/google?client=web"  # 302 .../?auth_error=1 (no client id locally)
kill %1
```

Expected: the outputs noted in the comments. Then load `http://localhost:3005/` in a browser: signed out → "Sign in with Google" visible, DJ toggle and queue add disabled, hint visible. With `document.cookie = "vibez_session=<TOKEN>"` and a reload → avatar chip with "Pat Example", DJ toggle enabled, claiming DJ shows the name in the booth. Report what you could and could not check in a browser.

- [ ] **Step 6: Commit**

```bash
git add scripts/dev-session.ts public/index.html public/radio.js public/style.css
git commit -m "feat: add Google sign-in to the web client

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Mac app sign-in

**Files:**
- Create: `macos/VibezMac/Sources/VibezAuth.swift`
- Modify: `macos/VibezMac/Sources/VibezConfiguration.swift` (struct `:3-7`, `basicAuthHeader` `:47-51`)
- Modify: `macos/VibezMac/Sources/VibezAppModel.swift` (`saveConfiguration` `:201-208`, config load `:288-297`, `connect()` `:299-320`, `claimDJ` `:218-220`, `validate` `:599-621`, `ValidationError` `:668-686`)
- Modify: `macos/VibezMac/Sources/SetupView.swift` (password field `:89-91`, validation `:160-173`, helper text `:65`)
- Modify: `macos/VibezMac/Sources/MenuBarContentView.swift`, `macos/VibezMac/Sources/MainWindowView.swift` (DJ claim buttons)
- Modify: `macos/VibezMac/README.md`

**Interfaces:**
- Consumes: `GET /auth/google?client=mac` → `vibez://auth?token=…` / `vibez://auth?error=1`; `GET /auth/me` with `Authorization: Bearer <token>` → `{ email, name, givenName, picture, isAdmin }`; WS `dj:claim { djName }`.
- Produces (Plan 2 relies on these names): `struct VibezUser: Decodable { email, name, givenName, picture: String?, isAdmin: Bool }`; `enum SessionTokenStore { load() -> String?; save(_:); clear() }`; `@MainActor final class GoogleSignIn`; on `VibezAppModel`: `@Published private(set) var user: VibezUser?`, `@Published private(set) var isSigningIn: Bool`, `func signIn() async`, `func signOut()`, `func loadUser() async`.

Facts about the current code: `VibezConfiguration` is `Codable` with `serverURLString`, `listenerName`, `username`, `password`, stored as JSON in UserDefaults key `vibez.macos.configuration`. The WebSocket is created with `urlSession.webSocketTask(with: socketURL)` (no auth header) and sends `join {name: listenerName}`. `isDJ` is computed as `djName == configuration?.listenerName`, so the DJ name must stay equal to `listenerName`. That's why the Mac sends `listenerName` as `djName`.

- [ ] **Step 1: Create `macos/VibezMac/Sources/VibezAuth.swift`**

```swift
import AppKit
import AuthenticationServices
import Foundation
import Security

struct VibezUser: Decodable, Equatable {
  let email: String
  let name: String
  let givenName: String
  let picture: String?
  let isAdmin: Bool
}

enum SessionTokenStore {
  private static let service = "io.bike-shed.vibez.mac"
  private static let account = "session"

  private static var baseQuery: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
  }

  static func load() -> String? {
    var query = baseQuery
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
          let data = item as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  static func save(_ token: String) {
    clear()
    var query = baseQuery
    query[kSecValueData as String] = Data(token.utf8)
    SecItemAdd(query as CFDictionary, nil)
  }

  static func clear() {
    SecItemDelete(baseQuery as CFDictionary)
  }
}

enum GoogleSignInError: LocalizedError {
  case failed

  var errorDescription: String? { "Google sign-in failed. Try again." }
}

@MainActor
final class GoogleSignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
  private var session: ASWebAuthenticationSession?

  func signIn(serverURL: URL) async throws -> String {
    var components = URLComponents(url: serverURL.appending(path: "auth/google"), resolvingAgainstBaseURL: false)!
    components.queryItems = [URLQueryItem(name: "client", value: "mac")]
    let startURL = components.url!

    return try await withCheckedThrowingContinuation { continuation in
      let session = ASWebAuthenticationSession(url: startURL, callbackURLScheme: "vibez") { callbackURL, error in
        let token = callbackURL
          .flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false)?.queryItems }?
          .first { $0.name == "token" }?
          .value
        if let token, !token.isEmpty {
          continuation.resume(returning: token)
        } else {
          continuation.resume(throwing: error ?? GoogleSignInError.failed)
        }
      }
      session.presentationContextProvider = self
      self.session = session
      if !session.start() {
        continuation.resume(throwing: GoogleSignInError.failed)
      }
    }
  }

  nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    MainActor.assumeIsolated {
      NSApp.keyWindow ?? NSApp.windows.first { $0.isVisible } ?? ASPresentationAnchor()
    }
  }
}
```

If Swift 6 strict concurrency complains about the completion handler capturing the continuation, mark the closure `@Sendable` or wrap the resume calls in `Task { @MainActor in ... }`. Fix concurrency warnings without changing behavior.

- [ ] **Step 2: Drop the password from `VibezConfiguration.swift`**

Remove the `username` and `password` properties and the `basicAuthHeader` function. Old JSON in UserDefaults still decodes, because `Codable` ignores unknown keys. Update every initializer call site the compiler flags (`SetupView.swift` builds the struct at `:150-158`).

- [ ] **Step 3: Update `VibezAppModel.swift`**

Add state and a sign-in helper:

```swift
  @Published private(set) var user: VibezUser?
  @Published private(set) var isSigningIn = false
  private let googleSignIn = GoogleSignIn()
```

Add these methods:

```swift
  func signIn() async {
    guard let serverURL = configuration?.normalizedURL else { return }
    isSigningIn = true
    defer { isSigningIn = false }
    do {
      let token = try await googleSignIn.signIn(serverURL: serverURL)
      SessionTokenStore.save(token)
      await loadUser()
      reconnect(clearErrors: true)
    } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
      // User closed the sheet; stay signed out quietly
    } catch {
      errorMessage = GoogleSignInError.failed.localizedDescription
    }
  }

  func signOut() {
    SessionTokenStore.clear()
    user = nil
    reconnect(clearErrors: true)
  }

  func loadUser() async {
    guard let serverURL = configuration?.normalizedURL, let token = SessionTokenStore.load() else {
      user = nil
      return
    }
    var request = URLRequest(url: serverURL.appending(path: "auth/me"))
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    do {
      let (data, response) = try await URLSession.shared.data(for: request)
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      if status == 401 {
        SessionTokenStore.clear()
        user = nil
      } else if (200..<300).contains(status) {
        user = try JSONDecoder().decode(VibezUser.self, from: data)
      }
    } catch {
      // Offline: keep the token, try again on next connect
    }
  }
```

`ASWebAuthenticationSessionError` needs `import AuthenticationServices` at the top of the file.

In `connect()`, replace `urlSession.webSocketTask(with: socketURL)` with:

```swift
    var request = URLRequest(url: socketURL)
    if let token = SessionTokenStore.load() {
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
    let task = urlSession.webSocketTask(with: request)
```

(keep the rest of `connect()` as is, using `task` where the old code used the created task).

Change `claimDJ()` to send the DJ name:

```swift
  func claimDJ() {
    send(["type": "dj:claim", "djName": configuration?.listenerName ?? ""])
  }
```

Adapt this to the exact `send` signature in the file.

In `validate` (`:599-621`), remove the `Authorization` header and the `invalidCredentials` case. The check becomes a plain reachability GET of the server URL. Remove the `invalidCredentials` case from `ValidationError`.

Where the configuration is loaded at startup (`:288-297`), after a successful decode re-save it with the existing persistence code. That rewrites the stored JSON without the old `password` key. Then start `Task { await loadUser() }`. Also call `Task { await loadUser() }` at the end of `saveConfiguration`.

- [ ] **Step 4: Update `SetupView.swift`**

- Remove the password `SecureField`, the `password` state, its initializer line `:57`, and the password validation (`:170-173`).
- Replace the helper text at `:65` with: `"Listening needs no account. Sign in with Google to DJ or add tracks."`
- Add a section showing the account, using the model the view already has access to (pass it in if needed):

```swift
        LabeledContent("Account") {
          if let user = appModel.user {
            HStack {
              Text(user.name)
              Button("Sign out") { appModel.signOut() }
            }
          } else {
            Button(appModel.isSigningIn ? "Signing in…" : "Sign in with Google") {
              Task { await appModel.signIn() }
            }
            .disabled(appModel.isSigningIn || appModel.configuration == nil)
          }
        }
```

- Relabel the listener-name field to `"Name (also your DJ name)"`.

- [ ] **Step 5: Gate the DJ buttons** in `MenuBarContentView.swift` and `MainWindowView.swift`. Wherever a button calls `appModel.claimDJ()`, add `.disabled(appModel.user == nil)` and show `Text("Sign in to DJ").font(.caption).foregroundStyle(.secondary)` next to it when `appModel.user == nil`. Do the same for queue-add buttons.

- [ ] **Step 6: Update `macos/VibezMac/README.md`**. Replace the basic-auth setup description with: "Listening needs no account. Sign in with Google (Setup → Account) to DJ or add tracks. The session token is stored in Keychain (`io.bike-shed.vibez.mac` / `session`)."

- [ ] **Step 7: Build**

Run: `make macos-build`
Expected: `** BUILD SUCCEEDED **`. Fix all errors. Fix new Swift 6 concurrency warnings in files you touched.

- [ ] **Step 8: Smoke test against a local server** (optional, do it if time allows):

```bash
SESSION_SECRET=dev PORT=3005 npx -y bun run src/index.ts &
TOKEN=$(SESSION_SECRET=dev npx -y bun scripts/dev-session.ts pat@example.com "Pat Example")
security add-generic-password -U -s io.bike-shed.vibez.mac -a session -w "$TOKEN"
make macos-run   # set server URL to http://localhost:3005 in Setup; Account shows "Pat Example"; Claim DJ works
security delete-generic-password -s io.bike-shed.vibez.mac -a session
kill %1
```

Report what you could and could not verify.

- [ ] **Step 9: Commit**

```bash
git add macos/VibezMac
git commit -m "feat: sign in with Google in the Mac app

Replace the stored password with a Keychain session token that the
app sends as a Bearer header on the WebSocket.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Rollout Checklist (Patrick, not a coding task)

Before `feat/google-auth` can merge to `main`:

1. Google Cloud console → APIs & Services → OAuth consent screen: External, app name "Vibez", scopes `openid email profile`, publish to "In production".
2. Credentials → Create OAuth client ID → "Web application". Redirect URIs: `https://vibez.bike-shed.io/auth/google/callback` and `http://localhost:3005/auth/google/callback`.
3. Store client id, client secret, a new session secret (`openssl rand -hex 32`), admin emails and banned emails in 1Password `infra/vibez` (fields `google-client-id`, `google-client-secret`, `session-secret`, `admin-emails`, `banned-emails`).
4. Add the same values as GitHub Actions secrets: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `ADMIN_EMAILS`, `BANNED_EMAILS`. The CI deploy builds `prod.env` from GitHub secrets, not from 1Password.
5. Remove the `AUTH_PASSWORD` GitHub secret after the deploy succeeds.
