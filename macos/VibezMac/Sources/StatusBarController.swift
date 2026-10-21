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

    Publishers.CombineLatest3(appModel.$roles, appModel.$directory, appModel.$currentChannel)
      .map { roles, directory, channel -> MenuBarIcon.State in
        if roles.isActiveDj { return .dj }
        return channel == nil && !directory.isEmpty ? .someoneLive : .idle
      }
      .removeDuplicates()
      .sink { [weak self] state in self?.statusItem.button?.image = MenuBarIcon.image(state) }
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
    if appModel.videoId != nil, appModel.videoHidden {
      menu.addItem(menuItem("Show video", #selector(showVideo)))
    }
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

  @objc private func showVideo() {
    appModel.showVideo()
  }

  @objc private func quitApp() {
    NSApp.terminate(nil)
  }
}

// The app icon's V of sound bars, drawn as a template image so it takes the menu bar's colors.
enum MenuBarIcon {
  enum State { case idle, someoneLive, dj }

  // Left half of the V as (centre y, length) in a unit box; mirrored around the last, lowest bar.
  private static let halfV: [(y: CGFloat, length: CGFloat)] = [(0.69, 0.26), (0.70, 0.56), (0.52, 0.56), (0.34, 0.44), (0.18, 0.34)]

  static func image(_ state: State) -> NSImage {
    let bars = halfV + Array(halfV.dropLast().reversed())
    let height: CGFloat = 16, barWidth: CGFloat = 1.6, gap: CGFloat = 1.1
    let pad: CGFloat = state == .dj ? 3 : 0 // room for the DJ box around the V
    let vWidth = CGFloat(bars.count) * barWidth + CGFloat(bars.count - 1) * gap
    let width = vWidth + 2 * pad + (state == .someoneLive ? 4 : 0)

    let image = NSImage(size: NSSize(width: width, height: height), flipped: false) { rect in
      NSColor.black.set()
      if state == .dj {
        NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: vWidth + 2 * pad, height: height), xRadius: 4, yRadius: 4).fill()
        NSGraphicsContext.current?.compositingOperation = .destinationOut // the V is cut out of the box
      }
      let inner = height - 2 * pad
      for (i, bar) in bars.enumerated() {
        let barHeight = max(barWidth, bar.length * inner)
        let x = pad + CGFloat(i) * (barWidth + gap)
        let y = pad + bar.y * inner - barHeight / 2
        NSBezierPath(roundedRect: NSRect(x: x, y: y, width: barWidth, height: barHeight), xRadius: barWidth / 2, yRadius: barWidth / 2).fill()
      }
      NSGraphicsContext.current?.compositingOperation = .sourceOver
      if state == .someoneLive {
        NSBezierPath(ovalIn: NSRect(x: rect.width - 4.5, y: rect.height - 4.5, width: 4.5, height: 4.5)).fill()
      }
      return true
    }
    image.isTemplate = true
    image.accessibilityDescription = switch state {
    case .idle: "Vibez"
    case .someoneLive: "Vibez, someone is live"
    case .dj: "Vibez, you are live"
    }
    return image
  }
}
