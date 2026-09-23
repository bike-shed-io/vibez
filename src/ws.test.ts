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

describe("websocket Slack notifications", () => {
  let notified: string[];

  beforeEach(() => {
    resetStation();
    notified = [];
    notifications.notifyDjStarted = async (name) => {
      notified.push(name);
    };
  });

  afterEach(() => {
    notifications.notifyDjStarted = originalNotifyDjStarted;
    resetStation();
  });

  test("does not notify Slack when a listener joins while music is playing", async () => {
    station.trackUrl = "https://soundcloud.com/example/track";
    station.isPlaying = true;
    const { ws, sent } = createFakeWs();
    handleOpen(ws, "listener-playing");

    await handleMessage("listener-playing", JSON.stringify({ type: "join", name: "Lisa" }));
    handleClose("listener-playing");

    expect(notified).toEqual([]);
    expect(sent.find((msg: any) => msg.type === "sync")).toBeDefined();
  });

  test("notifies Slack once when someone starts DJing", async () => {
    const { ws } = createFakeWs();
    handleOpen(ws, "dj");

    await handleMessage("dj", JSON.stringify({ type: "join", name: "Patrick" }));
    await handleMessage("dj", JSON.stringify({ type: "dj:claim" }));
    handleClose("dj");

    expect(notified).toEqual(["Patrick"]);
  });
});
