import { describe, expect, test } from "bun:test";
import type { DirectoryEntry } from "./channels";
import { createDiscordFeed } from "./discord";

const HOOK = "https://discord.com/api/webhooks/1/token";

function room(overrides: Partial<DirectoryEntry> = {}): DirectoryEntry {
  return {
    id: "abc",
    ownerName: "Patrick",
    ownerPicture: null,
    roomName: "hypetrain",
    activeDjName: "powerPAT",
    djAway: false,
    trackTitle: "Ed Solo - Minirig",
    trackUrl: "https://soundcloud.com/edsolo/minirig",
    trackArtwork: "https://i1.sndcdn.com/art.jpg",
    isPlaying: true,
    listenerCount: 3,
    ...overrides,
  };
}

function fakeDiscord() {
  const calls: Array<{ method: string; url: string; body: any }> = [];
  let nextId = 1;
  const fetchFn = async (url: string, init: RequestInit) => {
    calls.push({ method: init.method!, url, body: JSON.parse(String(init.body)) });
    return Response.json({ id: String(nextId++) });
  };
  return { calls, feed: createDiscordFeed({ webhookUrl: HOOK, radioUrl: "https://vibez.bike-shed.io", fetchFn }) };
}

describe("discord feed", () => {
  test("does nothing without a webhook", async () => {
    let called = false;
    const feed = createDiscordFeed({ webhookUrl: "", fetchFn: async () => ((called = true), Response.json({})) });
    await feed.sync([room()]);
    expect(called).toBe(false);
  });

  test("posts one message when a room goes live", async () => {
    const { calls, feed } = fakeDiscord();
    await feed.sync([room()]);
    await feed.sync([room({ listenerCount: 9 })]); // nothing visible changed

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(`${HOOK}?wait=true`);
    const embed = calls[0].body.embeds[0];
    expect(embed.title).toBe("🎧 powerPAT is live: hypetrain");
    expect(embed.url).toBe("https://vibez.bike-shed.io/c/abc");
    expect(embed.description).toBe("Now playing: [Ed Solo - Minirig](https://soundcloud.com/edsolo/minirig)");
    expect(embed.thumbnail).toEqual({ url: "https://i1.sndcdn.com/art.jpg" });
    expect(calls[0].body.allowed_mentions).toEqual({ parse: [] });
  });

  test("edits the same message when the track changes", async () => {
    const { calls, feed } = fakeDiscord();
    await feed.sync([room()]);
    await feed.sync([room({ trackTitle: "Next [VIP]", trackUrl: "https://soundcloud.com/x/next" })]);

    expect(calls).toHaveLength(2);
    expect(calls[1].method).toBe("PATCH");
    expect(calls[1].url).toBe(`${HOOK}/messages/1`);
    expect(calls[1].body.embeds[0].description).toBe("Now playing: [Next \\[VIP\\]](https://soundcloud.com/x/next)");
  });

  test("an edit waits for the post it edits", async () => {
    const { calls, feed } = fakeDiscord();
    const first = feed.sync([room()]);
    const second = feed.sync([room({ trackTitle: "Second" })]);
    await Promise.all([first, second]);

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`POST ${HOOK}?wait=true`, `PATCH ${HOOK}/messages/1`]);
  });

  test("marks the message ended when the room is gone, and sync([]) closes every room", async () => {
    const { calls, feed } = fakeDiscord();
    await feed.sync([room(), room({ id: "def", roomName: null })]);
    await feed.sync([room({ id: "def", roomName: null })]);

    expect(calls[2]).toMatchObject({ method: "PATCH", url: `${HOOK}/messages/1` });
    expect(calls[2].body.embeds[0].title).toBe("⏹ hypetrain has ended");
    expect(calls[2].body.embeds[0].url).toBeUndefined();

    await feed.sync([]);
    expect(calls[3]).toMatchObject({ method: "PATCH", url: `${HOOK}/messages/2` });
    expect(calls[3].body.embeds[0].title).toBe("⏹ Patrick's vibes has ended");
    await feed.sync([]);
    expect(calls).toHaveLength(4);
  });

  test("a failing Discord never throws into the room", async () => {
    const feed = createDiscordFeed({
      webhookUrl: HOOK,
      fetchFn: async () => new Response("rate limited", { status: 429 }),
      logger: { warn: () => {} },
    });
    await feed.sync([room()]);
    await feed.sync([room({ trackTitle: "Other" })]);
    await feed.sync([]);
  });

  test("message ids survive a restart", async () => {
    const before = fakeDiscord();
    await before.feed.sync([room()]);
    const saved = JSON.parse(JSON.stringify(await before.feed.save()));

    const after = fakeDiscord();
    after.feed.load(saved);
    await after.feed.sync([room()]); // same room, nothing changed
    await after.feed.sync([room({ trackTitle: "After deploy" })]);

    expect(after.calls).toHaveLength(1);
    expect(after.calls[0]).toMatchObject({ method: "PATCH", url: `${HOOK}/messages/1` });
  });
});
