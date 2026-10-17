// Suno rooms end to end: picking the source, the token it needs, and the proxy URL
// listeners get. The proxy itself is faked here; its own behaviour is tested in
// suno-proxy/ (go test ./...).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { channels } from "./channels";
import { flushDirectory, handleClose, handleMessage, handleOpen } from "./ws";

const UUID = "6d6536c7-4e24-405c-8d6d-0c4e1c4ee981";
const SONG = `https://suno.com/song/${UUID}`;
const SHORT_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const PROXY = "http://suno-proxy.test";
const TOKEN = "dj-token";

type Fake = { id: string; sent: any[]; closed: boolean };
const open: string[] = [];
const originalFetch = globalThis.fetch;
const originalProxyUrl = process.env.SUNO_PROXY_URL;

type ProxyOptions = { token?: string; status?: string; error?: string; addError?: string };

/** A proxy that only accepts `token` and reports every song as ready. */
function installProxy(options: ProxyOptions = {}): string[] {
  const accepted = options.token ?? TOKEN;
  const fetched: string[] = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    fetched.push(url);
    if (url.includes("soundcloud")) return new Response("soundcloud must not be asked", { status: 500 });
    const headers = new Headers(init?.headers);
    if (headers.get("authorization") !== `Bearer ${accepted}`) {
      return Response.json({ error: "Suno access token required" }, { status: 401 });
    }
    if (url.endsWith("/auth")) return Response.json({ ok: true });
    // The proxy answers 502 with the DJ's complaint when a link resolves to nothing playable.
    if (options.addError && url.endsWith("/songs")) return Response.json({ error: options.addError }, { status: 502 });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const id = String(body.url ?? "").includes("/s/") ? SHORT_UUID : UUID;
    return Response.json({
      id,
      status: options.status ?? "ready",
      audioUrl: `${PROXY}/audio/${id}`,
      pageUrl: `https://suno.com/song/${id}`,
      title: "Raised on Rewind & Friends",
      artwork: `https://cdn2.suno.ai/${id}_cover.jpeg`,
      ...(options.error ? { error: options.error } : {}),
    });
  }) as typeof fetch;
  return fetched;
}

function user(email: string, givenName: string) {
  return { typ: "session" as const, email, name: `${givenName} Example`, givenName, picture: null, exp: Date.now() + 60_000 };
}

async function connect(id: string): Promise<Fake> {
  const fake: Fake = { id, sent: [], closed: false };
  handleOpen(
    {
      send(data: string) {
        fake.sent.push(JSON.parse(data));
      },
      close() {
        fake.closed = true;
      },
      readyState: 1,
      raw: undefined,
    } as any,
    id,
    user(`${id}@example.com`, "Pat"),
  );
  open.push(id);
  await handleMessage(id, JSON.stringify({ type: "hello", protocol: 2, name: "Pat" }));
  return fake;
}

function last(fake: Fake, type: string) {
  return [...fake.sent].reverse().find((msg) => msg.type === type);
}

async function send(fake: Fake, msg: object) {
  fake.sent.length = 0;
  await handleMessage(fake.id, JSON.stringify(msg));
}

async function goLive(fake: Fake) {
  await send(fake, { type: "live:start", djName: "DJ Pat", roomName: "fridays", trustedEmails: [] });
  const channel = channels.get(last(fake, "channel:state").channel.id);
  if (!channel) throw new Error("expected a live channel");
  return channel;
}

beforeEach(() => {
  process.env.SUNO_PROXY_URL = PROXY;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalProxyUrl === undefined) delete process.env.SUNO_PROXY_URL;
  else process.env.SUNO_PROXY_URL = originalProxyUrl;
  for (const id of open.splice(0)) handleClose(id);
  flushDirectory();
  channels.clear();
});

describe("picking Suno as the room source", () => {
  test("a room starts on SoundCloud and needs a token to switch", async () => {
    installProxy();
    const pat = await connect("suno-dj");
    const channel = await goLive(pat);
    expect(channel.source).toBe("soundcloud");

    await send(pat, { type: "room:source", source: "suno" });
    expect(last(pat, "error").message).toContain("Suno access token is required");
    expect(channel.source).toBe("soundcloud");

    await send(pat, { type: "room:source", source: "suno", token: TOKEN });
    expect(channel.source).toBe("suno");
    expect(last(pat, "channel:update").channel.source).toBe("suno");
  });

  test("a token the proxy rejects leaves the room where it was", async () => {
    installProxy({ token: "a-different-token" });
    const pat = await connect("suno-bad-token");
    const channel = await goLive(pat);

    await send(pat, { type: "room:source", source: "suno", token: "guessed" });
    expect(last(pat, "error").message).toContain("rejected");
    expect(channel.source).toBe("soundcloud");
    expect(channel.sunoToken).toBeNull();
  });

  test("switching the source clears the queue and stops the track", async () => {
    installProxy();
    const pat = await connect("suno-switch");
    const channel = await goLive(pat);
    channel.queue.push({ id: "q1", url: "https://soundcloud.com/a/b", title: "Q1", artwork: null, addedBy: "DJ Pat" });
    channel.trackUrl = "https://soundcloud.com/a/b";
    channel.streamUrl = "https://cf.sndcdn.com/x";
    channel.isPlaying = true;

    await send(pat, { type: "room:source", source: "suno", token: TOKEN });

    expect(channel.queue).toEqual([]);
    expect(channel.trackUrl).toBeNull();
    expect(channel.streamUrl).toBeNull();
    expect(channel.isPlaying).toBe(false);
    expect(last(pat, "queue").items).toEqual([]);
    expect(last(pat, "track")).toMatchObject({ url: null, streamUrl: null });
    expect(last(pat, "channel:update").notice).toContain("queue was cleared");
  });

  test("only the active DJ may change the source", async () => {
    installProxy();
    const pat = await connect("suno-owner");
    const channel = await goLive(pat);
    const listener = await connect("suno-listener");
    await send(listener, { type: "channel:join", channelId: channel.id });

    await send(listener, { type: "room:source", source: "suno", token: TOKEN });
    expect(last(listener, "error").message).toContain("Only the DJ can do that");
    expect(channel.source).toBe("soundcloud");
  });

  test("the access token never reaches a client", async () => {
    installProxy();
    const pat = await connect("suno-secret");
    const channel = await goLive(pat);
    const listener = await connect("suno-nosy");
    await send(listener, { type: "channel:join", channelId: channel.id });

    await send(pat, { type: "room:source", source: "suno", token: TOKEN });
    await send(pat, { type: "queue:add", url: SONG });
    await send(listener, { type: "channel:join", channelId: channel.id });
    flushDirectory();

    expect(channel.sunoToken).toBe(TOKEN);
    const everythingSent = JSON.stringify([...pat.sent, ...listener.sent]);
    expect(everythingSent).not.toContain(TOKEN);
  });
});

describe("playing in a Suno room", () => {
  test("DJ play and the queue use the proxy's audio URL, not SoundCloud", async () => {
    const fetched = installProxy();
    const pat = await connect("suno-play");
    const channel = await goLive(pat);
    await send(pat, { type: "room:source", source: "suno", token: TOKEN });

    await send(pat, { type: "dj:play", url: `https://www.suno.com/song/${UUID.toUpperCase()}/?si=1` });
    expect(last(pat, "track")).toMatchObject({
      url: SONG,
      title: "Raised on Rewind & Friends",
      streamUrl: `${PROXY}/audio/${UUID}`,
    });
    expect(channel.trackUrl).toBe(SONG);
    expect(channel.streamUrl).toBe(`${PROXY}/audio/${UUID}`);
    expect(channel.isPlaying).toBe(true);

    await send(pat, { type: "queue:add", url: "https://suno.com/s/Ab12" });
    const queued = last(pat, "queue").items;
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      url: `https://suno.com/song/${SHORT_UUID}`,
      title: "Raised on Rewind & Friends",
    });

    expect(fetched.some((url) => url.includes("soundcloud"))).toBe(false);
    expect(fetched.every((url) => url.startsWith(PROXY))).toBe(true);
  });

  test("a Suno playlist is rejected before the proxy is asked", async () => {
    const fetched = installProxy();
    const pat = await connect("suno-playlist");
    await goLive(pat);
    await send(pat, { type: "room:source", source: "suno", token: TOKEN });
    fetched.length = 0;

    await send(pat, { type: "queue:add", url: "https://suno.com/playlist/chill" });
    expect(last(pat, "error").message).toContain("Suno playlists aren't supported.");
    expect(fetched).toHaveLength(0);
  });

  test("a song the proxy can't download is reported, not put on air", async () => {
    installProxy({ status: "failed", error: "Couldn't find playable audio for this Suno song" });
    const pat = await connect("suno-failed");
    const channel = await goLive(pat);
    await send(pat, { type: "room:source", source: "suno", token: TOKEN });

    await send(pat, { type: "dj:play", url: SONG });
    expect(last(pat, "error").message).toContain("Couldn't find playable audio");
    expect(channel.trackUrl).toBeNull();
    expect(channel.isPlaying).toBe(false);
  });

  // The wording comes from suno.ErrNotPublished in suno-proxy/internal/suno.
  test("an unpublished song is named as such, not as a missing file", async () => {
    const notPublished = "That Suno song isn't published yet. Publish it on Suno, then add it again.";
    installProxy({ addError: notPublished });
    const pat = await connect("suno-unpublished");
    const channel = await goLive(pat);
    await send(pat, { type: "room:source", source: "suno", token: TOKEN });

    await send(pat, { type: "queue:add", url: SONG });
    expect(last(pat, "error").message).toBe(notPublished);
    expect(channel.queue).toEqual([]);

    await send(pat, { type: "dj:play", url: SONG });
    expect(last(pat, "error").message).toBe(notPublished);
    expect(channel.trackUrl).toBeNull();
    expect(channel.isPlaying).toBe(false);
  });

  test("a SoundCloud link in a Suno room is turned away", async () => {
    installProxy();
    const pat = await connect("suno-mixed");
    await goLive(pat);
    await send(pat, { type: "room:source", source: "suno", token: TOKEN });

    await send(pat, { type: "queue:add", url: "https://soundcloud.com/artist/track" });
    expect(last(pat, "error").message).toContain("This room plays from Suno.");
  });
});
