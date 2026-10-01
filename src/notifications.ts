type SlackPayload = {
  text: string;
  blocks?: Array<Record<string, unknown>>;
};

type NotificationServiceOptions = {
  webhookUrl?: string;
  radioUrl?: string;
  dedupeWindowMs?: number;
  now?: () => number;
  postJson?: (url: string, payload: SlackPayload) => Promise<void>;
  logger?: Pick<Console, "log" | "warn">;
};

type NotificationService = {
  notifyWentLive(input: { ownerEmail: string; ownerName: string; roomName: string | null; channelId: string | null }): Promise<void>;
};

const DEFAULT_DEDUPE_WINDOW_MS = 10 * 60_000;
const DEFAULT_RADIO_URL = "http://localhost:3000";

function trimName(name: string): string {
  return name.trim() || "Someone";
}

function notificationKey(name: string): string {
  return `dj:${trimName(name).toLowerCase()}`;
}

export function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function listenUrls(radioUrl: string, channelId: string | null) {
  return channelId
    ? { app: `vibez://channel/${channelId}`, web: `${radioUrl}/c/${channelId}` }
    : { app: "vibez://open", web: radioUrl };
}

function slackMessage(text: string, radioUrl: string, channelId: string | null): SlackPayload {
  const urls = listenUrls(radioUrl, channelId);
  return {
    text,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Open Vibez App" },
            url: urls.app,
            action_id: "open_vibez_app",
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Open Web" },
            url: urls.web,
            action_id: "open_vibez_web",
          },
        ],
      },
    ],
  };
}

async function defaultPostJson(url: string, payload: SlackPayload): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Slack webhook failed with status ${response.status}`);
  }
}

export function createNotificationService(options: NotificationServiceOptions = {}): NotificationService {
  const webhookUrl = options.webhookUrl ?? process.env.SLACK_NOTIFICATIONS_WEBHOOK_URL ?? "";
  const radioUrl = options.radioUrl ?? process.env.RADIO_URL ?? DEFAULT_RADIO_URL;
  const dedupeWindowMs = options.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
  const now = options.now ?? Date.now;
  const postJson = options.postJson ?? defaultPostJson;
  const logger = options.logger ?? console;

  let loggedDisabled = false;
  const recentNotifications = new Map<string, number>();

  function enabled(): boolean {
    if (webhookUrl) return true;
    if (!loggedDisabled) {
      logger.log("[notifications] SLACK_NOTIFICATIONS_WEBHOOK_URL not set — Slack notifications disabled");
      loggedDisabled = true;
    }
    return false;
  }

  function wasRecentlySent(key: string): boolean {
    if (dedupeWindowMs <= 0) return false;

    const sentAt = recentNotifications.get(key);
    if (sentAt === undefined) return false;

    if (now() - sentAt >= dedupeWindowMs) {
      recentNotifications.delete(key);
      return false;
    }

    return true;
  }

  function markSent(key: string) {
    if (dedupeWindowMs > 0) {
      recentNotifications.set(key, now());
    }
  }

  async function send(payload: SlackPayload): Promise<boolean> {
    if (!enabled()) return false;
    try {
      await postJson(webhookUrl, payload);
      return true;
    } catch (err) {
      logger.warn("[notifications] Slack webhook notification failed", err);
      return false;
    }
  }

  return {
    async notifyWentLive({ ownerEmail, ownerName, roomName, channelId }) {
      const key = notificationKey(ownerEmail);
      if (wasRecentlySent(key)) return;

      const trimmedOwnerName = trimName(ownerName);
      const who = escapeSlack(trimmedOwnerName);
      const text = `:headphones: ${who} went live: *${escapeSlack(roomName ?? `${trimmedOwnerName}'s vibes`)}*`;
      if (await send(slackMessage(text, radioUrl, channelId))) {
        markSent(key);
      }
    },
  };
}

export const notifications = createNotificationService();
