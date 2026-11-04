# Agent Notes

Read this first when working on Vibez.

## Core Context

- Product roadmap and active decisions: `docs/roadmap.md`.
- macOS app plan and SoundCloud guardrails: `prompts/mac-app-plan.md`.
- Production infrastructure and deploy context: `prompts/infra.md`.
- Linux desktop requirements and PowerPat dotfiles-agent findings: `docs/linux-client-discovery.md`.
- Shared desktop architecture and Linux guide: `desktop/README.md`; Windows installation: `windows/README.md`.

## Current Direction

- Keep the hosted backend/web and native macOS app using the same WebSocket protocol.
- Windows and Linux use one shared Electron desktop shell in `desktop/`, with OS adapters in `desktop/platform/`. The existing native Swift Mac app remains separate. Linux integrates with the desktop bar on EndeavourOS + Hyprland, with Omarchy as a compatibility target.
- Coordinate Linux desktop integration with the existing PowerPat dotfiles agent before choosing a client implementation. Android is a future client target; Android and iOS phones are available for testing, and a Chrome extension is expected later.
- Each channel's vibez slider is shared by its listeners.
- Only the active DJ controls playback; the owner and trusted DJs can take the decks.
- Current WebSocket protocol is v3 (`src/ws.ts`); Mac, web, and future clients must share the same channels and playback state.
- Be conservative with SoundCloud usage: no downloads/offline caching or bypassing player restrictions.

## Useful Commands

- Web/backend dev: `bun run src/index.ts`.
- Production deploy: push to `main` (or run the Deploy workflow); all secrets live in GitHub Actions. `make deploy` is a local fallback that needs Patrick's 1Password + SSH key.
- Generate macOS project: `make macos-project`.
- Build macOS app: `make macos-build`.
- Run macOS app: `make macos-run`.
- Shared desktop checks: `node --test desktop/tests/*.test.cjs`.
- Build a pacman package locally on Arch: `bash scripts/build-linux-package.sh`.
- Build the Windows x64 installer locally: `npm ci --prefix desktop --ignore-scripts`, then `node scripts/build-windows-package.cjs --arch x64` (requires NSIS).
- Keep CI disabled while Actions minutes are exhausted. Prepared Linux/Windows workflows have `.yml.disabled` extensions; do not rename or trigger them without a later instruction to enable CI.
- Linux hardware testing is parked. Windows targets Intel/AMD x64; Patrick will test the installer on his PC. Run automated checks locally, with no CI.

## Release Notes

- Mac app source lives in this repo under `macos/VibezMac`.
- Public Homebrew tap/release repo is `bike-shed-io/homebrew-vibez`.
- Homebrew tap name is `bike-shed-io/vibez`.
- Preferred install UX is `brew tap bike-shed-io/vibez && brew install --cask vibez`.
- Keep `vibez-mac` cask compatibility until explicitly migrated away.
- Backend/web deploys run from `.github/workflows/deploy.yml` on pushes to `main`.
- Vibez for Mac releases run from `.github/workflows/release-mac.yml` on `main` changes touching `macos/**`, `src/channels.ts`, or `src/ws.ts`, and can also be triggered manually.
- The Mac release workflow builds the app, creates a `homebrew-vibez` release, bumps both casks, and posts the Slack update command: `brew update && brew upgrade --cask vibez`.
- Linux desktop package is `vibez-desktop` (command `vibez`), using the system `electron44` runtime. `pkg/arch/PKGBUILD` is a local-build template; `pkg/aur/vibez-desktop-git` is the development recipe, currently sourcing `feat/linux-client`.
- Both desktop clients load the existing hosted player; no protocol or backend changes are required. The shared isolated preload observes player status; recheck that integration when changing web DOM IDs.
- Windows builds include a pinned Electron runtime, ASAR payload, per-user NSIS installer, and SHA-256 checksum. Sign-in uses Windows DPAPI; Linux preserves private token files and XDG paths. Preview installers are unsigned.
