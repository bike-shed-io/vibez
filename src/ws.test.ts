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

const originalNotifyListenerJoined = notifications.notifyListenerJoined;

async function joinListener(id: string, name: string) {
  const { ws, sent } = createFakeWs();
  handleOpen(ws, id);
  await handleMessage(id, JSON.stringify({ type: "join", name }));
  handleClose(id);
  return sent;
}

describe("websocket join notifications", () => {
  beforeEach(() => {
    resetStation();
    notifications.notifyListenerJoined = originalNotifyListenerJoined;
  });

  afterEach(() => {
    notifications.notifyListenerJoined = originalNotifyListenerJoined;
    resetStation();
  });

  test("does not notify Slack when a listener joins without active playback", async () => {
    const notified: string[] = [];
    notifications.notifyListenerJoined = (name) => notified.push(name);

    const sent = await joinListener("listener-no-playback", "Patrick");

    expect(notified).toEqual([]);
    expect(sent.find((msg: any) => msg.type === "sync")).toBeDefined();
  });

  test("notifies Slack when a listener joins while music is playing", async () => {
    const notified: string[] = [];
    notifications.notifyListenerJoined = (name) => notified.push(name);
    station.trackUrl = "https://soundcloud.com/example/track";
    station.isPlaying = true;

    await joinListener("listener-playing", "Lisa");

    expect(notified).toEqual(["Lisa"]);
  });
});
