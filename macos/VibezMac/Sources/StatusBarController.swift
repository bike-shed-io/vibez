import AppKit
import SwiftUI

@MainActor
final class StatusBarController: NSObject {
  private let appModel: VibezAppModel
  private let statusItem: NSStatusItem
  private let popover: NSPopover

  init(appModel: VibezAppModel) {
    self.appModel = appModel
    self.statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    self.popover = NSPopover()
    super.init()

    configurePopover()
    configureStatusItem()
  }

  private func configurePopover() {
    popover.behavior = .transient
    popover.animates = true
    popover.contentSize = NSSize(width: 390, height: 640)
    popover.contentViewController = NSHostingController(
      rootView: MenuBarContentView()
        .environmentObject(appModel)
    )
  }

  private func configureStatusItem() {
    guard let button = statusItem.button else { return }
    button.image = NSImage(systemSymbolName: "dot.radiowaves.left.and.right", accessibilityDescription: "vibez")
    button.imagePosition = .imageOnly
    button.action = #selector(handleStatusItemClick(_:))
    button.target = self
    button.sendAction(on: [.leftMouseUp, .rightMouseUp])
  }

  @objc private func handleStatusItemClick(_ sender: AnyObject?) {
    guard let event = NSApp.currentEvent else {
      togglePopover(sender)
      return
    }

    if event.type == .rightMouseUp {
      showContextMenu()
      return
    }

    togglePopover(sender)
  }

  private func togglePopover(_ sender: AnyObject?) {
    guard let button = statusItem.button else { return }

    if popover.isShown {
      popover.performClose(sender)
      return
    }

    popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
    NSApp.activate(ignoringOtherApps: true)
  }

  private func showContextMenu() {
    let menu = NSMenu()

    let openItem = NSMenuItem(title: "Open Vibez", action: #selector(openMainWindow), keyEquivalent: "")
    openItem.target = self
    menu.addItem(openItem)

    let settingsItem = NSMenuItem(title: "Open Settings", action: #selector(openSettings), keyEquivalent: "")
    settingsItem.target = self
    menu.addItem(settingsItem)

    menu.addItem(.separator())

    let quitItem = NSMenuItem(title: "Quit Vibez", action: #selector(quitApp), keyEquivalent: "")
    quitItem.target = self
    menu.addItem(quitItem)

    statusItem.menu = menu
    statusItem.button?.performClick(nil)
    statusItem.menu = nil
  }

  @objc private func openMainWindow() {
    popover.performClose(nil)
    NSApp.activate(ignoringOtherApps: true)

    if let window = NSApp.windows.first(where: { $0.identifier?.rawValue == "main" }) ??
      NSApp.windows.first(where: { $0.title == "Vibez" }) {
      window.makeKeyAndOrderFront(nil)
      return
    }

    NSApp.arrangeInFront(nil)
  }

  @objc private func openSettings() {
    openMainWindow()
    NotificationCenter.default.post(name: .vibezOpenSetupRequested, object: nil)
  }

  @objc private func quitApp() {
    NSApp.terminate(nil)
  }
}
