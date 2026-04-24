import AppKit

@MainActor
final class HideOnCloseWindowDelegate: NSObject, NSWindowDelegate {
  static let shared = HideOnCloseWindowDelegate()

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    sender.orderOut(nil)
    return false
  }
}
