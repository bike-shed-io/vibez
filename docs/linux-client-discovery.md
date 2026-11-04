# Linux client discovery — 2026-11-04

## Requested outcome

Patrick switches between macOS and Linux and wants to listen to the same Vibez channels on both. The first task is to ask the existing dotfiles agent on PowerPat about its live desktop bar and integration conventions before implementing the Linux client.

- First Linux target: PowerPat (`powerpat` / `powerPat` SSH alias), EndeavourOS + Hyprland.
- Also support Omarchy without replacing its desktop configuration.
- The Linux client must be accessible from the desktop bar.
- Continue using the hosted Vibez server and the same listening sessions as Mac/web.
- Future direction: an Android client and eventually a Chrome extension. Patrick has an Android test device; friends have iOS devices for testing. A native iOS app has not been requested yet.

## Coordination

Contacted the existing dotfiles agent through Herdr's saved `powerPat` connection, agent pane `w1:p1`, working in `/home/patrick/Development/dotfiles`. These identifiers describe this discovery session; discover current IDs again before future contact.

Asked the agent to inspect, without changing the machine:

1. Live vs repository configuration drift, actual bar/version, and StatusNotifier tray support.
2. Existing custom bar plugins, paths, JSON output, styling, and update signals.
3. Tray vs custom module integration, click actions, and startup conventions.
4. Installed browser/GUI runtimes, PipeWire, MPRIS, and media controls.
5. Packaging/update conventions and Omarchy differences.
6. Any current GitHub Actions quota constraints affecting a Linux release pipeline.

## PowerPat findings

The dotfiles agent inspected the live system and replied on 2026-11-04. Its `./sync.sh status` reported 25 synced/linked entries and no modified, missing, or extra entries. The Linux checkout is newer than this Mac's dotfiles checkout; use the live Linux configuration as the reference.

| Area | Agent's observed result |
| --- | --- |
| Desktop bar | Waybar 0.15.0, at the top of the screen, height 30 |
| Compositor | Hyprland 0.57.0; active configuration is `.config/hypr/hyprland.lua`, not the old `hyprland.conf` |
| Configuration ownership | `.config/waybar/` and `.config/hypr/` are directory symlinks into `~/Development/dotfiles` |
| Tray | Working StatusNotifier host: Waybar owns `org.kde.StatusNotifierWatcher`; Discord is a registered live item. Legacy XEmbed tray icons are unsuitable. |
| Bar scripts | `~/Development/dotfiles/bin/` or tool-provided `~/.local/bin/`; examples are `waybar-weather`, `waybar-wol`, and `claude-usage --waybar` |
| Refresh signals | 8 = Claude usage, 9 = Codex usage, 10 = Wake-on-LAN; 11 was free at inspection time |
| Audio | PipeWire, pipewire-pulse/alsa/jack, WirePlumber; `playerctl` 2.4.1 is installed |
| MPRIS | No Waybar MPRIS module configured; `playerctld` is activatable but was not running |
| Packaging tools | `pacman`, `yay`, and `makepkg`; no `paru`, Flatpak, or Snap |
| Credentials | No functioning Secret Service was found; avoid assuming libsecret/keyring is available |

Installed client implementation options, as reported by the agent:

- Node 22.18.0, npm 10.9.3, Bun 1.3.11, Go 1.27.3, and Python 3.14.9.
- Electron 44.10.2 and several versioned Electron packages.
- WebKitGTK 4.1 (2.54.2), GTK 3/4, libadwaita, Qt 6, and libappindicator.
- Firefox, Google Chrome, Rofi, and Hyprland/GTK desktop portals.
- Rust/Cargo are absent. A Rust-based build would require installing a toolchain.

The agent recommends a custom Waybar module as the primary integration, with an optional StatusNotifier tray icon. The proposed CLI contract is `vibez status --waybar`, emitting one JSON object per line:

```json
{"text":"Vibez","class":"connected","tooltip":"Channel / track / listeners"}
```

Use `return-type: json`, `format: {}`, an `exec` command, and a polling interval in the module. Signal 11 can provide immediate refresh on PowerPat after rechecking availability; make it configurable elsewhere. Style `#custom-vibez` and state classes through CSS rather than emitting fixed colors. Keep tooltips and markup safely escaped when displaying remote channel or track names.

Suggested interactions are left-click to open/focus the client and right-click for a menu. Rofi is the local menu precedent; it must remain optional for other installations. For startup, the agent suggests a user systemd service and PowerPat's Lua `hl.on("hyprland.start", …)` convention. Choose a desktop-appropriate startup mechanism for each installation and avoid starting duplicate clients.

Packaging should supply opt-in configuration snippets rather than overwrite Waybar or Hyprland files. The agent suggests an Arch `vibez-bin` package updated through `yay`; package naming, publication, and client framework are still undecided. If using Electron, evaluate the installed versioned runtime and test Wayland/NVIDIA behavior: this machine has NVIDIA-specific environment settings and an existing `bin/chrome-x11` fallback.

For Omarchy, the agent recommends the same bar-module contract, theme-owned CSS, optional tray support, and no automatic desktop-config rewrites. This is a compatibility target, not a tested result: the agent inspected PowerPat, not an Omarchy machine.

For Linux native credentials, a private directory and a `0600` token file are a candidate fallback. Do not copy an assumed Mac Keychain implementation: the existing Mac app also uses a `0600` token file (`VibezAuth.swift`). The native sign-in and credential-storage design remains open.

## Release constraint reported by the agent

The agent reported exhausted included GitHub Actions minutes (2,154 / 2,000, resetting 2026-12-01) and a local-first checks/release discussion led by its research peer. The relevant billing account and applicability to `bike-shed-io/vibez` were not independently verified. Do not assume successful historical workflow runs imply free runner capacity; verify billing scope before choosing a Linux release pipeline. Local builds on PowerPat are an available option to investigate. No workflows were added or changed during discovery.

## Existing application constraints

- The hosted server at `https://vibez.bike-shed.io` is the shared source of truth. Protocol v3 is enforced in `src/ws.ts`; `public/radio.js` sends `hello` with `protocol: 3`.
- Preserve the distinction between local listening controls and DJ controls. Only the active DJ changes shared playback.
- Listening is public; Google sign-in is required for DJ/queue actions. Native OAuth currently recognizes `client=mac` and returns through `vibez://auth`; Linux authentication needs an explicit design before reusing that flow.
- The client must use official YouTube embeds and retain visible video playback. Do not turn the desktop bar into a hidden YouTube audio player. SoundCloud usage must retain the existing playback guardrails.
- `pkg/aur/PKGBUILD` currently describes a Bun server installation, with placeholder metadata. It is not an existing Linux desktop client package.
- Backend deployment is `.github/workflows/deploy.yml`; Mac releases are `.github/workflows/release-mac.yml`. The latest listed runs succeeded on 2026-10-21. This verifies existing workflow history, not future runner availability or billing quota.

## Validation for the implementation phase

- Run on PowerPat under Wayland: launch, bar integration, single instance, close-to-tray behavior, quit, and optional startup.
- Join the same channel from Mac, Linux, Android browser, and iOS browser; exercise track changes, pause/resume, reconnect, and synchronization. Test mobile foreground and screen-locked behavior separately rather than promising background playback.
- Verify anonymous listening, browser-based sign-in if implemented, and `vibez://channel/<id>` links.
- Keep global playback controls restricted to the active DJ; a listener's media key must not pause the whole room.
- Test YouTube's visible official player, user-gesture/autoplay behavior, and audio output on PipeWire.
- Validate on an actual Omarchy installation before claiming Omarchy support.

No Linux app, packaging, desktop configuration change, or deployment is part of this discovery result.
