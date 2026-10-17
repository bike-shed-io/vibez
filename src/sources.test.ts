import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isRoomSource, resolveStreamUrl, resolveTracks, sourceLabel, type SourceContext } from "./sources";

const UUID = "6d6536c7-4e24-405c-8d6d-0c4e1c4ee981";
const SONG = `https://suno.com/song/${UUID}`;
const PROXY = "http://suno-proxy.test";

const suno: SourceContext = { source: "suno", sunoToken: "dj-token" };
const soundcloud: SourceContext = { source: "soundcloud", sunoToken: null };

const originalFetch = globalThis.fetch;
const originalProxyUrl = process.env.SUNO_PROXY_URL;
let calls: Array<{ url: string; method: string; token: string | null; body: any }>;

// Stands in for the proxy: /auth and /songs, nothing else.
function installProxy(song: Partial<Record<string, unknown>> = {}) {
  calls = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? "GET",
      token: headers.get("authorization")?.replace("Bearer ", "") ?? null,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (url.includes("soundcloud")) return new Response("soundcloud must not be asked", { status: 500 });
    return Response.json({
      id: UUID,
      status: "ready",
      audioUrl: `${PROXY}/audio/${UUID}`,
      pageUrl: SONG,
      title: "Raised on Rewind & Friends",
      artwork: `https://cdn2.suno.ai/${UUID}_cover.jpeg`,
      ...song,
    });
  }) as typeof fetch;
}

beforeEach(() => {
  process.env.SUNO_PROXY_URL = PROXY;
  installProxy();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalProxyUrl === undefined) delete process.env.SUNO_PROXY_URL;
  else process.env.SUNO_PROXY_URL = originalProxyUrl;
});

describe("room sources", () => {
  test("names the sources a room can play from", () => {
    expect(isRoomSource("suno")).toBe(true);
    expect(isRoomSource("soundcloud")).toBe(true);
    expect(isRoomSource("spotify")).toBe(false);
    expect(sourceLabel("suno")).toBe("Suno");
    expect(sourceLabel("soundcloud")).toBe("SoundCloud");
  });
});

describe("a Suno room", () => {
  test("adds a song through the proxy and plays the proxy's own URL", async () => {
    const tracks = await resolveTracks(SONG, suno);
    expect(tracks).toEqual([{
      url: SONG,
      title: "Raised on Rewind & Friends",
      artwork: `https://cdn2.suno.ai/${UUID}_cover.jpeg`,
    }]);
    expect(calls[0]).toMatchObject({ url: `${PROXY}/songs`, method: "POST", token: "dj-token", body: { url: SONG } });

    const streamUrl = await resolveStreamUrl(SONG, suno);
    expect(streamUrl).toBe(`${PROXY}/audio/${UUID}`);
    // Listeners play from the proxy — never from Suno's CDN.
    expect(streamUrl).not.toContain("suno.ai");
    expect(streamUrl).not.toContain("cloudfront");
  });

  test("rejects links the room can't play", async () => {
    await expect(resolveTracks("https://suno.com/playlist/chill", suno)).rejects.toThrow(
      "Suno playlists aren't supported.",
    );
    await expect(resolveTracks("https://suno.com/profile/necthan", suno)).rejects.toThrow(
      "Suno profiles aren't supported.",
    );
    await expect(resolveTracks("https://soundcloud.com/artist/track", suno)).rejects.toThrow(
      "This room plays from Suno.",
    );
    expect(calls).toHaveLength(0);
  });

  test("needs a token and a configured proxy before it asks for anything", async () => {
    await expect(resolveTracks(SONG, { source: "suno", sunoToken: null })).rejects.toThrow(
      "needs a Suno access token",
    );

    delete process.env.SUNO_PROXY_URL;
    await expect(resolveTracks(SONG, suno)).rejects.toThrow("Suno isn't set up on this server.");
    expect(calls).toHaveLength(0);
  });

  test("reports a song the proxy couldn't download instead of playing silence", async () => {
    installProxy({ status: "failed", error: "Couldn't find playable audio for this Suno song" });
    await expect(resolveStreamUrl(SONG, suno)).rejects.toThrow("Couldn't find playable audio");
  });
});

describe("a SoundCloud room", () => {
  test("turns a Suno link away rather than resolving it", async () => {
    await expect(resolveTracks(SONG, soundcloud)).rejects.toThrow("This room plays from SoundCloud.");
    expect(calls).toHaveLength(0);
  });
});
