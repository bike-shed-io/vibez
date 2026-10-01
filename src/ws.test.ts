import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { notifications } from "./notifications";
import { station } from "./station";
import { handleClose, handleMessage, handleOpen } from "./ws";

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
