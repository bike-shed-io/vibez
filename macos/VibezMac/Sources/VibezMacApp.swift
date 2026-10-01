import SwiftUI

@main
struct VibezMacApp: App {
  @NSApplicationDelegateAdaptor(VibezAppDelegate.self) private var appDelegate

  var body: some Scene {
    Settings { EmptyView() } // menu-bar-only app: no windows
  }
}
