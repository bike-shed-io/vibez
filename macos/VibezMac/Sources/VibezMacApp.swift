import SwiftUI

@main
struct VibezMacApp: App {
  @StateObject private var appModel = VibezAppModel()

  var body: some Scene {
    Window("Vibez", id: "main") {
      MainWindowView()
        .environmentObject(appModel)
    }
    .defaultSize(width: 470, height: 820)

    MenuBarExtra("vibez", systemImage: "dot.radiowaves.left.and.right") {
      MenuBarContentView()
        .environmentObject(appModel)
    }
    .menuBarExtraStyle(.window)
  }
}
