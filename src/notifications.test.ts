import { describe, expect, test } from "bun:test";
import { createNotificationService, formatJoinedNames } from "./notifications";

describe("formatJoinedNames", () => {
  test("formats one listener", () => {
    expect(formatJoinedNames(["Patrick"])).toBe("Patrick joined Vibez");
  });

  test("formats two listeners", () => {
    expect(formatJoinedNames(["Patrick", "Lisa"])).toBe("Patrick and Lisa joined Vibez");
  });

  test("formats three listeners", () => {
    expect(formatJoinedNames(["Patrick", "Lisa", "Max"])).toBe("Patrick, Lisa, and Max joined Vibez");
  });
});

describe("notification service", () => {
  test("does nothing when Slack webhook is not configured", async () => {
    const sent: unknown[] = [];
    const service = createNotificationService({
      webhookUrl: "",
      radioUrl: "https://vibez.bike-shed.io",
      joinWindowMs: 1,
      postJson: async (_url, payload) => {
        sent.push(payload);
      },
    });

    service.notifyListenerJoined("Patrick");
    await service.flushJoinedListeners();
    await service.notifyDjStarted("Patrick");

    expect(sent).toEqual([]);
  });

  test("batches listener joins and dedupes names", async () => {
    const sent: Array<{ url: string; payload: any }> = [];
    let scheduled: (() => void | Promise<void>) | null = null;

    const service = createNotificationService({
      webhookUrl: "https://hooks.slack.com/services/test",
      radioUrl: "https://vibez.bike-shed.io",
      joinWindowMs: 60_000,
      postJson: async (url, payload) => {
        sent.push({ url, payload });
      },
      setTimer: (callback) => {
        scheduled = callback;
        return 1;
      },
      clearTimer: () => {},
    });

    service.notifyListenerJoined("Patrick");
    service.notifyListenerJoined("Lisa");
    service.notifyListenerJoined("Patrick");

    expect(sent).toHaveLength(0);
    expect(scheduled).toBeInstanceOf(Function);

    await scheduled!();

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://hooks.slack.com/services/test");
    expect(sent[0].payload.text).toBe(":radio: Patrick and Lisa joined Vibez");
  });

  test("sends DJ start notifications immediately", async () => {
    const sent: any[] = [];
    const service = createNotificationService({
      webhookUrl: "https://hooks.slack.com/services/test",
      radioUrl: "https://vibez.bike-shed.io",
      postJson: async (_url, payload) => {
        sent.push(payload);
      },
    });

    await service.notifyDjStarted("Patrick");

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe(":headphones: Patrick is DJing on Vibez");
  });

  test("join batch can be flushed repeatedly", async () => {
    const sent: any[] = [];
    const service = createNotificationService({
      webhookUrl: "https://hooks.slack.com/services/test",
      radioUrl: "https://vibez.bike-shed.io",
      postJson: async (_url, payload) => {
        sent.push(payload);
      },
    });

    service.notifyListenerJoined("Patrick");
    await service.flushJoinedListeners();
    service.notifyListenerJoined("Lisa");
    await service.flushJoinedListeners();

    expect(sent.map((payload) => payload.text)).toEqual([
      ":radio: Patrick joined Vibez",
      ":radio: Lisa joined Vibez",
    ]);
  });
});
