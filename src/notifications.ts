type SlackPayload = {
  text: string;
  blocks?: Array<Record<string, unknown>>;
};

type TimerHandle = ReturnType<typeof setTimeout> | number;

type NotificationServiceOptions = {
  webhookUrl?: string;
  radioUrl?: string;
  joinWindowMs?: number;
  dedupeWindowMs?: number;
  now?: () => number;
  postJson?: (url: string, payload: SlackPayload) => Promise<void>;
  setTimer?: (callback: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  logger?: Pick<Console, "log" | "warn">;
};

type NotificationService = {
  notifyListenerJoined(name: string): void;
  notifyDjStarted(name: string): Promise<void>;
  flushJoinedListeners(): Promise<void>;
};

const DEFAULT_JOIN_WINDOW_MS = 60_000;
const DEFAULT_DEDUPE_WINDOW_MS = 10 * 60_000;
const DEFAULT_RADIO_URL = "http://localhost:3000";

export function formatJoinedNames(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} joined Vibez`;
  if (names.length === 2) return `${names[0]} and ${names[1]} joined Vibez`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]} joined Vibez`;
}

function trimName(name: string): string {
  return name.trim() || "Someone";
}

function notificationKey(type: "listener" | "dj", name: string): string {
  return `${type}:${trimName(name).toLowerCase()}`;
}

function slackMessage(text: string, radioUrl: string): SlackPayload {
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
            url: "vibez://open",
            action_id: "open_vibez_app",
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Open Web" },
            url: radioUrl,
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
  const joinWindowMs = options.joinWindowMs ?? DEFAULT_JOIN_WINDOW_MS;
  const dedupeWindowMs = options.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
  const now = options.now ?? Date.now;
  const postJson = options.postJson ?? defaultPostJson;
  const schedule = options.setTimer ?? setTimeout;
  const cancel = options.clearTimer ?? clearTimeout;
  const logger = options.logger ?? console;

  let loggedDisabled = false;
  let joinTimer: TimerHandle | null = null;
  let pendingJoinNames = new Map<string, string>();
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

  async function flushJoinedListeners(): Promise<void> {
    if (joinTimer !== null) {
      cancel(joinTimer);
      joinTimer = null;
    }

    const pending = Array.from(pendingJoinNames.entries());
    pendingJoinNames = new Map();
    if (pending.length === 0) return;

    const names = pending.map(([, name]) => name);
    const text = `:radio: ${formatJoinedNames(names)}`;
    if (await send(slackMessage(text, radioUrl))) {
      for (const [key] of pending) markSent(key);
    }
  }

  return {
    notifyListenerJoined(name: string) {
      if (!enabled()) return;
      const displayName = trimName(name);
      const key = notificationKey("listener", displayName);
      if (wasRecentlySent(key)) return;

      if (!pendingJoinNames.has(key)) {
        pendingJoinNames.set(key, displayName);
      }
      if (joinTimer === null) {
        joinTimer = schedule(() => {
          void flushJoinedListeners();
        }, joinWindowMs);
      }
    },

    async notifyDjStarted(name: string) {
      const displayName = trimName(name);
      const key = notificationKey("dj", displayName);
      if (wasRecentlySent(key)) return;

      const text = `:headphones: ${displayName} is DJing on Vibez`;
      if (await send(slackMessage(text, radioUrl))) {
        markSent(key);
      }
    },

    flushJoinedListeners,
  };
}

export const notifications = createNotificationService();
