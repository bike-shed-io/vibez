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
