# VibezMac

Native macOS alpha for vibez.

## What it is

- SwiftUI menu bar app
- opens a dedicated vibez window
- one-time setup screen for server URL, listener name, and current basic auth password
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

- auth credentials are stored in app defaults, not Keychain
- there is no native SoundCloud login flow or official embed integration yet
- Homebrew cask / signing / notarization are still future work
