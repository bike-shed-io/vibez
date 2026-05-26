# Agent Notes

Read this first when working on Vibez.

## Core Context

- Product roadmap and active decisions: `docs/roadmap.md`.
- macOS app plan and SoundCloud guardrails: `prompts/mac-app-plan.md`.
- Production infrastructure and deploy context: `prompts/infra.md`.

## Current Direction

- Keep the hosted backend/web and native macOS app using the same WebSocket protocol.
- The native macOS menu bar app is the main product direction for the Mac-only team.
- Room vibez is currently collaborative: any connected listener may move the shared vibez slider.
- DJ ownership is for playback control only.
- Be conservative with SoundCloud usage: no downloads/offline caching or bypassing player restrictions.

## Useful Commands

- Web/backend dev: `bun run src/index.ts`.
- Production deploy: `make deploy`.
- Generate macOS project: `make macos-project`.
- Build macOS app: `make macos-build`.
- Run macOS app: `make macos-run`.

## Release Notes

- Mac app source lives in this repo under `macos/VibezMac`.
- Public Homebrew tap/release repo is `bike-shed-io/homebrew-vibez`.
- Homebrew tap name is `bike-shed-io/vibez`.
- Preferred install UX is `brew tap bike-shed-io/vibez && brew install --cask vibez`.
- Keep `vibez-mac` cask compatibility until explicitly migrated away.
- Backend/web deploys run from `.github/workflows/deploy.yml` on pushes to `main`.
- Vibez for Mac releases run from `.github/workflows/release-mac.yml` on `main` changes touching `macos/**`, `src/station.ts`, or `src/ws.ts`, and can also be triggered manually.
- The Mac release workflow builds the app, creates a `homebrew-vibez` release, bumps both casks, and posts the Slack update command: `brew update && brew upgrade --cask vibez`.
