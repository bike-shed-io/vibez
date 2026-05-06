import AppKit
import SwiftUI

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
        .onOpenURL { url in
          guard url.scheme == "vibez", url.host == "open" else { return }
          NSApp.activate(ignoringOtherApps: true)
          statusBarController?.openMainWindow()
        }
    }
    .defaultSize(width: 470, height: 820)
  }
}
