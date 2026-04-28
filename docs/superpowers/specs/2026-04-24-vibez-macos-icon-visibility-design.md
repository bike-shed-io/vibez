# Vibez macOS Icon And Visibility Design

## Goal

Make the native Vibez app feel like a normal macOS app while preserving its menu bar workflow.

## Current Problem

- Vibez currently behaves like a menu-bar-only agent because `LSUIElement` is enabled.
- That hides Vibez from the Dock and Cmd-Tab app switcher.
- The app has no configured app icon asset catalog.
- When the menu bar is crowded, users can lose access to Vibez because there is no Dock/Cmd-Tab fallback.

## Approved Direction

- Use `macos/VibezMac/Assets/AppIconSource.png` as the source icon.
- Generate a proper macOS `AppIcon.appiconset` from that source image.
- Make Vibez visible in Dock and Cmd-Tab by default.
- Keep the menu bar status item visible by default.
- Add Settings controls for visibility:
  - `Show Dock icon`
  - `Show menu bar icon`
- Prevent users from disabling both visibility surfaces at the same time.
- Keep red close behavior: hide the main window instead of quitting.
- Keep right-click status item menu with `Open Vibez`, `Open Settings`, and `Quit Vibez`.

## UX Rules

- Default state: Dock icon on, menu bar icon on.
- If Dock is hidden, Vibez remains accessible through the menu bar.
- If menu bar is hidden, Vibez remains accessible through Dock/Cmd-Tab.
- If a user attempts to disable the last visible surface, keep it enabled and show a clear inline explanation.
- `Quit Vibez` remains the only intentional full app termination path.

## Implementation Notes

- Remove `INFOPLIST_KEY_LSUIElement: YES` from `macos/VibezMac/project.yml` so the app is regular by default.
- Add asset catalog support to the XcodeGen project and set `ASSETCATALOG_COMPILER_APPICON_NAME` to `AppIcon`.
- Generate required icon PNG sizes from `Assets/AppIconSource.png` into `Assets.xcassets/AppIcon.appiconset`.
- Store visibility settings locally with `AppStorage` / `UserDefaults`.
- Use `NSApp.setActivationPolicy(.regular)` when Dock visibility is enabled.
- Use `NSApp.setActivationPolicy(.accessory)` when Dock visibility is disabled.
- Show/hide the custom `StatusBarController` status item when menu bar visibility changes.

## Validation

- `make macos-build` succeeds.
- App appears in Dock and Cmd-Tab by default.
- App icon appears in Dock and Cmd-Tab.
- Menu bar icon remains available by default.
- Red close hides the main window and leaves the app running.
- Right-click menu can still quit the app.
- Visibility settings cannot disable both Dock and menu bar access.

## Out Of Scope

- New GPT image generation.
- Notarization/signing improvements.
- Cutting a Homebrew release unless explicitly requested.
