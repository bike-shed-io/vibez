# Native Deep Link Slack Buttons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Slack notifications prefer opening Vibez for Mac via `vibez://open`, while keeping a web fallback button.

**Architecture:** Register a macOS URL scheme in XcodeGen and handle it in the SwiftUI app shell by focusing the main window. Update Slack webhook payload generation to include two action buttons: native app primary and web fallback.

**Tech Stack:** SwiftUI, AppKit, XcodeGen, Bun, TypeScript, Slack Incoming Webhooks, Homebrew cask release.

---

## File Structure

- Modify `macos/VibezMac/project.yml`: add `CFBundleURLTypes` for scheme `vibez`.
- Modify `macos/VibezMac/Sources/VibezMacApp.swift`: add `.onOpenURL` handling and call a status/window controller helper.
- Modify `macos/VibezMac/Sources/StatusBarController.swift`: expose an `openMainWindow()` helper so URL handling can focus the window.
- Modify `src/notifications.ts`: generate Slack messages with two buttons.
- Modify `src/notifications.test.ts`: assert Slack payload contains `Open Vibez App` and `Open Web` buttons.
- Modify docs if the implementation needs extra operational notes.

---

### Task 1: Register And Handle Native URL Scheme

**Files:**
- Modify: `macos/VibezMac/project.yml`
- Modify: `macos/VibezMac/Sources/VibezMacApp.swift`
- Modify: `macos/VibezMac/Sources/StatusBarController.swift`

- [ ] **Step 1: Add URL scheme to XcodeGen**

Modify `macos/VibezMac/project.yml` under target base settings:

```yaml
        INFOPLIST_KEY_CFBundleURLTypes:
          - CFBundleURLName: io.bike-shed.vibez.mac
            CFBundleURLSchemes:
              - vibez
```

- [ ] **Step 2: Make `openMainWindow` callable**

In `macos/VibezMac/Sources/StatusBarController.swift`, change:

```swift
@objc private func openMainWindow()
```

to:

```swift
@objc func openMainWindow()
```

Keep behavior unchanged.

- [ ] **Step 3: Add URL handling in app shell**

In `macos/VibezMac/Sources/VibezMacApp.swift`, add this modifier to the `MainWindowView()` chain:

```swift
.onOpenURL { url in
  guard url.scheme == "vibez", url.host == "open" else { return }
  NSApp.activate(ignoringOtherApps: true)
  statusBarController?.openMainWindow()
}
```

If Swift requires `AppKit`, add `import AppKit` to `VibezMacApp.swift`.

- [ ] **Step 4: Verify URL scheme in built Info.plist**

Run:

```bash
make macos-build
/usr/libexec/PlistBuddy -c "Print :CFBundleURLTypes:0:CFBundleURLSchemes:0" .build/VibezMac/Build/Products/Debug/Vibez.app/Contents/Info.plist
```

Expected: build succeeds and PlistBuddy prints `vibez`.

- [ ] **Step 5: Manual local deep-link check**

Run:

```bash
pkill -x Vibez || true
open .build/VibezMac/Build/Products/Debug/Vibez.app
sleep 2
open 'vibez://open'
```

Expected: Vibez opens/focuses. Manual visual confirmation required.

- [ ] **Step 6: Commit**

Run:

```bash
git add macos/VibezMac/project.yml macos/VibezMac/Sources/VibezMacApp.swift macos/VibezMac/Sources/StatusBarController.swift
git commit -m "feat: add native Vibez deep link"
```

---

### Task 2: Add Native And Web Buttons To Slack Payloads

**Files:**
- Modify: `src/notifications.ts`
- Modify: `src/notifications.test.ts`

- [ ] **Step 1: Add failing payload tests**

Append to `src/notifications.test.ts`:

```ts
test("Slack notification payload includes native app and web buttons", async () => {
  const sent: any[] = [];
  const service = createNotificationService({
    webhookUrl: "https://hooks.slack.com/services/test",
    radioUrl: "https://vibez.bike-shed.io",
    postJson: async (_url, payload) => {
      sent.push(payload);
    },
  });

  await service.notifyDjStarted("Patrick");

  const actions = sent[0].blocks.find((block: any) => block.type === "actions");
  expect(actions.elements.map((element: any) => element.text.text)).toEqual([
    "Open Vibez App",
    "Open Web",
  ]);
  expect(actions.elements.map((element: any) => element.url)).toEqual([
    "vibez://open",
    "https://vibez.bike-shed.io",
  ]);
});
```

- [ ] **Step 2: Verify test fails**

Run:

```bash
docker run --rm -v "$PWD:/app" -w /app oven/bun:1 sh -lc 'bun test src/notifications.test.ts'
```

Expected: FAIL because only one `Open Vibez` button exists.

- [ ] **Step 3: Update payload generation**

In `src/notifications.ts`, update the `slackMessage` action elements to:

```ts
elements: [
  {
    type: "button",
    text: { type: "plain_text", text: "Open Vibez App" },
    url: "vibez://open",
    action_id: "open_vibez_app",
  },
  {
    type: "button",
    text: { type: "plain_text", text: "Open Web" },
    url: radioUrl,
    action_id: "open_vibez_web",
  },
],
```

- [ ] **Step 4: Verify tests pass**

Run:

```bash
docker run --rm -v "$PWD:/app" -w /app oven/bun:1 sh -lc 'bun test src/notifications.test.ts'
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/notifications.ts src/notifications.test.ts
git commit -m "feat: add native app button to Slack notifications"
```

---

### Task 3: Verify, Push, Deploy Backend

**Files:**
- No source changes expected.

- [ ] **Step 1: Run verification**

Run:

```bash
docker run --rm -v "$PWD:/app" -w /app oven/bun:1 sh -lc 'bun test src/notifications.test.ts'
node --check public/radio.js
make macos-build
```

Expected: tests pass, JS syntax passes, macOS build succeeds.

- [ ] **Step 2: Push source repo**

Run:

```bash
git push origin main
```

Expected: push succeeds.

- [ ] **Step 3: Deploy backend**

Run:

```bash
OP_ACCOUNT=my.1password.eu bash scripts/deploy.sh
```

Expected: deploy completes and container is running.

- [ ] **Step 4: Verify production**

Run:

```bash
PASS=$(op --account my.1password.eu read 'op://infra/vibez/auth-password') && curl -I --max-time 15 -u ":$PASS" https://vibez.bike-shed.io
```

Expected: HTTP 200.

---

### Task 4: Release Vibez For Mac

**Files:**
- Modify in tap repo `/Users/patrick/Development/homebrew-vibez`:
  - `Casks/vibez.rb`
  - `Casks/vibez-mac.rb`

- [ ] **Step 1: Build release artifact**

Run in source repo:

```bash
xcodegen generate --spec macos/VibezMac/project.yml
xcodebuild -project macos/VibezMac/VibezMac.xcodeproj -scheme VibezMac -configuration Release -derivedDataPath .build/VibezMac build
ditto -c -k --sequesterRsrc --keepParent ".build/VibezMac/Build/Products/Release/Vibez.app" "/tmp/Vibez-macos-arm64.zip"
shasum -a 256 "/tmp/Vibez-macos-arm64.zip"
```

Expected: build succeeds and SHA is printed.

- [ ] **Step 2: Create next GitHub release**

Use next version after current latest. If current latest is `v0.1.3`, use `v0.1.4`.

Run:

```bash
gh release create v0.1.4 "/tmp/Vibez-macos-arm64.zip" --repo bike-shed-io/homebrew-vibez --title "v0.1.4" --notes "Vibez for Mac update with native deep link support for Slack notifications."
```

- [ ] **Step 3: Bump casks**

In `/Users/patrick/Development/homebrew-vibez/Casks/vibez.rb` and `Casks/vibez-mac.rb`, update:

```ruby
version "0.1.4"
sha256 "<printed-sha>"
```

- [ ] **Step 4: Verify and push tap**

Run in tap repo:

```bash
ruby -c Casks/vibez.rb && ruby -c Casks/vibez-mac.rb
git add Casks/vibez.rb Casks/vibez-mac.rb
git commit -m "chore: release vibez for mac v0.1.4"
git push origin main
brew update
brew info --cask vibez
```

Expected: cask shows `0.1.4`.

---

### Task 5: Slack Smoke Test

**Files:**
- No source changes expected.

- [ ] **Step 1: Trigger notification**

Run:

```bash
node -e 'const name = "Deep Link Smoke "+Math.random().toString(36).slice(2,6); const ws = new WebSocket("wss://vibez.bike-shed.io/ws"); ws.onopen=()=>{console.log("open", name); ws.send(JSON.stringify({type:"join", name})); setTimeout(()=>{console.log("claim"); ws.send(JSON.stringify({type:"dj:claim"}));}, 1000); setTimeout(()=>{console.log("release"); ws.send(JSON.stringify({type:"dj:release"}));}, 4000); setTimeout(()=>ws.close(), 6000);}; ws.onmessage=(event)=>console.log("msg", event.data.toString()); ws.onerror=(event)=>console.log("error", event.message || event.toString()); ws.onclose=(event)=>console.log("close", event.code, event.reason);'
```

- [ ] **Step 2: Manual Slack test**

Expected:

```text
- Slack notification shows two buttons: Open Vibez App, Open Web.
- Open Vibez App opens/focuses native app if installed/upgraded.
- Open Web opens https://vibez.bike-shed.io.
```

---

## Self-Review

- Spec coverage: native scheme, URL handling, Slack two-button payload, backend deploy, Mac release, and Slack smoke test are covered.
- Placeholder scan: no placeholders remain except `<printed-sha>` in the cask bump instruction, which is intentionally produced by Task 4 Step 1.
- Type consistency: `vibez://open`, `open_vibez_app`, `open_vibez_web`, and release version `0.1.4` are consistently used.
