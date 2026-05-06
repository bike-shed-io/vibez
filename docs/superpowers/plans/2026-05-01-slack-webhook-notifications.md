# Slack Webhook Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send Slack webhook notifications when listeners join Vibez and when a WebSocket DJ claim succeeds.

**Architecture:** Add a small `src/notifications.ts` module with a testable notification service, join batching, and Slack webhook formatting. Keep `src/ws.ts` responsible for station events and call semantic notification functions only after successful joins/DJ claims.

**Tech Stack:** Bun, TypeScript, Bun test runner, Slack Incoming Webhooks, 1Password `op inject` env templates.

---

## File Structure

- Create `src/notifications.ts`: provider-neutral notification API with Slack webhook sender, 60-second join batching, DJ start notification, formatting helpers, and safe no-op behavior when unconfigured.
- Create `src/notifications.test.ts`: Bun tests for formatting, no-op behavior, join batching/dedupe, and immediate DJ notification.
- Modify `src/ws.ts`: call `notifyListenerJoined(name)` after successful join and `notifyDjStarted(name)` after successful WebSocket DJ claim.
- Modify `env/prod.env.tpl`, `env/prod.env.example`, `.env.example`: add `SLACK_NOTIFICATIONS_WEBHOOK_URL` using the documented 1Password field reference for production.
- Modify docs only if implementation differs from existing spec.

---

### Task 1: Notification Service And Tests

**Files:**
- Create: `src/notifications.ts`
- Create: `src/notifications.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/notifications.test.ts`:

```ts
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
    let scheduled: (() => void) | null = null;

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
});
```

- [ ] **Step 2: Verify tests fail**

Run:

```bash
bun test src/notifications.test.ts
```

Expected: FAIL because `src/notifications.ts` does not exist or exports are missing.

- [ ] **Step 3: Implement notification service**

Create `src/notifications.ts`:

```ts
type SlackPayload = {
  text: string;
  blocks?: Array<Record<string, unknown>>;
};

type TimerHandle = ReturnType<typeof setTimeout> | number;

type NotificationServiceOptions = {
  webhookUrl?: string;
  radioUrl?: string;
  joinWindowMs?: number;
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
            text: { type: "plain_text", text: "Open Vibez" },
            url: radioUrl,
            action_id: "open_vibez",
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
  const postJson = options.postJson ?? defaultPostJson;
  const schedule = options.setTimer ?? setTimeout;
  const cancel = options.clearTimer ?? clearTimeout;
  const logger = options.logger ?? console;

  let loggedDisabled = false;
  let joinTimer: TimerHandle | null = null;
  let pendingJoinNames = new Set<string>();

  function enabled(): boolean {
    if (webhookUrl) return true;
    if (!loggedDisabled) {
      logger.log("[notifications] SLACK_NOTIFICATIONS_WEBHOOK_URL not set — Slack notifications disabled");
      loggedDisabled = true;
    }
    return false;
  }

  async function send(payload: SlackPayload): Promise<void> {
    if (!enabled()) return;
    try {
      await postJson(webhookUrl, payload);
    } catch (err) {
      logger.warn("[notifications] Slack webhook notification failed", err);
    }
  }

  async function flushJoinedListeners(): Promise<void> {
    if (joinTimer !== null) {
      cancel(joinTimer);
      joinTimer = null;
    }

    const names = Array.from(pendingJoinNames);
    pendingJoinNames = new Set();
    if (names.length === 0) return;

    const text = `:radio: ${formatJoinedNames(names)}`;
    await send(slackMessage(text, radioUrl));
  }

  return {
    notifyListenerJoined(name: string) {
      if (!enabled()) return;
      pendingJoinNames.add(trimName(name));
      if (joinTimer === null) {
        joinTimer = schedule(() => {
          void flushJoinedListeners();
        }, joinWindowMs);
      }
    },

    async notifyDjStarted(name: string) {
      const text = `:headphones: ${trimName(name)} is DJing on Vibez`;
      await send(slackMessage(text, radioUrl));
    },

    flushJoinedListeners,
  };
}

export const notifications = createNotificationService();
```

- [ ] **Step 4: Verify tests pass**

Run:

```bash
bun test src/notifications.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/notifications.ts src/notifications.test.ts
git commit -m "feat: add Slack webhook notification service"
```

---

### Task 2: Wire Notifications Into WebSocket Events

**Files:**
- Modify: `src/ws.ts`

- [ ] **Step 1: Write failing integration-ish test**

Append to `src/notifications.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify current service still passes**

Run:

```bash
bun test src/notifications.test.ts
```

Expected: PASS. This preserves batching behavior before wiring.

- [ ] **Step 3: Wire `ws.ts` to semantic notification functions**

Modify imports at the top of `src/ws.ts`:

```ts
import { notifications } from "./notifications";
```

In `case "join"`, after `station.listeners.set(...)` and before/after `broadcastListeners()`, add:

```ts
notifications.notifyListenerJoined(name);
```

In `case "dj:claim"`, after `claimDj(id, name);` and before `broadcast(...)`, add:

```ts
void notifications.notifyDjStarted(name);
```

- [ ] **Step 4: Verify**

Run:

```bash
bun test src/notifications.test.ts
bunx tsc --noEmit
```

Expected: tests pass and TypeScript passes.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/ws.ts src/notifications.test.ts
git commit -m "feat: notify Slack on joins and DJ starts"
```

---

### Task 3: Add Production Env Wiring And Docs

**Files:**
- Modify: `env/prod.env.tpl`
- Modify: `env/prod.env.example`
- Modify: `.env.example`
- Modify: `docs/slack-notifications.md` if needed

- [ ] **Step 1: Add env var to templates**

Do not add the company Slack webhook reference directly to `env/prod.env.tpl`, because `op inject` resolves the existing `infra` references from a different 1Password account. Instead, keep the template focused on the existing account and have `scripts/deploy.sh` append `SLACK_NOTIFICATIONS_WEBHOOK_URL` after `op inject`.

Add to `scripts/deploy.sh` after `op inject`:

```bash
SLACK_NOTIFICATIONS_OP_ACCOUNT="${SLACK_NOTIFICATIONS_OP_ACCOUNT:-enamco.1password.com}"
SLACK_NOTIFICATIONS_OP_REF="op://Eng Admin/gz3fstsnolbqgvmqgfe6w72lau/naivtgjlnve3fxooq5dzstknvm"
SLACK_NOTIFICATIONS_WEBHOOK_URL="$(OP_ACCOUNT="$SLACK_NOTIFICATIONS_OP_ACCOUNT" op read "$SLACK_NOTIFICATIONS_OP_REF")"
printf '\nSLACK_NOTIFICATIONS_WEBHOOK_URL=%s\n' "$SLACK_NOTIFICATIONS_WEBHOOK_URL" >> env/prod.env
```

Add to `env/prod.env.example`:

```text
SLACK_NOTIFICATIONS_WEBHOOK_URL=  # op://Eng Admin/gz3fstsnolbqgvmqgfe6w72lau/naivtgjlnve3fxooq5dzstknvm
```

Add to `.env.example`:

```text
# Optional: Slack Incoming Webhook URL for join/DJ notifications
SLACK_NOTIFICATIONS_WEBHOOK_URL=
```

- [ ] **Step 2: Verify 1Password inject does not expose secret in git**

Run:

```bash
op inject -i env/prod.env.tpl -o /tmp/vibez-prod-env-check -f
test -s /tmp/vibez-prod-env-check
rm /tmp/vibez-prod-env-check
```

Expected: succeeds; no plaintext secret files in repo.

- [ ] **Step 3: Verify all checks**

Run:

```bash
bun test src/notifications.test.ts
bunx tsc --noEmit
node --check public/radio.js
```

Expected: all pass.

- [ ] **Step 4: Commit**

Run:

```bash
git add env/prod.env.tpl env/prod.env.example .env.example docs/slack-notifications.md
git commit -m "chore: wire Slack notification webhook env"
```

---

### Task 4: Deploy And Smoke Test

**Files:**
- No source changes expected.

- [ ] **Step 1: Push main**

Run:

```bash
git push origin main
```

Expected: push succeeds.

- [ ] **Step 2: Deploy**

Run:

```bash
OP_ACCOUNT=my.1password.eu bash scripts/deploy.sh
```

Expected: deploy completes and remote `deploy_vibez_1` is running.

- [ ] **Step 3: Verify production endpoint**

Run:

```bash
PASS=$(op read 'op://infra/vibez/auth-password') && curl -I --max-time 15 -u ":$PASS" https://vibez.bike-shed.io
```

Expected: HTTP `200`.

- [ ] **Step 4: Live smoke test**

Use a browser or native app to join Vibez and claim DJ.

Expected:

```text
- Join notification appears in Slack within 60 seconds.
- DJ notification appears immediately after successful claim.
```

---

## Self-Review

- Spec coverage: incoming webhook, 60-second join batching, immediate DJ notification, no-op when unconfigured, error isolation, production env, and deploy are covered.
- Placeholder scan: no placeholders remain.
- Type consistency: `createNotificationService`, `notifications`, `notifyListenerJoined`, `notifyDjStarted`, and `flushJoinedListeners` are consistently named.
