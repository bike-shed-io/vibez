import AuthenticationServices
import AVFoundation
import Foundation

struct QueueItem: Identifiable, Equatable {
  let id: String
  let url: String
  let title: String?
  let artwork: String?
  let addedBy: String

  init?(from dict: [String: Any]) {
    guard let id = dict["id"] as? String,
          let url = dict["url"] as? String,
          let addedBy = dict["addedBy"] as? String else { return nil }
    self.id = id
    self.url = url
    self.title = dict["title"] as? String
    self.artwork = dict["artwork"] as? String
    self.addedBy = addedBy
  }
}

@MainActor
final class VibezAppModel: NSObject, ObservableObject {
  enum ConnectionState {
    case connecting
    case connected
    case disconnected
  }

  private static let configurationKey = "vibez.macos.configuration"
  private static let volumeKey = "vibez.macos.baseVolume"
  private static let rangeKey = "vibez.macos.vibezRange"
  private static let djNameKey = "vibez.macos.djName"
  private static let roomNameKey = "vibez.macos.roomName"
  private static let trustedEmailsKey = "vibez.macos.trustedEmails"

  @Published private(set) var configuration: VibezConfiguration?
  @Published private(set) var connectionState: ConnectionState = .connecting
  @Published private(set) var user: VibezUser?
  @Published private(set) var isSigningIn = false
  private let googleSignIn = GoogleSignIn()

  @Published var trackDraftURL = ""
  @Published private(set) var trackTitle: String?
  @Published private(set) var trackArtworkURL: URL?
  @Published private(set) var trackURLString: String?
  @Published private(set) var listeners: [String] = []
  @Published private(set) var errorMessage: String?
  @Published private(set) var isPlaying = false
  @Published private(set) var hasTrack = false
  @Published private(set) var currentTime: Double = 0
  @Published private(set) var duration: Double = 0
  @Published private(set) var queue: [QueueItem] = []

  @Published private(set) var directory: [DirectoryEntry] = []
  @Published private(set) var currentChannel: ChannelInfo?
  @Published private(set) var roles: ChannelRoles = .none {
    didSet {
      updateHeartbeatIfNeeded()
      if roles.isOwner {
        trustedEmails = roles.trustedEmails
      }
    }
  }
  @Published private(set) var trustablePeople: [TrustablePerson] = []
  @Published var notice: String?
  @Published private(set) var isAdmin = false
  @Published private(set) var updateRequired = false
  @Published var djName: String {
    didSet { defaults.set(djName, forKey: Self.djNameKey) }
  }
  @Published var roomName: String {
    didSet { defaults.set(roomName, forKey: Self.roomNameKey) }
  }
  @Published var trustedEmails: [String] {
    didSet { defaults.set(trustedEmails, forKey: Self.trustedEmailsKey) }
  }

  var isDJ: Bool { roles.isActiveDj }
  @Published var queueDraftURL = ""
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
  private var pendingChannelID: String?

  override init() {
    self.baseVolume = defaults.object(forKey: Self.volumeKey) as? Double ?? 0.8
    self.vibezRange = defaults.object(forKey: Self.rangeKey) as? Double ?? 0.2
    self.djName = defaults.string(forKey: Self.djNameKey) ?? ""
    self.roomName = defaults.string(forKey: Self.roomNameKey) ?? ""
    self.trustedEmails = defaults.stringArray(forKey: Self.trustedEmailsKey) ?? []
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

  var queueSummary: String {
    let count = queue.count
    return count == 1 ? "1 track" : "\(count) tracks"
  }

  func saveConfiguration(_ configuration: VibezConfiguration) async throws {
    try await validate(configuration)

    let previousServerURL = self.configuration?.serverURL
    let encoded = try JSONEncoder().encode(configuration)
    defaults.set(encoded, forKey: Self.configurationKey)
    self.configuration = configuration
    if djName.isEmpty { djName = configuration.listenerName }

    // Switching to a different server must not hand it the old server's session token.
    if let previousServerURL, serverIdentity(previousServerURL) != serverIdentity(configuration.serverURL) {
      SessionTokenStore.clear()
      user = nil
    }

    reconnect(clearErrors: true)
    Task { await loadUser() }
  }

  private func serverIdentity(_ url: URL?) -> String? {
    guard let url else { return nil }
    return "\(url.scheme ?? "")://\(url.host ?? "")" + (url.port.map { ":\($0)" } ?? "")
  }

  func reconnect(clearErrors: Bool = false) {
    if clearErrors {
      errorMessage = nil
    }
    disconnect()
    connect()
  }

  func signIn() async {
    guard let serverURL = configuration?.serverURL else { return }
    isSigningIn = true
    defer { isSigningIn = false }
    do {
      let token = try await googleSignIn.signIn(serverURL: serverURL)
      guard SessionTokenStore.save(token) else {
        errorMessage = "Couldn't save your sign-in."
        return
      }
      await loadUser()
      reconnect(clearErrors: true)
    } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
      // User closed the sheet; stay signed out quietly
    } catch {
      errorMessage = GoogleSignInError.failed.localizedDescription
    }
  }

  func signOut() {
    SessionTokenStore.clear()
    user = nil
    reconnect(clearErrors: true)
  }

  func loadUser() async {
    guard let serverURL = configuration?.serverURL, let token = SessionTokenStore.load() else {
      user = nil
      return
    }
    var request = URLRequest(url: serverURL.appending(path: "auth/me"))
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    do {
      let (data, response) = try await URLSession.shared.data(for: request)
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      if status == 401 {
        SessionTokenStore.clear()
        user = nil
      } else if (200..<300).contains(status) {
        let decoded = try JSONDecoder().decode(VibezUser.self, from: data)
        user = decoded
        if djName.isEmpty { djName = decoded.givenName }
      }
    } catch {
      // Offline: keep the token, try again on next connect
    }
  }

  func joinChannel(id: String) {
    send(["type": "channel:join", "channelId": id])
  }

  func leaveChannel() {
    send(["type": "channel:leave"])
    currentChannel = nil
    roles = .none
    clearPlayback()
  }

  func goLive() {
    send(["type": "live:start", "djName": djName, "roomName": roomName, "trustedEmails": trustedEmails])
  }

  func endLive() {
    send(["type": "live:end"])
  }

  func renameRoom(_ name: String) {
    send(["type": "live:rename", "roomName": name])
  }

  func trust(email: String) {
    send(["type": "live:trust", "email": email])
  }

  func untrust(email: String) {
    send(["type": "live:untrust", "email": email])
  }

  func takeDecks() {
    send(["type": "dj:take"])
  }

  func adminEnd(channelID: String) {
    send(["type": "admin:end", "channelId": channelID])
  }

  func openChannelLink(id: String) {
    if connectionState == .connected {
      joinChannel(id: id)
    } else {
      pendingChannelID = id
    }
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
    // Server broadcasts `play` to every connection except the DJ; we must start locally (same as web `radio.js`).
    player.play()
    isPlaying = true
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

  func addToQueue() {
    let url = queueDraftURL.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !url.isEmpty else { return }
    send(["type": "queue:add", "url": url])
    queueDraftURL = ""
  }

  func removeFromQueue(itemId: String) {
    send(["type": "queue:remove", "itemId": itemId])
  }

  func skipQueue() {
    send(["type": "queue:skip"])
  }

  func shuffleQueue() {
    send(["type": "queue:shuffle"])
  }

  func clearQueue() {
    send(["type": "queue:clear"])
  }

  func reorderQueue(itemId: String, toIndex: Int) {
    send(["type": "queue:reorder", "itemId": itemId, "toIndex": toIndex])
  }

  private func loadPersistedConfiguration() {
    let stored = defaults.data(forKey: Self.configurationKey)
      .flatMap { try? JSONDecoder().decode(VibezConfiguration.self, from: $0) }
    let configuration = stored ?? VibezConfiguration(
      serverURLString: "https://vibez.bike-shed.io",
      listenerName: Host.current().localizedName ?? "Listener"
    )

    self.configuration = configuration
    if djName.isEmpty { djName = configuration.listenerName }
    if let encoded = try? JSONEncoder().encode(configuration) {
      defaults.set(encoded, forKey: Self.configurationKey)
    }
    connect()
    Task { await loadUser() }
  }

  private func connect() {
    guard let configuration,
          let serverURL = configuration.serverURL,
          let socketURL = webSocketURL(from: serverURL) else {
      connectionState = .disconnected
      return
    }

    connectionState = .connecting
    errorMessage = nil

    var request = URLRequest(url: socketURL)
    if let token = SessionTokenStore.load() {
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
    let task = urlSession.webSocketTask(with: request)
    webSocketTask = task
    task.resume()

    receiveTask = Task { [weak self] in
      guard let self else { return }
      await self.receiveLoop(for: task)
    }

    send(["type": "hello", "protocol": 2, "name": configuration.listenerName])
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
    if updateRequired { return }
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
        connectionState = .disconnected
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
    case "welcome":
      connectionState = .connected
      errorMessage = nil
      isAdmin = message["isAdmin"] as? Bool ?? false
      if let pendingChannelID {
        joinChannel(id: pendingChannelID)
        self.pendingChannelID = nil
      } else if let currentChannel {
        joinChannel(id: currentChannel.id)
      }
    case "channels":
      directory = decode([DirectoryEntry].self, from: message["channels"]) ?? []
    case "channel:state":
      guard let channel = decode(ChannelInfo.self, from: message["channel"]),
            let roles = decode(ChannelRoles.self, from: message["roles"]) else { return }
      currentChannel = channel
      self.roles = roles
      applyChannelState(message)
    case "channel:update":
      guard let channel = decode(ChannelInfo.self, from: message["channel"]),
            let roles = decode(ChannelRoles.self, from: message["roles"]) else { return }
      currentChannel = channel
      self.roles = roles
      if let noticeText = message["notice"] as? String {
        notice = noticeText
      }
    case "channel:ended":
      currentChannel = nil
      roles = .none
      clearPlayback()
      notice = "That channel ended."
    case "track":
      applyTrack(message)
    case "play":
      handlePlay(message)
    case "pause":
      handlePause(message)
    case "seek":
      handleSeek(message)
    case "listeners":
      listeners = (message["names"] as? [String]) ?? []
      trustablePeople = decode([TrustablePerson].self, from: message["people"]) ?? []
    case "vibez":
      vibezLevel = clampSigned(message["boost"] as? Double ?? 0)
    case "queue":
      applyQueue(message)
    case "stream:refreshed":
      if let rawURL = message["streamUrl"] as? String {
        refreshPlayback(with: rawURL)
      }
    case "error":
      let code = message["code"] as? String
      let errorText = message["message"] as? String
      if code == "protocol" {
        updateRequired = true
        errorMessage = errorText
        return
      }
      if code == "channel-not-found" {
        notice = "That channel ended."
        return
      }
      errorMessage = errorText
    default:
      break
    }
  }

  /// Decodes a sub-object of an already-parsed `[String: Any]` message by re-serializing it to JSON.
  private func decode<T: Decodable>(_ type: T.Type, from rawValue: Any?) -> T? {
    guard let rawValue, JSONSerialization.isValidJSONObject(rawValue) else { return nil }
    guard let data = try? JSONSerialization.data(withJSONObject: rawValue) else { return nil }
    return try? JSONDecoder().decode(T.self, from: data)
  }

  private func applyChannelState(_ message: [String: Any]) {
    listeners = (message["listeners"] as? [String]) ?? listeners
    vibezLevel = clampSigned(message["vibezBoost"] as? Double ?? 0)
    applyTrack(message)
    applyQueue(message)

    let isSnapshotPlaying = message["isPlaying"] as? Bool ?? false
    if isSnapshotPlaying {
      handlePlay(["position": message["position"] ?? 0, "timestamp": message["positionTimestamp"] ?? 0])
    } else if let positionMs = numberValue(message["position"]) {
      pausePlayer(at: positionMs / 1000)
    }

    updateHeartbeatIfNeeded()
  }

  private func clearPlayback() {
    applyTrack([:])
    player.pause()
    isPlaying = false
  }

  private func applyTrack(_ message: [String: Any]) {
    trackURLString = message["url"] as? String ?? message["trackUrl"] as? String
    trackTitle = message["title"] as? String ?? message["trackTitle"] as? String
    trackArtworkURL = URL(string: (message["artwork"] as? String) ?? (message["trackArtwork"] as? String) ?? "")

    if trackURLString == nil {
      player.replaceCurrentItem(with: nil)
      currentStreamURLString = nil
      hasTrack = false
      return
    }

    if let streamString = (message["streamUrl"] as? String), !streamString.isEmpty {
      replacePlayerItemIfNeeded(streamString)
    }

    hasTrack = trackURLString != nil || currentStreamURLString != nil
  }

  private func applyQueue(_ message: [String: Any]) {
    let key = message["items"] != nil ? "items" : "queue"
    guard let rawItems = message[key] as? [[String: Any]] else { return }
    queue = rawItems.compactMap { QueueItem(from: $0) }
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
    player.allowsExternalPlayback = true
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
    NotificationCenter.default.removeObserver(self, name: .AVPlayerItemDidPlayToEndTime, object: nil)

    NotificationCenter.default.addObserver(self, selector: #selector(handlePlaybackStalled(_:)), name: .AVPlayerItemPlaybackStalled, object: item)
    NotificationCenter.default.addObserver(self, selector: #selector(handlePlaybackFailed(_:)), name: .AVPlayerItemFailedToPlayToEndTime, object: item)
    NotificationCenter.default.addObserver(self, selector: #selector(handlePlaybackEnded(_:)), name: .AVPlayerItemDidPlayToEndTime, object: item)
  }

  @objc private func handlePlaybackStalled(_ notification: Notification) {
    requestStreamRefresh()
  }

  @objc private func handlePlaybackFailed(_ notification: Notification) {
    requestStreamRefresh()
  }

  @objc private func handlePlaybackEnded(_ notification: Notification) {
    guard let trackUrl = trackURLString else { return }
    send(["type": "track:ended", "trackUrl": trackUrl])
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
          connectionState = .disconnected
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

    let (_, response) = try await URLSession.shared.data(for: request)
    guard let httpResponse = response as? HTTPURLResponse else {
      throw ValidationError.unexpectedResponse
    }

    switch httpResponse.statusCode {
    case 200..<300:
      return
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
  case unexpectedResponse
  case serverRejected(Int)

  var errorDescription: String? {
    switch self {
    case .invalidURL:
      return "That server URL does not look valid."
    case .unexpectedResponse:
      return "The vibez server responded in an unexpected way."
    case .serverRejected(let statusCode):
      return "The vibez server returned status \(statusCode)."
    }
  }
}
