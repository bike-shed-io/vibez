import AVFoundation
import Foundation

@MainActor
final class VibezAppModel: NSObject, ObservableObject {
  enum ConnectionState {
    case setupRequired
    case connecting
    case connected
    case disconnected
  }

  private static let configurationKey = "vibez.macos.configuration"
  private static let volumeKey = "vibez.macos.baseVolume"
  private static let rangeKey = "vibez.macos.vibezRange"

  @Published private(set) var configuration: VibezConfiguration?
  @Published private(set) var connectionState: ConnectionState = .setupRequired

  @Published var trackDraftURL = ""
  @Published private(set) var trackTitle: String?
  @Published private(set) var trackArtworkURL: URL?
  @Published private(set) var trackURLString: String?
  @Published private(set) var djName: String?
  @Published private(set) var listeners: [String] = []
  @Published private(set) var errorMessage: String?
  @Published private(set) var isPlaying = false
  @Published private(set) var hasTrack = false
  @Published private(set) var currentTime: Double = 0
  @Published private(set) var duration: Double = 0
  @Published private(set) var isDJ = false
  @Published var vibezLevel: Double = 0 {
    didSet {
      if vibezLevel < -1 || vibezLevel > 1 || !vibezLevel.isFinite {
        vibezLevel = clampSigned(vibezLevel)
        return
      }
      applyVolume()
    }
  }
  @Published var baseVolume: Double {
    didSet {
      if baseVolume < 0 || baseVolume > 1 || !baseVolume.isFinite {
        baseVolume = clampUnit(baseVolume)
        return
      }
      defaults.set(baseVolume, forKey: Self.volumeKey)
      applyVolume()
    }
  }
  @Published var vibezRange: Double {
    didSet {
      if vibezRange < 0 || vibezRange > 1 || !vibezRange.isFinite {
        vibezRange = clampUnit(vibezRange)
        return
      }
      defaults.set(vibezRange, forKey: Self.rangeKey)
      applyVolume()
    }
  }

  private let defaults = UserDefaults.standard
  private lazy var urlSession = URLSession(configuration: .default)
  private let player = AVPlayer()

  private var webSocketTask: URLSessionWebSocketTask?
  private var receiveTask: Task<Void, Never>?
  private var reconnectTask: Task<Void, Never>?
  private var heartbeatTask: Task<Void, Never>?
  private var timeObserverToken: Any?
  private var refreshPosition = 0.0
  private var currentStreamURLString: String?

  override init() {
    self.baseVolume = defaults.object(forKey: Self.volumeKey) as? Double ?? 0.8
    self.vibezRange = defaults.object(forKey: Self.rangeKey) as? Double ?? 0.2
    super.init()
    configurePlayer()
    loadPersistedConfiguration()
  }

  var listenerName: String {
    configuration?.listenerName ?? "Listener"
  }

  var isRoomConnected: Bool {
    connectionState == .connected && webSocketTask != nil
  }

  var connectionLabel: String {
    switch connectionState {
    case .setupRequired:
      return "Setup required"
    case .connecting:
      return "Connecting…"
    case .connected:
      return "Connected"
    case .disconnected:
      return "Reconnecting…"
    }
  }

  var displayTrackTitle: String {
    if let trackTitle, !trackTitle.isEmpty { return trackTitle }
    if hasTrack { return "Untitled Track" }
    return "No track playing"
  }

  var listenerSummary: String {
    let count = listeners.count
    return count == 1 ? "1 listener" : "\(count) listeners"
  }

  var djLine: String {
    if let djName, !djName.isEmpty {
      return "DJ: \(djName)"
    }
    return "No DJ in the booth"
  }

  var playbackLabel: String {
    hasTrack ? (isPlaying ? "Playing live" : "Paused") : "Waiting for a track"
  }

  var currentTimeLabel: String {
    formatTime(currentTime)
  }

  var durationLabel: String {
    duration > 0 ? formatTime(duration) : "--:--"
  }

  var baseVolumeLabel: String {
    percentLabel(baseVolume)
  }

  var vibezRangeLabel: String {
    "+/- \(Int((vibezRange * 100).rounded()))%"
  }

  var vibezLevelLabel: String {
    let magnitude = Int((abs(vibezLevel) * 100).rounded())
    if magnitude == 0 { return "Neutral" }
    return vibezLevel < 0 ? "Lower \(magnitude)%" : "Lift +\(magnitude)%"
  }

  var liveVolume: Double {
    effectiveVolume(for: baseVolume)
  }

  var liveVolumeLabel: String {
    "Live \(percentLabel(liveVolume))"
  }

  var floorVolumeLabel: String {
    percentLabel(max(0, baseVolume - vibezRange))
  }

  var ceilingVolumeLabel: String {
    percentLabel(min(1, baseVolume + vibezRange))
  }

  var allowedBandStart: Double {
    max(0, baseVolume - vibezRange)
  }

  var allowedBandWidth: Double {
    min(1, baseVolume + vibezRange) - max(0, baseVolume - vibezRange)
  }

  func saveConfiguration(_ configuration: VibezConfiguration) async throws {
    try await validate(configuration)

    let encoded = try JSONEncoder().encode(configuration)
    defaults.set(encoded, forKey: Self.configurationKey)
    self.configuration = configuration
    reconnect(clearErrors: true)
  }

  func reconnect(clearErrors: Bool = false) {
    if clearErrors {
      errorMessage = nil
    }
    disconnect()
    connect()
  }

  func claimDJ() {
    send(["type": "dj:claim"])
  }

  func releaseDJ() {
    send(["type": "dj:release"])
  }

  func playTrackDraft() {
    let url = trackDraftURL.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !url.isEmpty else { return }
    send(["type": "dj:play", "url": url])
    trackDraftURL = ""
  }

  func pauseAsDJIfPossible() {
    guard isDJ else { return }
    send(["type": "dj:pause", "position": Int(currentTime * 1000)])
    player.pause()
    isPlaying = false
  }

  func resumeAsDJIfPossible() {
    guard isDJ else { return }
    send(["type": "dj:resume", "position": Int(currentTime * 1000)])
  }

  func seek(to seconds: Double) {
    let clamped = max(0, min(duration > 0 ? duration : seconds, seconds))
    seekPlayer(to: clamped)
    if isDJ {
      send(["type": "dj:seek", "position": Int(clamped * 1000)])
    }
  }

  func setVibezLevel(_ value: Double) {
    vibezLevel = value
    send(["type": "vibez:boost", "boost": vibezLevel])
  }

  private func loadPersistedConfiguration() {
    guard let data = defaults.data(forKey: Self.configurationKey),
          let configuration = try? JSONDecoder().decode(VibezConfiguration.self, from: data) else {
      connectionState = .setupRequired
      return
    }

    self.configuration = configuration
    connect()
  }

  private func connect() {
    guard let configuration,
          let serverURL = configuration.serverURL,
          let socketURL = webSocketURL(from: serverURL) else {
      connectionState = .setupRequired
      return
    }

    connectionState = .connecting
    errorMessage = nil

    let task = urlSession.webSocketTask(with: socketURL)
    webSocketTask = task
    task.resume()

    receiveTask = Task { [weak self] in
      guard let self else { return }
      await self.receiveLoop(for: task)
    }

    send(["type": "join", "name": configuration.listenerName])
  }

  private func disconnect() {
    heartbeatTask?.cancel()
    heartbeatTask = nil

    receiveTask?.cancel()
    receiveTask = nil

    reconnectTask?.cancel()
    reconnectTask = nil

    webSocketTask?.cancel(with: .goingAway, reason: nil)
    webSocketTask = nil
  }

  private func scheduleReconnect() {
    reconnectTask?.cancel()
    guard configuration != nil else { return }

    reconnectTask = Task { [weak self] in
      try? await Task.sleep(for: .seconds(2))
      guard let self, !Task.isCancelled else { return }
      self.connect()
    }
  }

  private func receiveLoop(for task: URLSessionWebSocketTask) async {
    while !Task.isCancelled {
      do {
        let message = try await task.receive()
        switch message {
        case .data(let data):
          handleIncomingData(data)
        case .string(let string):
          handleIncomingData(Data(string.utf8))
        @unknown default:
          break
        }
      } catch {
        guard !Task.isCancelled else { return }
        connectionState = configuration == nil ? .setupRequired : .disconnected
        scheduleReconnect()
        return
      }
    }
  }

  private func handleIncomingData(_ data: Data) {
    guard let jsonObject = try? JSONSerialization.jsonObject(with: data),
          let message = jsonObject as? [String: Any],
          let type = message["type"] as? String else {
      return
    }

    switch type {
    case "sync":
      applyStationSnapshot(message)
    case "track":
      applyTrack(message)
    case "play":
      handlePlay(message)
    case "pause":
      handlePause(message)
    case "seek":
      handleSeek(message)
    case "dj:changed":
      djName = message["djName"] as? String
      isDJ = djName == configuration?.listenerName
      if djName == nil {
        vibezLevel = 0
      }
      updateHeartbeatIfNeeded()
    case "listeners":
      listeners = (message["names"] as? [String]) ?? []
    case "vibez":
      vibezLevel = clampSigned(message["boost"] as? Double ?? 0)
    case "stream:refreshed":
      if let rawURL = message["streamUrl"] as? String {
        refreshPlayback(with: rawURL)
      }
    case "error":
      errorMessage = message["message"] as? String
    default:
      break
    }
  }

  private func applyStationSnapshot(_ message: [String: Any]) {
    connectionState = .connected
    errorMessage = nil
    djName = message["djName"] as? String
    isDJ = djName == configuration?.listenerName
    listeners = (message["listeners"] as? [String]) ?? listeners
    vibezLevel = clampSigned(message["vibezBoost"] as? Double ?? 0)
    applyTrack(message)

    let isSnapshotPlaying = message["isPlaying"] as? Bool ?? false
    if isSnapshotPlaying {
      handlePlay(["position": message["position"] ?? 0, "timestamp": message["positionTimestamp"] ?? 0])
    } else if let positionMs = numberValue(message["position"]) {
      pausePlayer(at: positionMs / 1000)
    }

    updateHeartbeatIfNeeded()
  }

  private func applyTrack(_ message: [String: Any]) {
    trackURLString = message["url"] as? String ?? message["trackUrl"] as? String
    trackTitle = message["title"] as? String ?? message["trackTitle"] as? String
    trackArtworkURL = URL(string: (message["artwork"] as? String) ?? (message["trackArtwork"] as? String) ?? "")

    if let streamString = (message["streamUrl"] as? String), !streamString.isEmpty {
      replacePlayerItemIfNeeded(streamString)
    }

    hasTrack = trackURLString != nil || currentStreamURLString != nil
  }

  private func handlePlay(_ message: [String: Any]) {
    guard let positionMs = numberValue(message["position"]),
          let timestampMs = numberValue(message["timestamp"]) else {
      return
    }

    let nowMs = Date().timeIntervalSince1970 * 1000
    let targetSeconds = max(0, (positionMs + (nowMs - timestampMs)) / 1000)
    seekPlayer(to: targetSeconds)
    player.play()
    isPlaying = true
  }

  private func handlePause(_ message: [String: Any]) {
    guard let positionMs = numberValue(message["position"]) else { return }
    pausePlayer(at: positionMs / 1000)
  }

  private func handleSeek(_ message: [String: Any]) {
    guard let positionMs = numberValue(message["position"]) else { return }
    seekPlayer(to: positionMs / 1000)
  }

  private func replacePlayerItemIfNeeded(_ streamString: String) {
    guard currentStreamURLString != streamString,
          let url = URL(string: streamString) else {
      return
    }

    currentStreamURLString = streamString
    let item = AVPlayerItem(url: url)
    player.replaceCurrentItem(with: item)
    observePlaybackNotifications(for: item)
  }

  private func refreshPlayback(with streamString: String) {
    guard let url = URL(string: streamString) else { return }
    currentStreamURLString = streamString
    let item = AVPlayerItem(url: url)
    player.replaceCurrentItem(with: item)
    observePlaybackNotifications(for: item)
    seekPlayer(to: refreshPosition)
    if isPlaying {
      player.play()
    }
  }

  private func configurePlayer() {
    applyVolume()

    timeObserverToken = player.addPeriodicTimeObserver(
      forInterval: CMTime(seconds: 0.5, preferredTimescale: 600),
      queue: .main
    ) { [weak self] time in
      guard let self else { return }
      Task { @MainActor [weak self] in
        guard let self else { return }
        currentTime = max(0, time.seconds.isFinite ? time.seconds : 0)
        let itemDuration = player.currentItem?.duration.seconds ?? 0
        duration = itemDuration.isFinite && itemDuration > 0 ? itemDuration : 0
      }
    }
  }

  private func observePlaybackNotifications(for item: AVPlayerItem) {
    NotificationCenter.default.removeObserver(self, name: .AVPlayerItemPlaybackStalled, object: nil)
    NotificationCenter.default.removeObserver(self, name: .AVPlayerItemFailedToPlayToEndTime, object: nil)

    NotificationCenter.default.addObserver(self, selector: #selector(handlePlaybackStalled(_:)), name: .AVPlayerItemPlaybackStalled, object: item)
    NotificationCenter.default.addObserver(self, selector: #selector(handlePlaybackFailed(_:)), name: .AVPlayerItemFailedToPlayToEndTime, object: item)
  }

  @objc private func handlePlaybackStalled(_ notification: Notification) {
    requestStreamRefresh()
  }

  @objc private func handlePlaybackFailed(_ notification: Notification) {
    requestStreamRefresh()
  }

  private func requestStreamRefresh() {
    refreshPosition = currentTime
    send(["type": "stream:refresh"])
  }

  private func pausePlayer(at seconds: Double) {
    seekPlayer(to: seconds)
    player.pause()
    isPlaying = false
  }

  private func seekPlayer(to seconds: Double) {
    let clamped = max(0, seconds)
    let time = CMTime(seconds: clamped, preferredTimescale: 600)
    player.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero)
    currentTime = clamped
  }

  private func updateHeartbeatIfNeeded() {
    heartbeatTask?.cancel()
    heartbeatTask = nil

    guard isDJ else { return }

    heartbeatTask = Task { [weak self] in
      while let self, !Task.isCancelled {
        try? await Task.sleep(for: .seconds(5))
        guard !Task.isCancelled else { return }
        self.send(["type": "dj:position", "position": Int(self.currentTime * 1000)])
      }
    }
  }

  private func send(_ payload: [String: Any]) {
    guard let webSocketTask else {
      errorMessage = "Room connection is offline. Tap Reconnect."
      return
    }

    Task {
      guard JSONSerialization.isValidJSONObject(payload),
            let data = try? JSONSerialization.data(withJSONObject: payload) else {
        return
      }

      do {
        try await webSocketTask.send(.data(data))
      } catch {
        await MainActor.run {
          connectionState = configuration == nil ? .setupRequired : .disconnected
          scheduleReconnect()
        }
      }
    }
  }

  private func validate(_ configuration: VibezConfiguration) async throws {
    guard let url = configuration.serverURL else {
      throw ValidationError.invalidURL
    }

    var request = URLRequest(url: url)
    request.timeoutInterval = 10
    request.setValue(basicAuthHeader(username: configuration.username, password: configuration.password), forHTTPHeaderField: "Authorization")

    let (_, response) = try await URLSession.shared.data(for: request)
    guard let httpResponse = response as? HTTPURLResponse else {
      throw ValidationError.unexpectedResponse
    }

    switch httpResponse.statusCode {
    case 200..<300:
      return
    case 401:
      throw ValidationError.invalidCredentials
    default:
      throw ValidationError.serverRejected(httpResponse.statusCode)
    }
  }

  private func applyVolume() {
    player.volume = Float(effectiveVolume(for: baseVolume))
  }

  private func effectiveVolume(for base: Double) -> Double {
    guard base > 0 else { return 0 }
    return clampUnit(base + vibezLevel * vibezRange)
  }

  private func clampUnit(_ value: Double) -> Double {
    guard value.isFinite else { return 0 }
    return max(0, min(1, value))
  }

  private func clampSigned(_ value: Double) -> Double {
    guard value.isFinite else { return 0 }
    return max(-1, min(1, value))
  }

  private func percentLabel(_ value: Double) -> String {
    "\(Int((value * 100).rounded()))%"
  }

  private func formatTime(_ seconds: Double) -> String {
    guard seconds.isFinite else { return "0:00" }
    let totalSeconds = Int(max(0, seconds.rounded()))
    let minutes = totalSeconds / 60
    let remainder = totalSeconds % 60
    return "\(minutes):\(String(format: "%02d", remainder))"
  }

  private func numberValue(_ raw: Any?) -> Double? {
    switch raw {
    case let number as Double:
      return number
    case let number as NSNumber:
      return number.doubleValue
    case let string as String:
      return Double(string)
    default:
      return nil
    }
  }
}

private enum ValidationError: LocalizedError {
  case invalidURL
  case invalidCredentials
  case unexpectedResponse
  case serverRejected(Int)

  var errorDescription: String? {
    switch self {
    case .invalidURL:
      return "That server URL does not look valid."
    case .invalidCredentials:
      return "The current password was rejected by vibez."
    case .unexpectedResponse:
      return "The vibez server responded in an unexpected way."
    case .serverRejected(let statusCode):
      return "The vibez server returned status \(statusCode)."
    }
  }
}
