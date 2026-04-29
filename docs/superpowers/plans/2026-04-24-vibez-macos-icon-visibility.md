# Vibez macOS Icon And Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real macOS app icon and configurable Dock/menu-bar visibility while preserving menu-bar-first workflow.

**Architecture:** Generate an asset catalog from `AppIconSource.png`, configure XcodeGen to use it, and move runtime visibility behavior into a small `AppVisibilitySettings` model shared by the app shell and settings UI. Keep `StatusBarController` responsible only for the menu bar status item and popover.

**Tech Stack:** SwiftUI, AppKit, XcodeGen, Xcode asset catalogs, `sips`, `xcodebuild`.

---

## File Structure

- Modify `macos/VibezMac/project.yml`: add asset catalog source, set app icon name, remove `LSUIElement` so Dock/Cmd-Tab are visible by default.
- Create `macos/VibezMac/Assets.xcassets/Contents.json`: asset catalog root.
- Create `macos/VibezMac/Assets.xcassets/AppIcon.appiconset/Contents.json`: macOS app icon metadata.
- Generate PNGs under `macos/VibezMac/Assets.xcassets/AppIcon.appiconset/` from `macos/VibezMac/Assets/AppIconSource.png`.
- Create `macos/VibezMac/Sources/AppVisibilitySettings.swift`: source of truth for `showDockIcon`, `showMenuBarIcon`, activation policy, and guard against hiding both.
- Modify `macos/VibezMac/Sources/VibezMacApp.swift`: own `AppVisibilitySettings`, pass it into views/controllers, apply visibility on launch.
- Modify `macos/VibezMac/Sources/StatusBarController.swift`: allow showing/hiding/removing the status item without destroying app state.
- Modify `macos/VibezMac/Sources/MainWindowView.swift`: add settings UI section for visibility toggles.
- Modify `macos/VibezMac/Sources/MenuBarContentView.swift`: use visibility settings in right-click/settings flows if needed.
- Modify `docs/roadmap.md`: mark app icon + visibility settings as in-progress/done.

---

### Task 1: Generate macOS App Icon Assets

**Files:**
- Create: `macos/VibezMac/Assets.xcassets/Contents.json`
- Create: `macos/VibezMac/Assets.xcassets/AppIcon.appiconset/Contents.json`
- Create generated PNGs in `macos/VibezMac/Assets.xcassets/AppIcon.appiconset/`

- [ ] **Step 1: Verify source icon exists and dimensions are valid**

Run:

```bash
test -f macos/VibezMac/Assets/AppIconSource.png
sips -g pixelWidth -g pixelHeight macos/VibezMac/Assets/AppIconSource.png
```

Expected: source exists and reports `pixelWidth: 1024`, `pixelHeight: 1024`.

- [ ] **Step 2: Create asset catalog directories**

Run:

```bash
mkdir -p macos/VibezMac/Assets.xcassets/AppIcon.appiconset
```

Expected: command exits 0.

- [ ] **Step 3: Write asset catalog root metadata**

Write `macos/VibezMac/Assets.xcassets/Contents.json`:

```json
{
  "info" : {
    "author" : "xcode",
    "version" : 1
  }
}
```

- [ ] **Step 4: Generate icon PNG variants**

Run:

```bash
SRC="macos/VibezMac/Assets/AppIconSource.png"
OUT="macos/VibezMac/Assets.xcassets/AppIcon.appiconset"
sips -z 16 16 "$SRC" --out "$OUT/icon_16x16.png"
sips -z 32 32 "$SRC" --out "$OUT/icon_16x16@2x.png"
sips -z 32 32 "$SRC" --out "$OUT/icon_32x32.png"
sips -z 64 64 "$SRC" --out "$OUT/icon_32x32@2x.png"
sips -z 128 128 "$SRC" --out "$OUT/icon_128x128.png"
sips -z 256 256 "$SRC" --out "$OUT/icon_128x128@2x.png"
sips -z 256 256 "$SRC" --out "$OUT/icon_256x256.png"
sips -z 512 512 "$SRC" --out "$OUT/icon_256x256@2x.png"
sips -z 512 512 "$SRC" --out "$OUT/icon_512x512.png"
cp "$SRC" "$OUT/icon_512x512@2x.png"
```

Expected: all listed PNG files exist.

- [ ] **Step 5: Write app icon metadata**

Write `macos/VibezMac/Assets.xcassets/AppIcon.appiconset/Contents.json`:

```json
{
  "images" : [
    { "filename" : "icon_16x16.png", "idiom" : "mac", "scale" : "1x", "size" : "16x16" },
    { "filename" : "icon_16x16@2x.png", "idiom" : "mac", "scale" : "2x", "size" : "16x16" },
    { "filename" : "icon_32x32.png", "idiom" : "mac", "scale" : "1x", "size" : "32x32" },
    { "filename" : "icon_32x32@2x.png", "idiom" : "mac", "scale" : "2x", "size" : "32x32" },
    { "filename" : "icon_128x128.png", "idiom" : "mac", "scale" : "1x", "size" : "128x128" },
    { "filename" : "icon_128x128@2x.png", "idiom" : "mac", "scale" : "2x", "size" : "128x128" },
    { "filename" : "icon_256x256.png", "idiom" : "mac", "scale" : "1x", "size" : "256x256" },
    { "filename" : "icon_256x256@2x.png", "idiom" : "mac", "scale" : "2x", "size" : "256x256" },
    { "filename" : "icon_512x512.png", "idiom" : "mac", "scale" : "1x", "size" : "512x512" },
    { "filename" : "icon_512x512@2x.png", "idiom" : "mac", "scale" : "2x", "size" : "512x512" }
  ],
  "info" : {
    "author" : "xcode",
    "version" : 1
  }
}
```

- [ ] **Step 6: Commit icon assets**

Run:

```bash
git add macos/VibezMac/Assets/AppIconSource.png macos/VibezMac/Assets.xcassets
git commit -m "feat: add vibez mac app icon assets"
```

Expected: commit succeeds.

---

### Task 2: Configure Xcode Project For App Icon And Dock Visibility

**Files:**
- Modify: `macos/VibezMac/project.yml`

- [ ] **Step 1: Update XcodeGen project settings**

Modify `macos/VibezMac/project.yml` so the target sources include `Assets.xcassets`, the app icon is named `AppIcon`, and `INFOPLIST_KEY_LSUIElement: YES` is removed.

Expected relevant contents:

```yaml
targets:
  VibezMac:
    type: application
    platform: macOS
    deploymentTarget: "14.0"
    sources:
      - Sources
      - Assets.xcassets
    settings:
      base:
        GENERATE_INFOPLIST_FILE: YES
        INFOPLIST_KEY_CFBundleDisplayName: vibez
        ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon
        CODE_SIGN_STYLE: Automatic
```

- [ ] **Step 2: Regenerate and build**

Run:

```bash
make macos-build
```

Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 3: Verify generated Info.plist references app icon**

Run:

```bash
/usr/libexec/PlistBuddy -c "Print :CFBundleIconName" .build/VibezMac/Build/Products/Debug/Vibez.app/Contents/Info.plist
/usr/libexec/PlistBuddy -c "Print :LSUIElement" .build/VibezMac/Build/Products/Debug/Vibez.app/Contents/Info.plist 2>/dev/null || true
```

Expected: first command prints `AppIcon`; second command prints nothing or exits non-zero because `LSUIElement` is absent.

- [ ] **Step 4: Commit project configuration**

Run:

```bash
git add macos/VibezMac/project.yml
git commit -m "feat: show vibez mac app in dock by default"
```

Expected: commit succeeds.

---

### Task 3: Add Visibility Settings Model

**Files:**
- Create: `macos/VibezMac/Sources/AppVisibilitySettings.swift`

- [ ] **Step 1: Create visibility settings model**

Write `macos/VibezMac/Sources/AppVisibilitySettings.swift`:

```swift
import AppKit
import Foundation

@MainActor
final class AppVisibilitySettings: ObservableObject {
  private enum Keys {
    static let showDockIcon = "vibez.macos.showDockIcon"
    static let showMenuBarIcon = "vibez.macos.showMenuBarIcon"
  }

  @Published var message: String?

  @Published var showDockIcon: Bool {
    didSet {
      guard showDockIcon || showMenuBarIcon else {
        showDockIcon = true
        message = "Vibez must stay visible in either the Dock or the menu bar."
        return
      }
      defaults.set(showDockIcon, forKey: Keys.showDockIcon)
      applyActivationPolicy()
    }
  }

  @Published var showMenuBarIcon: Bool {
    didSet {
      guard showDockIcon || showMenuBarIcon else {
        showMenuBarIcon = true
        message = "Vibez must stay visible in either the Dock or the menu bar."
        return
      }
      defaults.set(showMenuBarIcon, forKey: Keys.showMenuBarIcon)
    }
  }

  private let defaults: UserDefaults

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    self.showDockIcon = defaults.object(forKey: Keys.showDockIcon) as? Bool ?? true
    self.showMenuBarIcon = defaults.object(forKey: Keys.showMenuBarIcon) as? Bool ?? true
    applyActivationPolicy()
  }

  func applyActivationPolicy() {
    NSApp.setActivationPolicy(showDockIcon ? .regular : .accessory)
  }

  func clearMessage() {
    message = nil
  }
}
```

- [ ] **Step 2: Typecheck**

Run:

```bash
xcrun swiftc -typecheck -sdk "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX26.4.sdk" -target arm64-apple-macos14.0 -parse-as-library macos/VibezMac/Sources/*.swift
```

Expected: no output, exit 0.

- [ ] **Step 3: Commit settings model**

Run:

```bash
git add macos/VibezMac/Sources/AppVisibilitySettings.swift
git commit -m "feat: add mac app visibility settings model"
```

Expected: commit succeeds.

---

### Task 4: Wire Status Item Visibility

**Files:**
- Modify: `macos/VibezMac/Sources/StatusBarController.swift`
- Modify: `macos/VibezMac/Sources/VibezMacApp.swift`

- [ ] **Step 1: Make status item removable/recreatable**

Modify `StatusBarController` so `statusItem` is optional and add `setVisible(_:)`.

Expected implementation shape:

```swift
@MainActor
final class StatusBarController: NSObject {
  private let appModel: VibezAppModel
  private let visibilitySettings: AppVisibilitySettings
  private var statusItem: NSStatusItem?
  private let popover: NSPopover

  init(appModel: VibezAppModel, visibilitySettings: AppVisibilitySettings) {
    self.appModel = appModel
    self.visibilitySettings = visibilitySettings
    self.popover = NSPopover()
    super.init()

    configurePopover()
    setVisible(visibilitySettings.showMenuBarIcon)
  }

  func setVisible(_ isVisible: Bool) {
    if isVisible {
      if statusItem == nil {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        configureStatusItem()
      }
    } else if let statusItem {
      popover.performClose(nil)
      NSStatusBar.system.removeStatusItem(statusItem)
      self.statusItem = nil
    }
  }
}
```

Keep the existing click, popover, and context menu behavior. Update every `statusItem.button` access to handle optional `statusItem`.

- [ ] **Step 2: Own visibility settings in app shell**

Modify `VibezMacApp.swift` to create and pass `AppVisibilitySettings`.

Expected implementation shape:

```swift
@main
struct VibezMacApp: App {
  @NSApplicationDelegateAdaptor(VibezAppDelegate.self) private var appDelegate

  @StateObject private var appModel = VibezAppModel()
  @StateObject private var visibilitySettings = AppVisibilitySettings()
  @State private var statusBarController: StatusBarController?

  var body: some Scene {
    Window("Vibez", id: "main") {
      MainWindowView()
        .environmentObject(appModel)
        .environmentObject(visibilitySettings)
        .onAppear {
          visibilitySettings.applyActivationPolicy()
          if statusBarController == nil {
            statusBarController = StatusBarController(appModel: appModel, visibilitySettings: visibilitySettings)
          }
          statusBarController?.setVisible(visibilitySettings.showMenuBarIcon)
        }
        .onChange(of: visibilitySettings.showMenuBarIcon) { _, isVisible in
          statusBarController?.setVisible(isVisible)
        }
        .onChange(of: visibilitySettings.showDockIcon) { _, _ in
          visibilitySettings.applyActivationPolicy()
        }
    }
    .defaultSize(width: 470, height: 820)
  }
}
```

- [ ] **Step 3: Build**

Run:

```bash
make macos-build
```

Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 4: Commit wiring**

Run:

```bash
git add macos/VibezMac/Sources/StatusBarController.swift macos/VibezMac/Sources/VibezMacApp.swift
git commit -m "feat: support menu bar visibility setting"
```

Expected: commit succeeds.

---

### Task 5: Add Visibility Controls To Settings UI

**Files:**
- Modify: `macos/VibezMac/Sources/MainWindowView.swift`

- [ ] **Step 1: Inject visibility settings into main window**

Add this property near existing environment objects:

```swift
@EnvironmentObject private var visibilitySettings: AppVisibilitySettings
```

- [ ] **Step 2: Add settings card to main client stack**

Modify `mainClient` stack to include a settings card after `listenerMixCard`:

```swift
VStack(alignment: .leading, spacing: 18) {
  header
  nowPlayingCard
  listenerMixCard
  appSettingsCard
  djCard
  listenersCard
}
```

- [ ] **Step 3: Add app settings card**

Add this view to `MainWindowView`:

```swift
private var appSettingsCard: some View {
  card {
    VStack(alignment: .leading, spacing: 14) {
      Text("App Settings")
        .font(.caption.weight(.semibold))
        .textCase(.uppercase)
        .foregroundStyle(.secondary)

      Toggle("Show Dock icon", isOn: $visibilitySettings.showDockIcon)
      Toggle("Show menu bar icon", isOn: $visibilitySettings.showMenuBarIcon)

      Text("Keep at least one access point enabled so Vibez does not disappear.")
        .font(.caption)
        .foregroundStyle(.secondary)

      if let message = visibilitySettings.message {
        Text(message)
          .font(.caption)
          .foregroundStyle(.orange)
      }
    }
  }
}
```

- [ ] **Step 4: Clear inline warning when settings view appears**

Add `.onAppear { visibilitySettings.clearMessage() }` to `appSettingsCard` outer `VStack` or card content.

Expected final `appSettingsCard` includes:

```swift
.onAppear {
  visibilitySettings.clearMessage()
}
```

- [ ] **Step 5: Build and run**

Run:

```bash
make macos-run
```

Expected: build succeeds, app launches.

- [ ] **Step 6: Manual test settings behavior**

Test:

```text
1. Verify Vibez appears in Dock and Cmd-Tab by default.
2. Verify menu bar icon is visible by default.
3. Turn off Show Dock icon: Dock icon disappears, menu bar remains.
4. Turn Show Dock icon back on: Dock icon returns.
5. Turn off Show menu bar icon: menu bar icon disappears, Dock remains.
6. Try to turn both off: one toggle re-enables and message appears.
```

- [ ] **Step 7: Commit settings UI**

Run:

```bash
git add macos/VibezMac/Sources/MainWindowView.swift
git commit -m "feat: add mac app visibility settings"
```

Expected: commit succeeds.

---

### Task 6: Update Docs And Final Verification

**Files:**
- Modify: `docs/roadmap.md`

- [ ] **Step 1: Update roadmap current state**

Modify `docs/roadmap.md` near native app bullets to include:

```markdown
- Native macOS app: SwiftUI menu bar + Dock app in `macos/VibezMac`.
- App visibility: Dock and menu bar are both visible by default; users may hide either one in settings, but not both.
```

- [ ] **Step 2: Run final build checks**

Run:

```bash
node --check public/radio.js
xcrun swiftc -typecheck -sdk "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX26.4.sdk" -target arm64-apple-macos14.0 -parse-as-library macos/VibezMac/Sources/*.swift
make macos-build
```

Expected: JS check succeeds, Swift typecheck exits 0, Xcode build prints `** BUILD SUCCEEDED **`.

- [ ] **Step 3: Commit docs**

Run:

```bash
git add docs/roadmap.md
git commit -m "docs: update mac app visibility roadmap"
```

Expected: commit succeeds.

- [ ] **Step 4: Push source repo**

Run:

```bash
git push origin main
```

Expected: push succeeds.

- [ ] **Step 5: Stop before release**

Do not create a `vibez-mac` release until the user manually tests the local app and explicitly says to release.

---

## Self-Review

- Spec coverage: app icon generation, Dock/Cmd-Tab default visibility, retained menu bar, settings toggles, prevention of hiding both, red close behavior, and validation are all covered.
- Placeholder scan: no `TBD`, `TODO`, or vague implementation steps remain.
- Type consistency: `AppVisibilitySettings`, `StatusBarController.setVisible(_:)`, `showDockIcon`, and `showMenuBarIcon` names are used consistently across tasks.
