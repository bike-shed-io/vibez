# Vibez Roadmap

This document is the shared project memory for agents and humans working on Vibez.

## Current Product Direction

- Vibez is an internal team radio for synchronized listening while working together.
- The hosted backend at `https://vibez.bike-shed.io` remains the source of truth.
- Web and native macOS clients should use the same WebSocket protocol and server state.
- The macOS app is the primary UX direction for the Mac-only team.
- Keep SoundCloud usage conservative: no offline caching, no downloading, no bypassing intended playback restrictions.

## Current State

- Backend: Bun + Hono single process with static frontend and `/ws` sync endpoint.
- Auth: basic auth password for now; username is ignored.
- Production: rootless Podman under user `vibez` on the shared Hetzner host.
- Native macOS app: SwiftUI menu bar + Dock app in `macos/VibezMac`.
- App visibility: Dock and menu bar are both visible by default; users may hide either one in settings, but not both.
- Distribution: public tap/release repo at `bike-shed-io/vibez-mac`.
- Current cask token direction: prefer `brew install --cask vibez`; keep `vibez-mac` as legacy compatibility for now.

## Recent Decisions

- Room vibez is collaborative for now: any connected listener can move the shared vibez slider.
- DJ ownership only controls playback operations such as play, pause, resume, and seek.
- Main macOS app window should hide on red close, not terminate the app.
- Actual quit should be available from the menu bar right-click menu.
- Keep the web app working alongside the native app.

## Near-Term Roadmap

1. Stabilize native app UX:
   - window close hides app instead of quitting
   - robust right-click menu: Open Vibez, Open Settings, Quit
   - menu bar popover stays usable at a fixed size
   - avoid stale app instances during local iteration
2. Improve release workflow:
   - one-command mac release script
   - cask bump automation
   - document cask token migration from `vibez-mac` to `vibez`
3. Improve auth:
   - short term: store local mac app auth in Keychain instead of app defaults
   - later: replace basic auth with Google OAuth restricted to `@enam.co` if company access is available
4. Improve SoundCloud robustness:
   - better failure handling for tracks without transcodings
   - keep attribution/links intact
   - consider moving closer to official SoundCloud embed/intended playback where feasible
5. Polish native app:
   - app icon
   - clearer connected/offline states
   - better onboarding/settings screen
   - optional native now-playing notifications

## Release Notes For Agents

- Source repo: `bike-shed-io/vibez`.
- Mac release/tap repo: `bike-shed-io/vibez-mac`.
- Build local mac app: `make macos-build`.
- Run local mac app: `make macos-run`.
- Deploy backend/web: `make deploy` or `OP_ACCOUNT=my.1password.eu bash scripts/deploy.sh` if the default 1Password account is ambiguous.
- Do not release a new cask unless explicitly asked.
- When releasing mac app, build from latest committed `vibez` source, upload zip to `bike-shed-io/vibez-mac`, update cask SHA/version, and verify with `brew info --cask vibez`.

## Open Questions

- Should collaborative vibez be last-write-wins long-term, or should it become an aggregate/vote style control?
- Should the native app eventually replace the web UI for daily use, with web kept as fallback?
- Should the backend expose a small HTTP status/debug endpoint for easier native client diagnostics?
