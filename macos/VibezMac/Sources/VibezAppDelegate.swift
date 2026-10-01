import AppKit

@MainActor
final class VibezAppDelegate: NSObject, NSApplicationDelegate {
  let appModel = VibezAppModel()
  private var statusBar: StatusBarController?

  // "Will", not "did": a vibez:// URL that launches the app arrives before didFinishLaunching.
  func applicationWillFinishLaunching(_ notification: Notification) {
    statusBar = StatusBarController(appModel: appModel)
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    false
  }

  func application(_ application: NSApplication, open urls: [URL]) {
    for url in urls where url.scheme == "vibez" {
      // vibez://channel/<id> joins that channel; vibez://open just shows the popover
      if url.host() == "channel", let id = url.pathComponents.dropFirst().first {
        appModel.openChannelLink(id: id)
      }
      statusBar?.showPopover()
    }
  }
}
