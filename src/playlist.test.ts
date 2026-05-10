import { describe, expect, test, beforeEach } from "bun:test";
import { station, claimDj, clearPlayback } from "./station";
import { handleOpen, handleMessage, playFromSlack, queueFromSlack } from "./ws";

const PLAYLIST_URL = "https://soundcloud.com/vova-papusha-196573227/sets/chillstep-mix-2025";
const SINGLE_TRACK_URL = "https://soundcloud.com/aesuramusic/beyond-reality";

// Fake WSContext that captures sent messages
function createFakeWs() {
  const sent: any[] = [];
  return {
    ws: {
      send(data: string | ArrayBuffer) {
        sent.push(JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)));
      },
      close() {},
      readyState: 1,
      raw: undefined,
    } as any,
    sent,
  };
}

function resetStation() {
  station.djId = null;
  station.djName = null;
  station.djHeartbeatAt = 0;
  station.trackUrl = null;
  station.trackTitle = null;
  station.trackArtwork = null;
  station.streamUrl = null;
  station.isPlaying = false;
  station.position = 0;
  station.positionTimestamp = Date.now();
  station.vibezBoost = 0;
  station.listeners.clear();
  station.queue = [];
}

async function setupDj(id: string, name: string) {
  const { ws, sent } = createFakeWs();
  handleOpen(ws, id);
  await handleMessage(id, JSON.stringify({ type: "join", name }));
  claimDj(id, name);
  sent.length = 0; // clear setup messages
  return { ws, sent };
}

async function setupListener(id: string, name: string) {
  const { ws, sent } = createFakeWs();
  handleOpen(ws, id);
  await handleMessage(id, JSON.stringify({ type: "join", name }));
  sent.length = 0;
  return { ws, sent };
}

describe("playlist support — dj:play", () => {
  beforeEach(resetStation);

  test("playlist URL plays first track and queues the rest", async () => {
    const djId = "dj-1";
    await setupDj(djId, "TestDJ");

    await handleMessage(djId, JSON.stringify({ type: "dj:play", url: PLAYLIST_URL }));

    // First track should be playing
    expect(station.trackUrl).not.toBeNull();
    expect(station.trackTitle).not.toBeNull();
    expect(station.isPlaying).toBe(true);
    expect(station.streamUrl).not.toBeNull();
    expect(station.streamUrl).toContain("sndcdn.com");

    // Remaining tracks should be in the queue
    expect(station.queue.length).toBeGreaterThanOrEqual(1);

    // The playing track should NOT be in the queue
    const playingUrl = station.trackUrl;
    const queueUrls = station.queue.map((q) => q.url);
    expect(queueUrls).not.toContain(playingUrl);

    // Every queue item should have required fields
    for (const item of station.queue) {
      expect(item.id).toBeTruthy();
      expect(item.url).toMatch(/^https:\/\/soundcloud\.com\//);
      expect(item.addedBy).toBe("TestDJ");
      expect(item.title).not.toBeNull();
    }

    // Total tracks = playing + queued should match playlist size
    const totalTracks = 1 + station.queue.length;
    expect(totalTracks).toBeGreaterThanOrEqual(2);
    console.log(`  dj:play → playing "${station.trackTitle}", ${station.queue.length} tracks queued (${totalTracks} total)`);
  });

  test("single track URL plays normally with no queue additions", async () => {
    const djId = "dj-2";
    await setupDj(djId, "SoloDJ");

    await handleMessage(djId, JSON.stringify({ type: "dj:play", url: SINGLE_TRACK_URL }));

    expect(station.trackUrl).toBe(SINGLE_TRACK_URL);
    expect(station.isPlaying).toBe(true);
    expect(station.streamUrl).not.toBeNull();
    expect(station.queue.length).toBe(0);
    console.log(`  dj:play single → playing "${station.trackTitle}", queue empty`);
  });

  test("playlist dj:play appends to existing queue (does not replace)", async () => {
    const djId = "dj-3";
    await setupDj(djId, "QueueDJ");

    // Pre-populate the queue with an existing item
    station.queue.push({
      id: "existing-1",
      url: "https://soundcloud.com/fake/existing-track",
      title: "Pre-existing Track",
      artwork: null,
      addedBy: "Someone",
    });

    await handleMessage(djId, JSON.stringify({ type: "dj:play", url: PLAYLIST_URL }));

    // The pre-existing item should still be in the queue
    const existingItem = station.queue.find((q) => q.id === "existing-1");
    expect(existingItem).toBeDefined();
    expect(existingItem!.title).toBe("Pre-existing Track");

    // New playlist tracks should also be in the queue
    const newItems = station.queue.filter((q) => q.id !== "existing-1");
    expect(newItems.length).toBeGreaterThanOrEqual(1);

    console.log(`  dj:play with existing queue → ${station.queue.length} total items (1 pre-existing + ${newItems.length} from playlist)`);
  });
});

describe("playlist support — queue:add", () => {
  beforeEach(resetStation);

  test("playlist URL adds all tracks to the queue", async () => {
    const userId = "user-1";
    await setupListener(userId, "Listener1");

    await handleMessage(userId, JSON.stringify({ type: "queue:add", url: PLAYLIST_URL }));

    expect(station.queue.length).toBeGreaterThanOrEqual(2);

    for (const item of station.queue) {
      expect(item.id).toBeTruthy();
      expect(item.url).toMatch(/^https:\/\/soundcloud\.com\//);
      expect(item.addedBy).toBe("Listener1");
      expect(item.title).not.toBeNull();
    }

    // No track should be playing (queue:add doesn't auto-play)
    expect(station.trackUrl).toBeNull();
    expect(station.isPlaying).toBe(false);

    console.log(`  queue:add playlist → ${station.queue.length} tracks queued:`);
    station.queue.forEach((q, i) => console.log(`    ${i + 1}. "${q.title}"`));
  });

  test("single track URL adds exactly one item to the queue", async () => {
    const userId = "user-2";
    await setupListener(userId, "Listener2");

    await handleMessage(userId, JSON.stringify({ type: "queue:add", url: SINGLE_TRACK_URL }));

    expect(station.queue.length).toBe(1);
    expect(station.queue[0].url).toBe(SINGLE_TRACK_URL);
    expect(station.queue[0].addedBy).toBe("Listener2");
    expect(station.queue[0].title).not.toBeNull();
    console.log(`  queue:add single → 1 track: "${station.queue[0].title}"`);
  });

  test("playlist queue:add appends to existing queue", async () => {
    const userId = "user-3";
    await setupListener(userId, "Listener3");

    station.queue.push({
      id: "pre-1",
      url: "https://soundcloud.com/fake/pre-track",
      title: "Already Queued",
      artwork: null,
      addedBy: "OldUser",
    });

    await handleMessage(userId, JSON.stringify({ type: "queue:add", url: PLAYLIST_URL }));

    expect(station.queue[0].id).toBe("pre-1");
    expect(station.queue[0].title).toBe("Already Queued");

    const newItems = station.queue.slice(1);
    expect(newItems.length).toBeGreaterThanOrEqual(2);
    for (const item of newItems) {
      expect(item.addedBy).toBe("Listener3");
    }

    console.log(`  queue:add with existing → ${station.queue.length} total (1 pre-existing + ${newItems.length} from playlist)`);
  });
});

describe("playlist support — playFromSlack", () => {
  beforeEach(resetStation);

  test("plays first track, queues rest, returns count", async () => {
    const result = await playFromSlack(PLAYLIST_URL, "SlackUser");

    expect(result.title).not.toBeNull();
    expect(result.count).toBeGreaterThanOrEqual(2);

    expect(station.trackUrl).not.toBeNull();
    expect(station.isPlaying).toBe(true);
    expect(station.streamUrl).toContain("sndcdn.com");

    expect(station.queue.length).toBe(result.count - 1);
    for (const item of station.queue) {
      expect(item.addedBy).toBe("SlackUser");
    }

    console.log(`  playFromSlack → playing "${result.title}", ${station.queue.length} queued, count=${result.count}`);
  });
});

describe("playlist support — queueFromSlack", () => {
  beforeEach(resetStation);

  test("queues all tracks and returns count", async () => {
    const result = await queueFromSlack(PLAYLIST_URL, "SlackQueuer");

    expect(result.title).not.toBeNull();
    expect(result.count).toBeGreaterThanOrEqual(2);
    expect(result.position).toBe(result.count);

    expect(station.queue.length).toBe(result.count);
    for (const item of station.queue) {
      expect(item.addedBy).toBe("SlackQueuer");
      expect(item.url).toMatch(/^https:\/\/soundcloud\.com\//);
    }

    // Nothing should be playing
    expect(station.trackUrl).toBeNull();
    expect(station.isPlaying).toBe(false);

    console.log(`  queueFromSlack → ${station.queue.length} tracks queued, count=${result.count}`);
  });
});

describe("playlist support — broadcast verification", () => {
  beforeEach(resetStation);

  test("dj:play with playlist broadcasts track, play, and queue messages", async () => {
    const djId = "dj-bc";
    const { sent: djSent } = await setupDj(djId, "BroadcastDJ");
    const { sent: listenerSent } = await setupListener("listener-bc", "Watcher");

    await handleMessage(djId, JSON.stringify({ type: "dj:play", url: PLAYLIST_URL }));

    // Listener should have received track + play + queue broadcasts
    const trackMsg = listenerSent.find((m: any) => m.type === "track");
    expect(trackMsg).toBeDefined();
    expect(trackMsg.url).not.toBeNull();
    expect(trackMsg.streamUrl).not.toBeNull();

    const playMsg = listenerSent.find((m: any) => m.type === "play");
    expect(playMsg).toBeDefined();
    expect(playMsg.position).toBe(0);

    const queueMsg = listenerSent.find((m: any) => m.type === "queue");
    expect(queueMsg).toBeDefined();
    expect(queueMsg.items.length).toBeGreaterThanOrEqual(1);

    console.log(`  broadcasts → track ✓, play ✓, queue (${queueMsg.items.length} items) ✓`);
  });

  test("queue:add with playlist broadcasts queue message with all tracks", async () => {
    const userId = "user-bc";
    await setupListener(userId, "QueueWatcher");
    const { sent: otherSent } = await setupListener("other-bc", "Other");

    await handleMessage(userId, JSON.stringify({ type: "queue:add", url: PLAYLIST_URL }));

    const queueMsg = otherSent.find((m: any) => m.type === "queue");
    expect(queueMsg).toBeDefined();
    expect(queueMsg.items.length).toBeGreaterThanOrEqual(2);

    for (const item of queueMsg.items) {
      expect(item.url).toMatch(/^https:\/\/soundcloud\.com\//);
      expect(item.title).not.toBeNull();
      expect(item.addedBy).toBe("QueueWatcher");
    }

    console.log(`  queue:add broadcast → ${queueMsg.items.length} items sent to listeners ✓`);
  });
});
