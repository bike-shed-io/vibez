# Slack Notifications Setup

Vibez uses a Slack Incoming Webhook for channel notifications.

## Secret Location

The Slack app/webhook details are stored in 1Password:

```text
Account/collection: enam
Vault: eng admin
Item: vibez Slack app
Item ID: gz3fstsnolbqgvmqgfe6w72lau
Webhook field label: url
Webhook field ID: naivtgjlnve3fxooq5dzstknvm
```

Do not commit the webhook URL to git.

## Slack App

- App name: `Vibez Notifications`
- Feature: Incoming Webhooks
- Target channel: configured in Slack when the webhook is created

## Local Test

Use the webhook URL from 1Password and test with:

```sh
curl -X POST \
  -H 'Content-type: application/json' \
  --data '{"text":"Hello from Vibez"}' \
  "$SLACK_NOTIFICATIONS_WEBHOOK_URL"
```

## Production Env

The app should read the webhook from:

```text
SLACK_NOTIFICATIONS_WEBHOOK_URL
```

The deploy script reads the webhook from the company 1Password account and appends it to the generated production env:

```text
SLACK_NOTIFICATIONS_OP_ACCOUNT=enamco.1password.com
op://Eng Admin/gz3fstsnolbqgvmqgfe6w72lau/naivtgjlnve3fxooq5dzstknvm
```

This is intentionally handled in `scripts/deploy.sh`, because the existing production env template resolves secrets from the personal `infra` vault/account while this Slack webhook lives in the company account.

## Security Note

If a webhook URL is pasted into chat, logs, or any public place, rotate it in Slack immediately and update the 1Password item.

## Release Notifications

When a Vibez for Mac release is scheduled or completed, post a Slack webhook message with the version, short summary, and update command.

Example payload:

```json
{
  "text": ":sparkles: Vibez for Mac v0.1.4 is available\nUpdate with: `brew update && brew upgrade --cask vibez`"
}
```

Example command:

```sh
SLACK_NOTIFICATIONS_WEBHOOK_URL="$(OP_ACCOUNT=enamco.1password.com op read 'op://Eng Admin/gz3fstsnolbqgvmqgfe6w72lau/naivtgjlnve3fxooq5dzstknvm')"
curl -X POST \
  -H 'Content-type: application/json' \
  --data '{"text":":sparkles: Vibez for Mac v0.1.4 is available\nUpdate with: `brew update && brew upgrade --cask vibez`"}' \
  "$SLACK_NOTIFICATIONS_WEBHOOK_URL"
```
