import SwiftUI

@main
struct VibezMacApp: App {
  @NSApplicationDelegateAdaptor(VibezAppDelegate.self) private var appDelegate

  @StateObject private var appModel = VibezAppModel()
  @State private var statusBarController: StatusBarController?

  var body: some Scene {
    Window("Vibez", id: "main") {
      MainWindowView()
        .environmentObject(appModel)
        .onAppear {
          if statusBarController == nil {
            statusBarController = StatusBarController(appModel: appModel)
          }
        }
    }
    .defaultSize(width: 470, height: 820)
  }
}
