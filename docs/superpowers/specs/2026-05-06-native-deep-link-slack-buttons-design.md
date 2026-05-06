# Native Deep Link Slack Buttons Design

## Goal

Make Slack notifications prefer opening Vibez for Mac while keeping the website as a reliable fallback.

## Current Behavior

- Slack join and DJ notifications include one `Open Vibez` button.
- That button points to `RADIO_URL`, so it opens `https://vibez.bike-shed.io`.
- The macOS app does not currently register a custom URL scheme.

## Approved Direction

- Register a native macOS URL scheme: `vibez`.
- Support the URL `vibez://open`.
- When the native app receives `vibez://open`, it should focus/open the main Vibez window.
- Slack notifications should include two buttons:
  - `Open Vibez App` -> `vibez://open`
  - `Open Web` -> `RADIO_URL`
- The app button is the primary path. The web button remains necessary because some Slack clients/browsers may block or ignore custom URL schemes, and some users may not have the native app installed.

## macOS App Behavior

- Add URL scheme registration to the XcodeGen project so generated `Info.plist` includes `CFBundleURLTypes` for `vibez`.
- Add `onOpenURL` handling in the SwiftUI app shell.
- URL handling should:
  - accept `vibez://open`
  - activate the app
  - show/focus the main window if possible
  - ignore unknown Vibez URLs for now
- Existing red-close behavior remains: closing the main window hides it rather than quitting.
- Existing menu bar behavior remains unchanged.

## Slack Notification Behavior

- Update Slack webhook payloads generated in `src/notifications.ts`.
- All notification messages should include two action buttons:
  - `Open Vibez App`, URL `vibez://open`, action id `open_vibez_app`
  - `Open Web`, URL from `RADIO_URL`, action id `open_vibez_web`
- Message text remains unchanged.
- Join batching and DJ-start timing remain unchanged.

## Release Impact

This change requires both release paths:

- Backend deploy: required for updated Slack notification buttons.
- Vibez for Mac release: required so teammates have an app version that registers `vibez://open`.
- Homebrew cask bump: required after building the new macOS release artifact.

## Testing

- Backend tests:
  - Slack payload contains both buttons.
  - Web fallback button uses configured `RADIO_URL`.
  - Join batching and DJ notification tests still pass.
- macOS checks:
  - `make macos-build` succeeds.
  - Generated `Info.plist` contains the `vibez` URL scheme.
  - Local manual test: `open 'vibez://open'` opens/focuses Vibez.
- Production smoke test:
  - Trigger a Slack notification.
  - Verify Slack shows both buttons.
  - Click `Open Vibez App` and confirm the native app opens/focuses.
  - Click `Open Web` and confirm the website opens.

## Out Of Scope

- Deep links to a specific track, DJ state, or settings pane.
- Mobile app support.
- Discord notification buttons.
- OAuth or auth changes.
