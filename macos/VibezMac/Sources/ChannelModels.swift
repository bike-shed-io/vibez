import Foundation

/// Where a room's tracks come from. A room plays from one source at a time.
enum RoomSource: String, Decodable, CaseIterable, Identifiable {
  case soundcloud
  case suno

  var id: String { rawValue }
  var label: String { self == .suno ? "Suno" : "SoundCloud" }
  /// Only Suno is gated behind an access token for now.
  var needsAccessToken: Bool { self == .suno }
}

struct ChannelInfo: Decodable, Equatable, Identifiable {
  let id: String
  let ownerName: String
  let ownerPicture: String?
  let roomName: String?
  let activeDjName: String
  let djAway: Bool
  let queueTrustedOnly: Bool? // optional: older servers don't send it
  let source: RoomSource? // optional: older servers only had SoundCloud

  var displayName: String { roomName ?? "\(ownerName)'s vibes" }
  var playbackSource: RoomSource { source ?? .soundcloud }
}

struct DirectoryEntry: Decodable, Equatable, Identifiable {
  let id: String
  let ownerName: String
  let ownerPicture: String?
  let roomName: String?
  let activeDjName: String
  let djAway: Bool
  let trackTitle: String?
  let trackArtwork: String?
  let isPlaying: Bool
  let listenerCount: Int

  var displayName: String { roomName ?? "\(ownerName)'s vibes" }
}

struct ChannelRoles: Decodable, Equatable {
  let isOwner: Bool
  let isTrusted: Bool
  let isActiveDj: Bool
  let canQueue: Bool? // optional: older servers don't send it (and check queue:add themselves)
  let trustedEmails: [String]

  static let none = ChannelRoles(isOwner: false, isTrusted: false, isActiveDj: false, canQueue: nil, trustedEmails: [])
}

struct TrustablePerson: Decodable, Equatable, Identifiable {
  let name: String
  let email: String
  let trusted: Bool

  var id: String { email }
}
