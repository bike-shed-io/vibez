# Shared Vibez desktop client

A shared Windows/Linux desktop client for the existing Vibez radio at https://vibez.bike-shed.io.
It runs the shared web player in an isolated, sandboxed Electron window, with a
StatusNotifier tray icon, a Waybar module, channel links, and native browser sign-in.
Windows, Mac, Linux, and web use the same channels and protocol v3. No backend deployment is
needed to test this client.

## Install on Windows

Download `Vibez-Setup-0.2.0-x64.exe` from the desktop preview release and run it.
It installs for your Windows user, includes Electron, and creates a Start menu
shortcut. No Node, Electron, administrator access, or development tools are needed
to run the installed app. See [the Windows guide](../windows/README.md).

The Windows adapter uses DPAPI-backed encrypted credentials, a per-profile named
pipe, `vibez://` registration, and optional startup from the tray menu.

## Install the Arch package

For EndeavourOS, Omarchy, or Arch Linux:

```sh
sudo pacman -U ./vibez-desktop-0.2.0-1-any.pkg.tar.zst
vibez
```

`pacman` installs the package and resolves `electron44` and `nodejs` from your
configured repositories. The package uses Arch's system Electron; it does not
bundle a Chromium runtime, run a local Vibez server, or install npm dependencies.

The package name is **vibez-desktop** and the command is **vibez**. Existing
`pkg/aur/PKGBUILD` files in this repository describe the old server package and
must not be used to install this desktop client.

## Build Linux locally, without CI

From a clone of the `feat/linux-client` branch:

```sh
sudo pacman -S --needed base-devel nodejs python
bash scripts/build-linux-package.sh
sudo pacman -U dist/linux/vibez-desktop-0.2.0-1-any.pkg.tar.zst
```

The script packages the working tree, runs the Node tests, and writes the package,
source archive, exact PKGBUILD, `.SRCINFO`, and `SHA256SUMS` to `dist/linux/`. It does
not install anything or start GitHub Actions. It can also build from a source
checkout without a `.git` directory. Run it as your normal user; `makepkg` rejects
root builds. The runtime does not need to be installed just to assemble the package.

For a development build through `yay`, from the repository root:

```sh
yay -Bi pkg/aur/vibez-desktop-git
```

This uses the included git PKGBUILD and fetches the `feat/linux-client` branch.
The recipe is ready for AUR publication, but **has not been submitted to the AUR**:
`yay -S vibez-desktop-git` will only work after publication. After merging the
client, update the recipe's source branch to `main` before publishing it.

The repository has not declared a software license; package metadata records
`LicenseRef-Unknown` and includes the upstream notice.

## Waybar and Omarchy

The tray appears in Waybar's existing `tray` module. For a persistent, themeable
now-playing indicator, merge the example in
`/usr/share/doc/vibez-desktop/waybar.jsonc` into your existing Waybar configuration,
add `custom/vibez` to a modules list, and include the example `waybar.css` rules in
your bar stylesheet. The source examples are in `desktop/platform/linux/integration/`.

- Left-click opens/focuses the app.
- Right-click opens a Rofi menu; without Rofi it opens the app.
- Middle-click mutes/unmutes this computer only.
- The indicator refreshes every two seconds, including after app or bar restarts.
- Signal 11 is configured as an optional immediate refresh signal; change it if
  already used by another module. Polling works without sending any signals.

The module inherits colors from the bar theme, including Omarchy theme changes.
Installation never rewrites dotfiles, changes the bar layout, or enables startup.
PowerPat's live Hyprland configuration is Lua, so do not edit its old
`hyprland.conf`. Omarchy must still be tested on an actual Omarchy installation.

## Usage

```sh
vibez open
vibez 'vibez://channel/CHANNEL_ID'
vibez status --waybar
vibez status
vibez mute
vibez hide
vibez quit
```

Close hides the window while audio keeps playing. Use the tray menu, `vibez quit`,
or Ctrl+Q to exit. A YouTube track brings the window forward and prevents the
client's close/hide action while its official video player is active. It is not a
hidden YouTube audio player. Click **Click to listen** when prompted by autoplay
rules. Local mute does not pause the shared channel or change DJ controls.

Click **Sign in with Google** inside Vibez to open your system browser. The
existing native callback is named `client=mac` on the server; the desktop handler
receives its `vibez://auth` redirect on Linux too. No new Google credentials are
needed. The app accepts callbacks only shortly after initiating sign-in, validates
the session with the server, and keeps the origin-bound token in a `0600` file in
`$XDG_CONFIG_HOME/vibez-desktop/session-token` on Linux (normally `~/.config/…`). It does not
require a working Linux keyring. Sign-out deletes that token.

The `.desktop` entry advertises `vibez://` handling. If your desktop has not chosen
a handler yet, set it explicitly:

```sh
xdg-mime default vibez.desktop x-scheme-handler/vibez
```

## Optional startup on Linux

After testing interactively, import your graphical environment and enable the
packaged user service:

```sh
systemctl --user import-environment WAYLAND_DISPLAY DISPLAY XDG_CURRENT_DESKTOP
systemctl --user enable --now vibez.service
```

The service starts in the background and restarts on failure. On desktops where
`graphical-session.target` is not started automatically, add a single
`systemctl --user start vibez.service` invocation using that desktop's existing
startup mechanism after the graphical environment is imported. PowerPat uses a
Lua `hl.on("hyprland.start", …)` hook. Do not combine multiple autostart methods.

```sh
systemctl --user disable --now vibez.service
journalctl --user -u vibez.service -b
```

## Wayland / NVIDIA and development

The launcher defaults to Chromium's automatic Wayland/X11 selection. If NVIDIA
causes a blank window, quit all instances and try:

```sh
VIBEZ_OZONE_PLATFORM=x11 vibez
```

Arch's Electron wrapper also reads its normal `electron44-flags.conf`. The client
keeps the Chromium sandbox enabled. Test alternate display settings before
persisting them in your user service environment.

Use `VIBEZ_APP_DIR=/absolute/path/to/desktop` to run the source with the launcher.
`VIBEZ_ELECTRON=/path/to/electron` selects a compatible runtime. For a local server,
set `VIBEZ_SERVER_URL=http://127.0.0.1:3005`; all non-loopback servers require HTTPS.
Use a separate `XDG_CONFIG_HOME` for development to keep your real preferences
and session separate.

## Deferred Linux hardware test

PowerPat/Omarchy hardware testing is parked for later. When resuming:

1. Install with `pacman -U`, launch from the desktop menu, and confirm the tray icon.
2. Join a channel alongside the Mac app. Exercise track changes, pause/resume,
   queue/DJ permissions, local volume, and reconnect after a network interruption.
3. Check SoundCloud audio, close-to-tray listening, reopening, and local mute.
4. Play a YouTube link, confirm the official video is visible and that hide/close
   keeps the player window open. Verify any autoplay prompt.
5. Sign in through the external browser and callback. Restart to check persistence,
   then sign out and confirm the next launch stays signed out.
6. Add the Waybar snippet and verify text, tooltip, three click actions, and theme
   changes. Restart Waybar and check the app keeps playing.
7. Try a `vibez://channel/...` link from the browser and confirm it reuses the app.
8. Join the same room from Android/iOS browsers. Check foreground playback first;
   screen-locked/background mobile playback is a separate test, not guaranteed.

## Checks and future CI

```sh
node --test desktop/tests/*.test.cjs
# In a Linux graphical session, using a disposable local fixture rather than real rooms:
electron44 desktop/tests/smoke.cjs --background
```

The Electron smoke test covers the real sandbox/preload, IPC status, visibility,
local mute, video visibility rule, native auth, channel links, logout, and offline
retry. It uses temporary private paths and does not touch your real session.
For a headless native Linux runner, use `dbus-run-session -- xvfb-run -a electron44
--disable-gpu desktop/tests/smoke.cjs --background` with `xorg-server-xvfb` and
`xorg-xauth` installed. QEMU user-mode emulation cannot run Chromium's zygote
reliably; use native hardware for the desktop test.

`.github/workflows/release-linux.yml.disabled` is a prepared, **inactive** workflow.
GitHub does not discover that extension. When CI is wanted again, rename it to
`release-linux.yml`; it is manual-only and uploads the same locally built package
and checksums. It does not automatically publish to GitHub Releases or the AUR.

## Shared architecture

- `shared/core.cjs`: OS-independent URL, deep-link, and status policies; no Node or Electron imports.
- `main.cjs`, `preload.cjs`: one window/player, sign-in flow, security boundary, and tray controller for both desktop platforms.
- `credentials.cjs`, `ipc.cjs`: shared storage and command handling with platform hooks.
- `platform/posix.cjs`: XDG paths, private files, Unix sockets, Linux runtime flags; also supports macOS development checks.
- `platform/linux/`: Waybar formatting, launcher, and systemd/desktop integration.
- `platform/windows.cjs`: Windows profile paths, DPAPI, named pipes, protocol and startup registration.

The music UI and synchronization still come from the hosted `public/` web player.
There is no Windows-specific copy of that player. The native Swift Mac app remains
a separate client; integrating it with a future shared player engine is deferred.

Build the Windows installer locally with `npm ci --prefix desktop` followed by
`node scripts/build-windows-package.cjs --arch x64`. The NSIS compiler must be
installed (`brew install makensis` on macOS, or NSIS on Windows). CI stays disabled.
