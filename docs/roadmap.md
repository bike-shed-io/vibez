# Vibez Roadmap

This document is the shared project memory for agents and humans working on Vibez.

## Current Product Direction

- Vibez is a team radio for synchronized listening while working together.
- The hosted backend at `https://vibez.bike-shed.io` remains the source of truth.
- Web and native macOS clients use the same WebSocket protocol (v3) and server state.
- The macOS menu-bar app is the primary UX direction; the web app stays working alongside it.
- Vibez syncs metadata only. It never hosts, uploads, relays or caches audio or video; every listener plays from the source service themselves.
- Keep SoundCloud usage conservative: no offline caching, no downloading, no bypassing intended playback restrictions.

## Current State

- Backend: Bun + Hono single process with static frontend and `/ws` sync endpoint.
- Auth: Sign in with Google for any Google account; listening is public, DJing/queueing needs sign-in.
- Channels: Person-based live channels in server memory; a directory of who's live; trusted DJs can take the decks.
- Sources: SoundCloud (stream URLs via public client id), Suno song links, and YouTube single-video links.
- YouTube plays through the official IFrame Player: the web app embeds it in the page, the Mac app floats a small always-on-top video panel (`WKWebView` loading `/yt-player.html`, driven through `window.vibez`). Both share `public/youtube.js`. Spec: `docs/superpowers/specs/2026-10-21-youtube-playback-design.md`.
- Sync model: the server keeps `{position, positionTimestamp, isPlaying}`; the DJ client sends `dj:position` every 5 s, which is relayed to listeners as `position`; video listeners snap when more than 2 s off.
- macOS app: Menu-bar-only popover app in `macos/VibezMac` (no Dock icon or main window) plus the video panel.
- Production: rootless Podman under user `vibez` on the shared Hetzner host.
- Distribution: public tap/release repo at `bike-shed-io/homebrew-vibez`; `brew install --cask vibez` (`vibez-mac` is the legacy token).

## Recent Decisions

- Vibez never hosts audio: file uploads ("Vibez EPs", PR #11) and P2P streaming from the DJ's machine are both out. Streaming metadata is the way.
- Official embedded players first (YouTube now, SoundCloud widget next); a Chrome extension client is expected later, not instead.
- YouTube playlists are unsupported on purpose (they need a Data API key); paste single video links.
- Suno is parked: no API or OAuth, the embed has no JS control, and new songs' media appears only ~15 min after creation. The existing Suno code stays, no further work.
- Spotify is parked: Development Mode caps apps at 5 users, remote playback needs Premium, and the policy forbids replicating Jam. People use Spotify Jam instead.
- Each channel's vibez slider is shared by its listeners; only the active DJ controls playback.

## Next

1. SoundCloud on the official Widget API, same shape as the YouTube player page.
2. Chrome extension client sharing the same protocol.
3. Continuous drift correction for audio tracks (video already has it).
4. Persistent channels, server-side trusted lists, Slack ↔ Google account linking (#8).
5. Native app polish: clearer connected/offline states, onboarding/settings, optional now-playing notifications.

## Working Notes For Agents

- Source repo: `bike-shed-io/vibez` (public). Mac release/tap repo: `bike-shed-io/homebrew-vibez`.
- Pushing `main` deploys the backend (`.github/workflows/deploy.yml`, skipped for `macos/**` and `*.md`) and, when `macos/**`, `src/channels.ts` or `src/ws.ts` change, releases a new Mac app (`.github/workflows/release-mac.yml`: builds, publishes a `homebrew-vibez` release, bumps the cask, posts a Slack note). Server and Mac app must ship together when the protocol changes; old clients are told to `brew update && brew upgrade --cask vibez`.
- Production secrets live in GitHub Actions secrets; `make env` / `make deploy` read 1Password (`OP_ACCOUNT=my.1password.eu`) and `env/prod.env.tpl` is missing the Google/session fields, so CI is the real deploy path.
- Bun is not installed globally: `npx -y bun test`, `npx -y bun run src/index.ts`, `npx -y bun x tsc --noEmit -p .`. `src/playlist.test.ts` hits SoundCloud live and can flake; rerun once.
- Mac: `make macos-build` (XcodeGen regenerates the ignored `.xcodeproj`), `make macos-run`. Single-file SourceKit diagnostics are noise; only `xcodebuild` output counts.
- Dev builds share bundle id `io.bike-shed.vibez.mac` with the installed app (UserDefaults and `~/Library/Application Support/Vibez/session-token`). Back up with `defaults export io.bike-shed.vibez.mac <file>` before `make macos-run`, restore afterwards, never leave test tokens behind.
- Local sign-in without Google: `SESSION_SECRET=dev npx -y bun scripts/dev-session.ts you@example.com "Name"` mints a session token (`vibez_session` cookie or the Mac token file).
- Mac crash debugging: `/usr/bin/log show --predicate 'processID == <pid>'` around the crash time.
- YouTube IFrame API: never call `cueVideoById` and `loadVideoById` back to back, the player stays cued. `public/youtube.js` therefore loads lazily on the first play/pause.
- Browsers autoplay with sound only after user activation; the saved-name auto-join path shows "Click to listen" instead.
- Fresh machine: Xcode, `brew install xcodegen gh 1password-cli`, Node for `npx bun`; `gh auth login`, `op signin`.

## Open Questions

- Should collaborative vibez be last-write-wins long-term, or should it become an aggregate/vote style control?
- Should the native app eventually replace the web UI for daily use, with web kept as fallback?
- Should the backend expose a small HTTP status/debug endpoint for easier native client diagnostics?
