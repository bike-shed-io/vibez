# Vibez macOS App Plan

## Context

- Team is Mac-only.
- Goal: a pleasant native top menu bar experience for vibez.
- We want to stay reasonably compliant with SoundCloud usage and avoid copyright / blocking issues.

## Recommended Direction

- Build a small native macOS menu bar app in SwiftUI.
- Use `MenuBarExtra` for the top bar presence.
- Keep `vibez.bike-shed.io` as the source of truth.
- Start as a thin client, not a full second product.

## Product Shape

- Menu bar app with a popover or compact window.
- Show:
  - current track
  - play / pause
  - become DJ
  - vibez slider
  - quick open full app

## Architecture

### V1

- Native macOS shell around the existing hosted app.
- Prefer a `WKWebView` wrapper first for speed.
- Reuse the current backend and web app.

### V2

- Move selected interactions native if useful.
- Possible native pieces:
  - listener controls
  - DJ controls
  - live sync via WebSocket

## Distribution

- For a GUI mac app, use a Homebrew cask, not the current formula approach.
- Ship a signed `.app` as a zip or dmg.
- Longer term: add notarization and release automation.

## SoundCloud / Compliance Guardrails

- Favor official SoundCloud embeds / intended playback paths where possible.
- Avoid deep native playback logic that looks like a custom SoundCloud client.
- Do not cache or download tracks for offline use.
- Do not bypass intended player restrictions.
- Keep attribution / links intact.

## Why This Direction

- Fastest path to a useful internal Mac app.
- Lowest maintenance compared with building a fully separate desktop client.
- Lower compliance risk than pushing further into custom SoundCloud playback.

## Rough Effort

- V1 SwiftUI menu bar shell with `WKWebView`: 1-2 days for a decent alpha.
- More native UI with direct sync: 3-5 days.
- Signing / notarization / cask pipeline: add 1-2 days.

## Open Question For Later

- If company OAuth becomes available, consider replacing current basic auth with Google OAuth restricted to `@enam.co`.

## Suggested Next Conversation

1. Decide whether to keep V1 as a `WKWebView` shell or go more native immediately.
2. Decide whether auth stays basic auth for the app alpha or moves to Google OAuth.
3. Sketch the mac app structure, release flow, and what stays web vs native.
