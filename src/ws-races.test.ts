// Deterministic (no-network) tests for races between an in-flight `await` (track/stream
// resolution) and a concurrent state change — the bugs fixed in fix round 1. These mock
// "./soundcloud" with controllable promises, so they live in their own file and restore the
// real module in afterAll to avoid leaking the mock into other test files.
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { channels, type QueueItem } from "./channels";
import { flushDirectory, handleClose, handleMessage, handleOpen } from "./ws";
import * as realSoundcloud from "./soundcloud";
import type { TrackRef } from "./soundcloud";

type Fake = { id: string; sent: any[]; closed: boolean };
const open: string[] = [];

function user(email: string, givenName: string) {
  return { typ: "session" as const, email, name: `${givenName} Example`, givenName, picture: null, exp: Date.now() + 60_000 };
}

async function connect(id: string, name: string, account: ReturnType<typeof user> | null = null): Promise<Fake> {
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
    account,
  );
  open.push(id);
  await handleMessage(id, JSON.stringify({ type: "hello", protocol: 2, name }));
  return fake;
}

function last(fake: Fake, type: string) {
  return [...fake.sent].reverse().find((msg) => msg.type === type);
}

async function send(fake: Fake, msg: object) {
  fake.sent.length = 0;
  await handleMessage(fake.id, JSON.stringify(msg));
}

async function goLive(fake: Fake, options: object = {}) {
  await send(fake, { type: "live:start", djName: "DJ Pat", roomName: "fridays", trustedEmails: [], ...options });
  return last(fake, "channel:state").channel.id as string;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// --- Controllable "./soundcloud" mock, delegating to swappable implementations ---

// Captured once, before mock.module runs below — "./soundcloud"'s named exports are live
// bindings, so reading realSoundcloud.resolveTracks *after* mocking would read back our own
// mock (self-poisoning the "restore" and infinite-looping on the next real call). These two
// consts are the only safe reference to the pristine originals.
const REAL_RESOLVE_TRACKS = realSoundcloud.resolveTracks;
const REAL_RESOLVE_STREAM_URL = realSoundcloud.resolveStreamUrl;

let resolveTracksImpl: typeof realSoundcloud.resolveTracks = REAL_RESOLVE_TRACKS;
let resolveStreamUrlImpl: typeof realSoundcloud.resolveStreamUrl = REAL_RESOLVE_STREAM_URL;

mock.module("./soundcloud", () => ({
  resolveTracks: (url: string) => resolveTracksImpl(url),
  resolveStreamUrl: (url: string) => resolveStreamUrlImpl(url),
}));

afterAll(() => {
  // Restore the real module so later test files (and re-runs) see real network calls again.
  resolveTracksImpl = REAL_RESOLVE_TRACKS;
  resolveStreamUrlImpl = REAL_RESOLVE_STREAM_URL;
  mock.module("./soundcloud", () => ({
    resolveTracks: REAL_RESOLVE_TRACKS,
    resolveStreamUrl: REAL_RESOLVE_STREAM_URL,
  }));
});

const defaultTrack: TrackRef = { url: "https://soundcloud.com/mock/track", title: "Mock Track", artwork: null };

beforeEach(() => {
  channels.clear();
  resolveTracksImpl = async () => [defaultTrack];
  resolveStreamUrlImpl = async () => "https://mock.sndcdn.com/stream.mp3";
});

afterEach(() => {
  for (const id of open.splice(0)) handleClose(id);
  flushDirectory();
  channels.clear();
});

describe("dj:play races (DJ authority lost mid-resolve)", () => {
  test("losing the decks while resolving tracks aborts dj:play", async () => {
    const pat = await connect("pat", "Pat", user("pat@example.com", "Pat"));
    const id = await goLive(pat, { trustedEmails: ["anna@example.com"] });
    const anna = await connect("anna", "Anna", user("anna@example.com", "Anna"));
    await send(anna, { type: "channel:join", channelId: id });
    await send(anna, { type: "dj:take" });

    const gate = deferred<TrackRef[]>();
    resolveTracksImpl = () => gate.promise;

    const pending = handleMessage("anna", JSON.stringify({ type: "dj:play", url: "https://soundcloud.com/a/b" }));

    // While resolveTracks is still pending, the owner takes the decks back from Anna.
    await send(pat, { type: "live:untrust", email: "anna@example.com" });

    gate.resolve([{ url: "https://soundcloud.com/a/b", title: "Should not play", artwork: null }]);
    await pending;

    expect(channels.get(id)!.trackUrl).toBeNull();
  });

  test("losing the decks while resolving the stream url aborts dj:play", async () => {
    const pat = await connect("pat", "Pat", user("pat@example.com", "Pat"));
    const id = await goLive(pat, { trustedEmails: ["anna@example.com"] });
    const anna = await connect("anna", "Anna", user("anna@example.com", "Anna"));
    await send(anna, { type: "channel:join", channelId: id });
    await send(anna, { type: "dj:take" });

    const gate = deferred<string>();
    resolveStreamUrlImpl = () => gate.promise;

    const pending = handleMessage("anna", JSON.stringify({ type: "dj:play", url: "https://soundcloud.com/a/b" }));

    // resolveTracks already resolved (fast default mock); Anna is still the active DJ at this
    // point, mid-flight on resolveStreamUrl, when the owner takes the decks back.
    await send(pat, { type: "live:untrust", email: "anna@example.com" });

    gate.resolve("https://mock.sndcdn.com/stream.mp3");
    await pending;

    expect(channels.get(id)!.trackUrl).toBeNull();
  });
});

describe("queue:add races (membership lost mid-resolve)", () => {
  test("a listener who leaves the channel while resolving tracks does not add to its queue", async () => {
    const pat = await connect("pat", "Pat", user("pat@example.com", "Pat"));
    const id = await goLive(pat);
    const anna = await connect("anna", "Anna", user("anna@example.com", "Anna"));
    await send(anna, { type: "channel:join", channelId: id });

    const gate = deferred<TrackRef[]>();
    resolveTracksImpl = () => gate.promise;

    const pending = handleMessage("anna", JSON.stringify({ type: "queue:add", url: "https://soundcloud.com/a/b" }));

    await send(anna, { type: "channel:leave" });

    gate.resolve([{ url: "https://soundcloud.com/a/b", title: "Should not queue", artwork: null }]);
    await pending;

    expect(channels.get(id)!.queue).toEqual([]);
  });
});

describe("stream:refresh races (track changes mid-resolve)", () => {
  test("a track change while refresh is pending does not clobber the new track's stream URL", async () => {
    const pat = await connect("pat", "Pat", user("pat@example.com", "Pat"));
    const id = await goLive(pat);
    const channel = channels.get(id)!;

    resolveTracksImpl = async () => [{ url: "https://soundcloud.com/first", title: "First", artwork: null }];
    resolveStreamUrlImpl = async () => "https://mock.sndcdn.com/first.mp3";
    await send(pat, { type: "dj:play", url: "https://soundcloud.com/first" });
    expect(channel.trackUrl).toBe("https://soundcloud.com/first");

    const refreshGate = deferred<string>();
    resolveStreamUrlImpl = () => refreshGate.promise;
    const pending = handleMessage("pat", JSON.stringify({ type: "stream:refresh" }));

    // While the refresh for "first" is still in flight, the DJ moves on to a new track.
    resolveTracksImpl = async () => [{ url: "https://soundcloud.com/second", title: "Second", artwork: null }];
    resolveStreamUrlImpl = async () => "https://mock.sndcdn.com/second.mp3";
    await send(pat, { type: "dj:play", url: "https://soundcloud.com/second" });
    expect(channel.trackUrl).toBe("https://soundcloud.com/second");
    expect(channel.streamUrl).toBe("https://mock.sndcdn.com/second.mp3");

    // The stale "first" refresh resolves last - it must not stomp the new track's stream URL.
    refreshGate.resolve("https://mock.sndcdn.com/stale-first.mp3");
    await pending;

    expect(channel.trackUrl).toBe("https://soundcloud.com/second");
    expect(channel.streamUrl).toBe("https://mock.sndcdn.com/second.mp3");
  });
});

describe("queue advance races (duplicate concurrent advances)", () => {
  function pushQueueItems(items: QueueItem[], channelId: string) {
    const channel = channels.get(channelId)!;
    channel.queue.push(...items);
    return channel;
  }

  test("duplicate concurrent track:ended events only advance the queue once", async () => {
    const pat = await connect("pat", "Pat", user("pat@example.com", "Pat"));
    const id = await goLive(pat);
    await handleMessage("pat", JSON.stringify({ type: "dj:play", url: "https://soundcloud.com/first" }));
    const channel = pushQueueItems(
      [
        { id: "q1", url: "https://soundcloud.com/q1", title: "Q1", artwork: null, addedBy: "DJ Pat" },
        { id: "q2", url: "https://soundcloud.com/q2", title: "Q2", artwork: null, addedBy: "DJ Pat" },
      ],
      id,
    );

    const gate = deferred<string>();
    resolveStreamUrlImpl = () => gate.promise;

    const trackUrl = channel.trackUrl;
    const p1 = handleMessage("pat", JSON.stringify({ type: "track:ended", trackUrl }));
    const p2 = handleMessage("pat", JSON.stringify({ type: "track:ended", trackUrl }));

    gate.resolve("https://mock.sndcdn.com/stream.mp3");
    await Promise.all([p1, p2]);

    expect(channel.queue.map((q) => q.id)).toEqual(["q2"]);
    expect(channel.trackUrl).toBe("https://soundcloud.com/q1");
  });

  test("duplicate concurrent queue:skip events only advance the queue once", async () => {
    const pat = await connect("pat", "Pat", user("pat@example.com", "Pat"));
    const id = await goLive(pat);
    await handleMessage("pat", JSON.stringify({ type: "dj:play", url: "https://soundcloud.com/first" }));
    const channel = pushQueueItems(
      [
        { id: "q1", url: "https://soundcloud.com/q1", title: "Q1", artwork: null, addedBy: "DJ Pat" },
        { id: "q2", url: "https://soundcloud.com/q2", title: "Q2", artwork: null, addedBy: "DJ Pat" },
      ],
      id,
    );

    const gate = deferred<string>();
    resolveStreamUrlImpl = () => gate.promise;

    const p1 = handleMessage("pat", JSON.stringify({ type: "queue:skip" }));
    const p2 = handleMessage("pat", JSON.stringify({ type: "queue:skip" }));

    gate.resolve("https://mock.sndcdn.com/stream.mp3");
    await Promise.all([p1, p2]);

    expect(channel.queue.map((q) => q.id)).toEqual(["q2"]);
    expect(channel.trackUrl).toBe("https://soundcloud.com/q1");
  });
});
