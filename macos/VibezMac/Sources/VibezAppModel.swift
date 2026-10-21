import AppKit
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
  static let joinSoundKey = "vibez.macos.joinSound"

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
  /// Set for YouTube tracks; they play in the video overlay instead of AVPlayer.
  @Published private(set) var videoId: String?
  /// The user closed the overlay for the current video; "Show video" brings it back.
  @Published private(set) var videoHidden = false

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
  /// The DJ name the user chose (empty = not chosen yet). Only user choices are persisted; see `effectiveDJName`.
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

  /// Chosen DJ name, else the Google given name, else the display name. Fallbacks are computed, never stored.
  var effectiveDJName: String {
    let chosen = djName.trimmingCharacters(in: .whitespacesAndNewlines)
    if !chosen.isEmpty { return chosen }
    if let givenName = user?.givenName, !givenName.isEmpty { return givenName }
    return listenerName
  }
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
  private let videoOverlay = VideoOverlay()
  // Last play/pause/seek the room agreed on; `roomPositionMs` extrapolates from it while playing.
  private var anchorPositionMs = 0.0
  private var anchorTimestampMs = 0.0
  private var videoHiddenTask: Task<Void, Never>?

  private var webSocketTask: URLSessionWebSocketTask?
  private var receiveTask: Task<Void, Never>?
  private var reconnectTask: Task<Void, Never>?
  private var heartbeatTask: Task<Void, Never>?
  private var livenessTask: Task<Void, Never>?
  private var lastPong = Date()
  private var timeObserverToken: Any?
  private var refreshPosition = 0.0
  private var currentStreamURLString: String?
  private var pendingChannelID: String?
  // Rejoining (e.g. after a deploy) brings everyone back at once: stay quiet for a moment.
  private var joinSoundQuietUntil = Date.distantPast

  override init() {
    self.baseVolume = defaults.object(forKey: Self.volumeKey) as? Double ?? 0.8
    self.vibezRange = defaults.object(forKey: Self.rangeKey) as? Double ?? 0.2
    self.djName = defaults.string(forKey: Self.djNameKey) ?? ""
    self.roomName = defaults.string(forKey: Self.roomNameKey) ?? ""
    self.trustedEmails = defaults.stringArray(forKey: Self.trustedEmailsKey) ?? []
    super.init()
    configurePlayer()
    configureVideoOverlay()
    loadPersistedConfiguration()
  }

  /// Display name sent in `hello`: the user-set display name if any, else the signed-in Google
  /// given name, else "Listener". A stored name equal to this Mac's computer name is treated as
  /// never having been set by the user (old default, before this was fixed).
  var listenerName: String {
    if let stored = configuration?.listenerName, !stored.isEmpty, stored != Host.current().localizedName {
      return stored
    }
    if let givenName = user?.givenName, !givenName.isEmpty { return givenName }
    return "Listener"
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
    send(["type": "live:start", "djName": effectiveDJName, "roomName": roomName, "trustedEmails": trustedEmails])
  }

  func endLive() {
    send(["type": "live:end"])
  }

  func renameRoom(_ name: String) {
    send(["type": "live:rename", "roomName": name])
  }

  func setQueueTrustedOnly(_ trustedOnly: Bool) {
    send(["type": "live:queue-access", "trustedOnly": trustedOnly])
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
    let positionMs = currentTime * 1000
    send(["type": "dj:pause", "position": Int(positionMs)])
    anchorPositionMs = positionMs
    isPlaying = false
    if videoId != nil {
      videoOverlay.pause(positionMs: positionMs)
    } else {
      player.pause()
    }
  }

  func resumeAsDJIfPossible() {
    guard isDJ else { return }
    let positionMs = currentTime * 1000
    send(["type": "dj:resume", "position": Int(positionMs)])
    // Server broadcasts `play` to every connection except the DJ; we must start locally (same as web `radio.js`).
    anchorPositionMs = positionMs
    anchorTimestampMs = nowMs
    isPlaying = true
    if videoId != nil {
      videoOverlay.play(positionMs: positionMs, timestamp: anchorTimestampMs)
    } else {
      player.play()
    }
  }

  func seek(to seconds: Double) {
    let clamped = max(0, min(duration > 0 ? duration : seconds, seconds))
    seekLocal(toMs: clamped * 1000, timestampMs: nowMs)
    if isDJ {
      send(["type": "dj:seek", "position": Int(clamped * 1000)])
    }
  }

  /// Reopens the overlay the user closed, at the room's current position.
  func showVideo() {
    guard let videoId, let serverURL = configuration?.serverURL else { return }
    videoHidden = false
    updateVideoHiddenTimer()
    videoOverlay.show(serverURL: serverURL)
    videoOverlay.load(videoId: videoId, positionMs: roomPositionMs, timestamp: nowMs, playing: isPlaying)
    applyVolume()
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
      listenerName: ""
    )

    self.configuration = configuration
    if let encoded = try? JSONEncoder().encode(configuration) {
      defaults.set(encoded, forKey: Self.configurationKey)
    }
    let nameAtConnect = listenerName
    connect()
    Task {
      await loadUser()
      // A signed-in user's given name only becomes available after this resolves; reconnect so
      // `hello` carries it instead of the "Listener" fallback sent at cold start.
      if listenerName != nameAtConnect { reconnect() }
    }
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
    startLivenessCheck(for: task)

    send(["type": "hello", "protocol": 3, "name": listenerName])
  }

  private func disconnect() {
    heartbeatTask?.cancel()
    heartbeatTask = nil

    receiveTask?.cancel()
    receiveTask = nil

    reconnectTask?.cancel()
    reconnectTask = nil

    livenessTask?.cancel()
    livenessTask = nil

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
      self.reconnect() // drop the old socket, or its receive loop keeps feeding stale messages
    }
  }

  // A socket that died silently (Mac slept, Wi-Fi switched) never errors: receive() just waits
  // forever and the popover sits on "Connecting…". Ping, and treat a missing pong as dead.
  private func startLivenessCheck(for task: URLSessionWebSocketTask) {
    lastPong = Date()
    livenessTask = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(10))
        guard let self, !Task.isCancelled, task === self.webSocketTask else { return }
        if Date().timeIntervalSince(self.lastPong) > 25 {
          self.connectionState = .disconnected
          self.reconnect()
          return
        }
        task.sendPing { [weak self] error in
          guard error == nil else { return }
          Task { @MainActor in
            if task === self?.webSocketTask { self?.lastPong = Date() }
          }
        }
      }
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
      joinSoundQuietUntil = Date().addingTimeInterval(10)
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
    case "position":
      // The DJ's heartbeat, relayed. Only the video path corrects itself; AVPlayer keeps free-running.
      guard let positionMs = numberValue(message["position"]), let timestampMs = numberValue(message["timestamp"]) else { return }
      anchorPositionMs = positionMs
      anchorTimestampMs = timestampMs
      if videoId != nil { videoOverlay.sync(positionMs: positionMs, timestamp: timestampMs) }
    case "listeners":
      let names = (message["names"] as? [String]) ?? []
      if isDJ, names.count > listeners.count, Date() > joinSoundQuietUntil,
         defaults.object(forKey: Self.joinSoundKey) as? Bool ?? true {
        NSSound(named: "Pop")?.play()
      }
      listeners = names
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
        // Socket is closing — clear local state without sending channel:leave.
        currentChannel = nil
        roles = .none
        clearPlayback()
        return
      }
      if code == "channel-not-found" {
        if currentChannel != nil {
          leaveChannel()
        }
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
    let previousVideoId = videoId
    videoId = trackURLString == nil ? nil : message["videoId"] as? String

    if trackURLString == nil {
      player.replaceCurrentItem(with: nil)
      currentStreamURLString = nil
      hasTrack = false
      closeVideo()
      return
    }

    if let videoId {
      player.pause()
      player.replaceCurrentItem(with: nil)
      currentStreamURLString = nil
      hasTrack = true
      // `track` carries no position (a `play` at 0 follows); `channel:state` does.
      anchorPositionMs = numberValue(message["position"]) ?? 0
      anchorTimestampMs = numberValue(message["positionTimestamp"]) ?? nowMs
      let playing = message["isPlaying"] as? Bool ?? false
      currentTime = anchorPositionMs / 1000
      duration = 0
      if videoId != previousVideoId { videoHidden = false } // hiding applies to one video only
      updateVideoHiddenTimer()
      if videoHidden { return }
      guard let serverURL = configuration?.serverURL else { return }
      videoOverlay.show(serverURL: serverURL)
      videoOverlay.load(videoId: videoId, positionMs: anchorPositionMs, timestamp: anchorTimestampMs, playing: playing)
      applyVolume()
      return
    }

    closeVideo()
    if let streamString = (message["streamUrl"] as? String), !streamString.isEmpty {
      replacePlayerItemIfNeeded(streamString)
    }

    hasTrack = trackURLString != nil || currentStreamURLString != nil
  }

  private func closeVideo() {
    videoOverlay.close()
    videoHidden = false
    updateVideoHiddenTimer()
  }

  private var nowMs: Double { Date().timeIntervalSince1970 * 1000 }

  /// Where the room is right now, extrapolated from the last play/pause/seek.
  private var roomPositionMs: Double {
    max(0, isPlaying ? anchorPositionMs + nowMs - anchorTimestampMs : anchorPositionMs)
  }

  private func configureVideoOverlay() {
    videoOverlay.onTime = { [weak self] positionMs, durationMs in
      self?.currentTime = positionMs / 1000
      self?.duration = durationMs / 1000
    }
    videoOverlay.onEnded = { [weak self] in self?.sendTrackEnded() }
    videoOverlay.onError = { [weak self] _ in
      // Embedding disabled or video gone: the DJ moves the room on, everyone sees why.
      self?.notice = "Can't play this video here"
      self?.sendTrackEnded()
    }
    videoOverlay.onClosed = { [weak self] in
      guard let self else { return }
      videoHidden = true
      updateVideoHiddenTimer()
    }
  }

  // With the overlay closed nobody reports time, so keep `currentTime` (and the DJ heartbeat) on the room
  // clock and, as DJ, end the track ourselves or the room would stall on it.
  private func updateVideoHiddenTimer() {
    videoHiddenTask?.cancel()
    videoHiddenTask = nil
    guard videoId != nil, videoHidden else { return }

    videoHiddenTask = Task { [weak self] in
      while let self, !Task.isCancelled {
        try? await Task.sleep(for: .seconds(1))
        guard !Task.isCancelled else { return }
        self.currentTime = self.roomPositionMs / 1000
        if self.isDJ, self.duration > 0, self.currentTime >= self.duration {
          self.sendTrackEnded()
          return
        }
      }
    }
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

    anchorPositionMs = positionMs
    anchorTimestampMs = timestampMs
    isPlaying = true
    if videoId != nil {
      videoOverlay.play(positionMs: positionMs, timestamp: timestampMs)
      return
    }

    let targetSeconds = max(0, (positionMs + (nowMs - timestampMs)) / 1000)
    seekPlayer(to: targetSeconds)
    player.play()
  }

  private func handlePause(_ message: [String: Any]) {
    guard let positionMs = numberValue(message["position"]) else { return }
    pausePlayer(at: positionMs / 1000)
  }

  private func handleSeek(_ message: [String: Any]) {
    guard let positionMs = numberValue(message["position"]) else { return }
    seekLocal(toMs: positionMs, timestampMs: numberValue(message["timestamp"]) ?? nowMs)
  }

  private func seekLocal(toMs positionMs: Double, timestampMs: Double) {
    anchorPositionMs = positionMs
    anchorTimestampMs = timestampMs
    if videoId != nil {
      currentTime = positionMs / 1000
      videoOverlay.seek(positionMs: positionMs, timestamp: timestampMs)
    } else {
      seekPlayer(to: positionMs / 1000)
    }
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
    sendTrackEnded()
  }

  private func sendTrackEnded() {
    guard let trackUrl = trackURLString else { return }
    send(["type": "track:ended", "trackUrl": trackUrl])
  }

  private func requestStreamRefresh() {
    refreshPosition = currentTime
    send(["type": "stream:refresh"])
  }

  private func pausePlayer(at seconds: Double) {
    anchorPositionMs = seconds * 1000
    isPlaying = false
    if videoId != nil {
      currentTime = seconds
      videoOverlay.pause(positionMs: seconds * 1000)
      return
    }
    seekPlayer(to: seconds)
    player.pause()
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
    let volume = effectiveVolume(for: baseVolume)
    player.volume = Float(volume)
    if videoId != nil { videoOverlay.setVolume(volume) }
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
