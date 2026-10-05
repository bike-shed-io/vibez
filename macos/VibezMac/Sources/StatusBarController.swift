import AppKit
import Combine
import SwiftUI

@MainActor
final class StatusBarController: NSObject, NSPopoverDelegate {
  private let appModel: VibezAppModel
  private let router = PopoverRouter()
  private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private let popover = NSPopover()
  private var cancellables = Set<AnyCancellable>()

  init(appModel: VibezAppModel) {
    self.appModel = appModel
    super.init()

    popover.behavior = .transient
    popover.delegate = self
    popover.animates = true
    popover.contentSize = NSSize(width: 390, height: 640)
    popover.contentViewController = NSHostingController(
      rootView: PopoverRootView()
        .environmentObject(appModel)
        .environmentObject(router)
    )

    if let button = statusItem.button {
      button.imagePosition = .imageOnly
      button.action = #selector(handleStatusItemClick(_:))
      button.target = self
      button.sendAction(on: [.leftMouseUp, .rightMouseUp])
    }

    // Keep the popover open while the Google sign-in sheet is up.
    appModel.$isSigningIn
      .sink { [weak self] signingIn in
        self?.popover.behavior = signingIn ? .applicationDefined : .transient
      }
      .store(in: &cancellables)

    appModel.$roles
      .sink { [weak self] roles in
        let symbol = roles.isActiveDj ? "antenna.radiowaves.left.and.right.circle.fill" : "dot.radiowaves.left.and.right"
        self?.statusItem.button?.image = NSImage(systemSymbolName: symbol, accessibilityDescription: "vibez")
      }
      .store(in: &cancellables)
  }

  func showPopover() {
    if !popover.isShown, let button = statusItem.button {
      popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
    }
    NSApp.activate(ignoringOtherApps: true)
  }

  // Every open starts at Channels / Now Playing, not wherever the last visit ended.
  func popoverDidClose(_ notification: Notification) {
    router.path.removeAll()
  }

  @objc private func handleStatusItemClick(_ sender: AnyObject?) {
    if NSApp.currentEvent?.type == .rightMouseUp {
      showContextMenu()
    } else if popover.isShown {
      popover.performClose(sender)
    } else {
      showPopover()
    }
  }

  private func showContextMenu() {
    let menu = NSMenu()
    menu.addItem(menuItem("Open Vibez", #selector(openPopover)))
    menu.addItem(menuItem("Settings…", #selector(openSettings)))
    menu.addItem(.separator())
    menu.addItem(menuItem("Quit Vibez", #selector(quitApp)))

    statusItem.menu = menu
    statusItem.button?.performClick(nil)
    statusItem.menu = nil
  }

  private func menuItem(_ title: String, _ action: Selector) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
    item.target = self
    return item
  }

  @objc private func openPopover() {
    showPopover()
  }

  @objc private func openSettings() {
    router.path = [.settings]
    showPopover()
  }

  @objc private func quitApp() {
    NSApp.terminate(nil)
  }
}
