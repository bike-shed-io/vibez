import { describe, expect, test } from "bun:test";
import {
  createAuthRoutes,
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
