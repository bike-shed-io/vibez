import Foundation

struct ChannelInfo: Decodable, Equatable, Identifiable {
  let id: String
  let ownerName: String
  let ownerPicture: String?
  let roomName: String?
  let activeDjName: String
  let djAway: Bool

  var displayName: String { roomName ?? "\(ownerName)'s vibes" }
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
  let trustedEmails: [String]

  static let none = ChannelRoles(isOwner: false, isTrusted: false, isActiveDj: false, trustedEmails: [])
}

struct TrustablePerson: Decodable, Equatable, Identifiable {
  let name: String
  let email: String
  let trusted: Bool

  var id: String { email }
}
