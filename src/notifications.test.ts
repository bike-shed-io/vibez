import { describe, expect, test } from "bun:test";
import { createNotificationService } from "./notifications";

describe("notification service", () => {
  test("does nothing when Slack webhook is not configured", async () => {
    const sent: unknown[] = [];
    const service = createNotificationService({
      webhookUrl: "",
      radioUrl: "https://vibez.bike-shed.io",
      postJson: async (_url, payload) => {
        sent.push(payload);
      },
    });

    await service.notifyDjStarted("Patrick");

    expect(sent).toEqual([]);
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

  test("dedupes repeated DJ start notifications within the dedupe window", async () => {
    const sent: any[] = [];
    let currentTime = 1_000;
    const service = createNotificationService({
      webhookUrl: "https://hooks.slack.com/services/test",
      radioUrl: "https://vibez.bike-shed.io",
      dedupeWindowMs: 1_000,
      now: () => currentTime,
      postJson: async (_url, payload) => {
        sent.push(payload);
      },
    });

    await service.notifyDjStarted("Patrick");
    await service.notifyDjStarted("patrick ");
    currentTime += 999;
    await service.notifyDjStarted("Patrick");
    currentTime += 1;
    await service.notifyDjStarted("Patrick");

    expect(sent.map((payload) => payload.text)).toEqual([
      ":headphones: Patrick is DJing on Vibez",
      ":headphones: Patrick is DJing on Vibez",
    ]);
  });

  test("Slack notification payload includes native app and web buttons", async () => {
    const sent: any[] = [];
    const service = createNotificationService({
      webhookUrl: "https://hooks.slack.com/services/test",
      radioUrl: "https://vibez.bike-shed.io",
      postJson: async (_url, payload) => {
        sent.push(payload);
      },
    });

    await service.notifyDjStarted("Patrick");

    const actions = sent[0].blocks.find((block: any) => block.type === "actions");
    expect(actions.elements.map((element: any) => element.text.text)).toEqual([
      "Open Vibez App",
      "Open Web",
    ]);
    expect(actions.elements.map((element: any) => element.url)).toEqual([
      "vibez://open",
      "https://vibez.bike-shed.io",
    ]);
  });
});
