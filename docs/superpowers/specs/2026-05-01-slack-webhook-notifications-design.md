# Slack Webhook Notifications Design

## Goal

Notify the team in Slack when people join Vibez and when someone starts DJing, without coupling station/WebSocket logic directly to Slack-specific code.

## Slack Setup

Use a Slack Incoming Webhook for v1.

Setup steps:

1. Go to `https://api.slack.com/apps`.
2. Create a new app from scratch named `Vibez Notifications`.
3. Pick the company workspace.
4. Open `Incoming Webhooks`.
5. Turn on `Activate Incoming Webhooks`.
6. Click `Add New Webhook to Workspace`.
7. Choose the target channel, ideally `#vibez` or `#radio`.
8. Copy the webhook URL.
9. Store it in 1Password vault `infra`, item `vibez`, field `slack-notifications-webhook-url`.

Add this env var:

```text
SLACK_NOTIFICATIONS_WEBHOOK_URL={{ op://infra/vibez/slack-notifications-webhook-url }}
```

## Behavior

### Listener Joins

- Every listener join is eligible for notification.
- Join notifications are batched in a rolling 60-second window.
- Names are deduplicated within the current window.
- If one listener joins in the window, send: `Patrick joined Vibez`.
- If multiple listeners join, send: `Patrick, Lisa, and Max joined Vibez`.
- After sending, clear the batch.

### DJ Starts

- Send immediately when a WebSocket `dj:claim` succeeds.
- Do not send when a `dj:claim` fails because someone else is DJing.
- Do not notify on `dj:release`.
- Do not notify for Slack `/radio play` auto-claim in v1 unless later requested.

## Message Shape

Slack messages should include:

- concise text summary
- `Open Vibez` button pointing to `RADIO_URL`
- plain fallback text with the same URL where useful

Example join batch:

```text
:radio: Patrick and Lisa joined Vibez
```

Example DJ start:

```text
:headphones: Patrick is DJing on Vibez
```

## Architecture

Create `src/notifications.ts` as a small, generic notification layer.

Responsibilities:

- read `SLACK_NOTIFICATIONS_WEBHOOK_URL`
- no-op cleanly if not configured
- expose semantic functions such as:
  - `notifyListenerJoined(name: string)`
  - `notifyDjStarted(name: string)`
- handle join batching internally
- format Slack webhook payloads
- catch/log notification errors without affecting radio behavior

Keep `src/ws.ts` responsible for station/WebSocket events only. It should call the semantic notification functions after successful state changes.

## Future Discord Support

Keep the public notifier API provider-neutral. Later Discord can be added by either:

- adding a second webhook URL env var, or
- replacing the Slack-specific sender with a fan-out sender.

No Discord implementation is part of v1.

## Native App Deep Link

Deep links are a follow-up feature, not required for the first notification implementation.

Future direction:

- Register a macOS URL scheme such as `vibez://open`.
- Handle it in the native app by opening/focusing the main Vibez window.
- Add two Slack buttons:
  - `Open Vibez App` → `vibez://open`
  - `Open Web` → `RADIO_URL`

For v1, use only the web `RADIO_URL` button to keep Slack behavior reliable across desktop/browser clients.

## Error Handling

- If webhook URL is missing, notifications are disabled with one startup log line.
- If Slack webhook post fails, log a warning and continue.
- Notification failures must never fail join, DJ claim, playback, or WebSocket handling.

## Testing

- Unit-test message formatting helpers where practical.
- Unit-test join batching behavior with fake timers or an injectable delay if feasible.
- At minimum, verify:
  - no webhook URL means no throw
  - single join sends one singular message after the window
  - multiple joins send one plural message after the window
  - repeated names are deduped in one window
  - DJ start sends immediately

## Out Of Scope

- Discord notifications.
- Native app deep link implementation.
- Slack bot `chat.postMessage` scopes or channel IDs.
- User-level Slack identity mapping.
