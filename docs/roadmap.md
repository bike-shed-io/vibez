# Vibez Roadmap

This document is the shared project memory for agents and humans working on Vibez.

## Current Product Direction

- Vibez is an internal team radio for synchronized listening while working together.
- The hosted backend at `https://vibez.bike-shed.io` remains the source of truth.
- Web and native macOS clients should use the same WebSocket protocol and server state.
- The macOS app is the primary UX direction for the Mac-only team.
- Keep SoundCloud usage conservative: no offline caching, no downloading, no bypassing intended playback restrictions.
- Suno is the exception, and only through its own proxy: a room picks one source, and a Suno room's songs are downloaded by `suno-proxy/` and streamed from there.

## Current State

- Backend: Bun + Hono single process with static frontend and `/ws` sync endpoint.
- Auth: Sign in with Google for any Google account; listening is public, DJing/queueing needs sign-in.
- Channels: Person-based live channels in server memory; a directory of who's live; trusted DJs can take the decks.
- macOS app: Menu-bar-only popover app in `macos/VibezMac` (no Dock icon or main window).
- Production: rootless Podman under user `vibez` on the shared Hetzner host.
- Distribution: public tap/release repo at `bike-shed-io/homebrew-vibez`.
- Current cask token direction: prefer `brew install --cask vibez`; keep `vibez-mac` as legacy compatibility for now.

## Recent Decisions

- Each channel's vibez slider is shared by its listeners.
- Only the active DJ controls playback; the owner and trusted DJs can take the decks.
- Keep the web app working alongside the native app.
- Suno is a room source, not a link the resolver sniffs. The active DJ picks the
  source, which clears the queue, and Suno needs a static access token that only
  the server holds. Listening stays anonymous for both sources.
- Suno playback goes through `suno-proxy/`, a separate Go service that downloads
  each song, keeps it for 24 hours and serves it with Range support. Scraping a
  song page for a CDN URL to hand to listeners was the approach that failed:
  the real clip is encrypted, `og:audio` is a silent decoy and the studio
  `audio_url` is forbidden.
- Only published Suno songs can be streamed, and that limitation is accepted. A
  published song's page carries an mp4 with a plain audio track; an unpublished
  song exposes only the encrypted clip, so the DJ is told to publish it on Suno
  instead of being shown a generic failure.

## Near-Term Roadmap

1. Stabilize native app UX:
   - menu bar popover stays usable at a fixed size
   - avoid stale app instances during local iteration
2. Improve release workflow:
   - monitor automated macOS release workflow for reliability
   - document cask token migration from `vibez-mac` to `vibez`
3. Improve SoundCloud robustness:
   - better failure handling for tracks without transcodings
   - keep attribution/links intact
   - consider moving closer to official SoundCloud embed/intended playback where feasible
4. Polish native app:
   - clearer connected/offline states
   - better onboarding/settings screen
   - optional native now-playing notifications

## Next

- Persistent channels, server-side trusted lists, Slack ↔ Google account linking (#8)

## Release Notes For Agents

- Source repo: `bike-shed-io/vibez`.
- Mac release/tap repo: `bike-shed-io/homebrew-vibez`.
- Homebrew tap name: `bike-shed-io/vibez`.
- Build local mac app: `make macos-build`.
- Run local mac app: `make macos-run`.
- Deploy backend/web: `make deploy` or `OP_ACCOUNT=my.1password.eu bash scripts/deploy.sh` if the default 1Password account is ambiguous.
- Backend/web deploys are automated by `.github/workflows/deploy.yml` on pushes to `main`.
- Mac app releases are automated by `.github/workflows/release-mac.yml` when `macos/**`, `src/channels.ts`, or `src/ws.ts` changes on `main`, and can be manually dispatched.
- The Mac release workflow builds the app, publishes a `homebrew-vibez` release, bumps casks, and posts a Slack release note with `brew update && brew upgrade --cask vibez`.

## Open Questions

- Should collaborative vibez be last-write-wins long-term, or should it become an aggregate/vote style control?
- Should the native app eventually replace the web UI for daily use, with web kept as fallback?
- Should the backend expose a small HTTP status/debug endpoint for easier native client diagnostics?
