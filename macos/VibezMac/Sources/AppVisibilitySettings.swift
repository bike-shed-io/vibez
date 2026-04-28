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
        defaults.set(showDockIcon, forKey: Keys.showDockIcon)
        applyActivationPolicy()
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
        defaults.set(showMenuBarIcon, forKey: Keys.showMenuBarIcon)
        return
      }

      defaults.set(showMenuBarIcon, forKey: Keys.showMenuBarIcon)
    }
  }

  private let defaults: UserDefaults

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults

    let storedShowDockIcon = defaults.object(forKey: Keys.showDockIcon) as? Bool ?? true
    let storedShowMenuBarIcon = defaults.object(forKey: Keys.showMenuBarIcon) as? Bool ?? true

    if storedShowDockIcon || storedShowMenuBarIcon {
      self.showDockIcon = storedShowDockIcon
      self.showMenuBarIcon = storedShowMenuBarIcon
      return
    }

    self.showDockIcon = true
    self.showMenuBarIcon = true
    defaults.set(true, forKey: Keys.showDockIcon)
    defaults.set(true, forKey: Keys.showMenuBarIcon)
  }

  func applyActivationPolicy() {
    NSApp.setActivationPolicy(showDockIcon ? .regular : .accessory)
  }

  func clearMessage() {
    message = nil
  }
}
