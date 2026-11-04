# Vibez for Windows

## Install

Download `Vibez-Setup-0.2.0-x64.exe` and its `.sha256` file from the desktop preview
release. This is the Intel/AMD x64 installer, for Windows 10/11. ARM64 can be built
separately with the same shared source.

To compare the downloaded checksum in PowerShell:

```powershell
Get-FileHash .\Vibez-Setup-0.2.0-x64.exe -Algorithm SHA256
Get-Content .\Vibez-Setup-0.2.0-x64.exe.sha256
```

Run the Setup EXE, then open **Vibez** from the Start menu. Electron is included;
you do not need Node, npm, or any development tools. Installation is for your
Windows account and does not request administrator access. The preview installer
is unsigned; Windows may display a SmartScreen warning.

The app uses the existing hosted radio. Enter your name and tune in, or sign in
with Google through your normal browser to DJ and queue tracks. Accept the
browser's request to open the `vibez://` callback in Vibez.

## Desktop behavior

- The tray icon opens the shared player. Right-click it for local mute, hide, quit,
  and an optional **Start Vibez at sign-in** toggle, disabled by default.
- Close hides the window for audio listening; **Quit Vibez** exits. YouTube tracks
  keep the official player window visible.
- `vibez://channel/<id>` links reuse the running instance.
- Credentials are protected with Windows DPAPI, stored under `%APPDATA%\Vibez`.
- The app installs under `%LOCALAPPDATA%\Programs\Vibez` by default.
- Uninstall through Windows **Installed apps**. It removes the app's startup and
  URL registration while preserving your preferences and encrypted session.

Windows and Linux use the same `desktop/main.cjs`, preload, hosted player, and
client policies. OS integrations live under `desktop/platform/`.

## Build locally

Install Node 22.12 or newer and the NSIS compiler (`makensis`), then run from the
repository root:

```powershell
npm ci --prefix desktop --ignore-scripts
node scripts/build-windows-package.cjs --arch x64
```

The result is `dist/windows/Vibez-Setup-0.2.0-x64.exe` plus its SHA-256 checksum.
Set `MAKENSIS` if NSIS is installed outside its standard location. The same build
works on macOS with `brew install makensis`, without Wine. It verifies the pinned
Electron runtime, packages the shared app into ASAR, then compiles a per-user NSIS
installer. It does not run GitHub Actions or publish a release.

`--arch arm64` selects Windows ARM64. `VIBEZ_ELECTRON_ZIP` can point at an already
downloaded runtime ZIP for offline builds; its pinned checksum is still verified.

## Installation check on your PC

1. Install, open from Start, confirm the tray icon, hide/reopen, and quit.
2. Join a channel with a Mac/web listener and check real audio/video playback.
3. Sign in through the browser, restart to check persistence, then sign out.
4. Open a `vibez://channel/...` link and confirm no duplicate app instance appears.
5. Optionally enable startup, sign out/in, then disable it again.
6. Uninstall and confirm the app and its startup entry are removed.

Native Windows installation and DPAPI behavior require this Windows test. Linux
hardware testing remains deferred. Automated source checks run locally with
`node --test desktop/tests/*.test.cjs`; the fixture desktop check is
`desktop\node_modules\.bin\electron.cmd desktop\tests\smoke.cjs --background`.
