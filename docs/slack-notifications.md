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
