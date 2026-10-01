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

    await service.notifyWentLive({ ownerEmail: "pat@example.com", ownerName: "Patrick", roomName: null, channelId: null });

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

    await service.notifyWentLive({ ownerEmail: "pat@example.com", ownerName: "Patrick", roomName: null, channelId: null });

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe(":headphones: Patrick went live on Vibez");
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

    await service.notifyWentLive({ ownerEmail: "pat@example.com", ownerName: "Patrick", roomName: null, channelId: null });
    await service.notifyWentLive({ ownerEmail: "PAT@example.com ", ownerName: "patrick ", roomName: null, channelId: null });
    currentTime += 999;
    await service.notifyWentLive({ ownerEmail: "pat@example.com", ownerName: "Patrick", roomName: null, channelId: null });
    currentTime += 1;
    await service.notifyWentLive({ ownerEmail: "pat@example.com", ownerName: "Patrick", roomName: null, channelId: null });

    expect(sent.map((payload) => payload.text)).toEqual([
      ":headphones: Patrick went live on Vibez",
      ":headphones: Patrick went live on Vibez",
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

    await service.notifyWentLive({ ownerEmail: "pat@example.com", ownerName: "Patrick", roomName: null, channelId: null });

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

  test("went-live message names the room and links to the channel", async () => {
    const sent: any[] = [];
    const service = createNotificationService({
      webhookUrl: "https://hooks.slack.com/services/test",
      radioUrl: "https://vibez.bike-shed.io",
      postJson: async (_url, payload) => {
        sent.push(payload);
      },
    });

    await service.notifyWentLive({ ownerEmail: "pat@example.com", ownerName: "Pat", roomName: "friday <!channel>", channelId: "abc123" });

    expect(sent[0].text).toBe(":headphones: Pat went live: *friday &lt;!channel&gt;*");
    const actions = sent[0].blocks.find((block: any) => block.type === "actions");
    expect(actions.elements.map((element: any) => element.url)).toEqual([
      "vibez://channel/abc123",
      "https://vibez.bike-shed.io/c/abc123",
    ]);
  });
});
