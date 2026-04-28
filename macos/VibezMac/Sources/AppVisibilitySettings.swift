import AppKit
import Combine
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
