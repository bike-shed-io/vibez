# VibezMac

Native macOS alpha for vibez.

## What it is

- Menu-bar-only SwiftUI app: no Dock icon, no windows
- Click the menu bar icon for everything: the live channels, now playing, go live and settings
- Right-click the icon for Settings… and Quit Vibez
- `vibez://channel/<id>` opens that channel (`vibez://open` just opens the popover)
- Listening needs no account. Sign in with Google (Settings → Account) to go live or add tracks. The session token is stored in `~/Library/Application Support/Vibez/session-token` (file 0600), not Keychain, so ad-hoc-signed upgrades don't trigger a Keychain prompt.
- native playback and WebSocket sync against the hosted vibez backend
- native DJ controls, local volume, and local vibez range

## Generate the Xcode project

```sh
make macos-project
```

## Build from the command line

```sh
make macos-build
```

## Build and launch from the command line

```sh
make macos-run
```

## Open in Xcode

```sh
open macos/VibezMac/VibezMac.xcodeproj
```

## Current alpha limitations

- there is no native SoundCloud login flow or official embed integration yet
- Homebrew cask / signing / notarization are still future work
