import AppKit
import WebKit

/// Floating panel hosting `<serverURL>/yt-player.html`, the YouTube embed the Mac app controls through
/// `window.vibez` and listens to through the `vibez` script message handler.
@MainActor
final class VideoOverlay: NSObject, WKScriptMessageHandler, NSWindowDelegate {
  var onTime: ((_ positionMs: Double, _ durationMs: Double) -> Void)?
  var onEnded: (() -> Void)?
  var onError: ((_ code: Int) -> Void)?
  /// The user closed the panel (not a programmatic `close()`).
  var onClosed: (() -> Void)?

  private static let defaultSize = NSSize(width: 356, height: 200)

  private var panel: NSPanel?
  private var webView: WKWebView?
  private var pageURL: URL?
  private var ready = false
  private var pending: [String] = []

  var isVisible: Bool { panel?.isVisible ?? false }

  func show(serverURL: URL) {
    if panel == nil { makePanel() }
    let url = serverURL.appending(path: "yt-player.html")
    if pageURL != url {
      pageURL = url
      ready = false
      pending.removeAll()
      webView?.load(URLRequest(url: url))
    }
    panel?.orderFrontRegardless()
  }

  func close() {
    unloadPage()
    panel?.orderOut(nil)
  }

  func load(videoId: String, positionMs: Double, timestamp: Double, playing: Bool) {
    // Only [A-Za-z0-9_-] can be a YouTube id; strip anything else rather than quote it into JS.
    let safeId = videoId.filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
    call("load(\"\(safeId)\", \(Int(positionMs)), \(Int(timestamp)), \(playing))")
  }

  func play(positionMs: Double, timestamp: Double) {
    call("play(\(Int(positionMs)), \(Int(timestamp)))")
  }

  func pause(positionMs: Double) {
    call("pause(\(Int(positionMs)))")
  }

  func seek(positionMs: Double, timestamp: Double) {
    call("seek(\(Int(positionMs)), \(Int(timestamp)))")
  }

  /// 0...1, the same live volume AVPlayer gets (base volume moved by the room vibez).
  func setVolume(_ level: Double) {
    call("setVolume(\(max(0, min(1, level))))")
  }

  // Calls made before the page says `ready` are replayed in order; calls with no page loaded are dropped.
  private func call(_ expression: String) {
    guard pageURL != nil else { return }
    let script = "window.vibez.\(expression)"
    guard ready else {
      pending.append(script)
      return
    }
    webView?.evaluateJavaScript(script, completionHandler: nil)
  }

  private func unloadPage() {
    pageURL = nil
    ready = false
    pending.removeAll()
    webView?.load(URLRequest(url: URL(string: "about:blank")!)) // stops playback
  }

  private func makePanel() {
    let configuration = WKWebViewConfiguration()
    configuration.mediaTypesRequiringUserActionForPlayback = []
    configuration.userContentController.add(self, name: "vibez")
    let webView = WKWebView(frame: NSRect(origin: .zero, size: Self.defaultSize), configuration: configuration)
    self.webView = webView

    let panel = NSPanel(
      contentRect: NSRect(origin: .zero, size: Self.defaultSize),
      styleMask: [.titled, .closable, .resizable, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    panel.title = "Vibez"
    panel.level = .floating
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.hidesOnDeactivate = false // a menu bar app is rarely the active app
    panel.isReleasedWhenClosed = false
    panel.contentAspectRatio = NSSize(width: 16, height: 9)
    panel.contentMinSize = Self.defaultSize
    panel.contentView = webView
    panel.delegate = self
    if let visible = NSScreen.main?.visibleFrame {
      panel.setFrameOrigin(NSPoint(x: visible.maxX - panel.frame.width - 16, y: visible.maxY - panel.frame.height - 16))
    }
    panel.setFrameAutosaveName("VibezVideoOverlay") // restores the last position if there is one
    self.panel = panel
  }

  // MARK: NSWindowDelegate

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    close()
    onClosed?()
    return false // keep the panel around for "Show video"
  }

  // MARK: WKScriptMessageHandler

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
    switch type {
    case "ready":
      ready = true
      for script in pending {
        webView?.evaluateJavaScript(script, completionHandler: nil)
      }
      pending.removeAll()
    case "time":
      guard let position = body["positionMs"] as? NSNumber else { return }
      onTime?(position.doubleValue, (body["durationMs"] as? NSNumber)?.doubleValue ?? 0)
    case "ended":
      onEnded?()
    case "error":
      onError?((body["code"] as? NSNumber)?.intValue ?? 0)
    default:
      break // "state" is informational; the room position is the source of truth
    }
  }
}
