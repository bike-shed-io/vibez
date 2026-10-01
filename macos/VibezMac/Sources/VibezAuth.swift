import AppKit
import AuthenticationServices
import Foundation

struct VibezUser: Decodable, Equatable {
  let email: String
  let name: String
  let givenName: String
  let picture: String?
  let isAdmin: Bool
}

// The token lives in a 0600 file, not Keychain: ad-hoc-signed releases would get a
// Keychain prompt after every `brew upgrade` (each build has a new signature).
enum SessionTokenStore {
  private static var fileURL: URL? {
    try? FileManager.default
      .url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
      .appending(path: "Vibez/session-token")
  }

  static func load() -> String? {
    guard let fileURL, let contents = try? String(contentsOf: fileURL, encoding: .utf8) else { return nil }
    let token = contents.trimmingCharacters(in: .whitespacesAndNewlines)
    return token.isEmpty ? nil : token
  }

  @discardableResult
  static func save(_ token: String) -> Bool {
    guard let fileURL else { return false }
    let fileManager = FileManager.default
    let directory = fileURL.deletingLastPathComponent()
    do {
      try fileManager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
      try Data(token.utf8).write(to: fileURL, options: .atomic)
      try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
      return true
    } catch {
      return false
    }
  }

  static func clear() {
    guard let fileURL else { return }
    try? FileManager.default.removeItem(at: fileURL)
  }
}

enum GoogleSignInError: LocalizedError {
  case failed

  var errorDescription: String? { "Google sign-in failed. Try again." }
}

@MainActor
final class GoogleSignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
  private var session: ASWebAuthenticationSession?

  func signIn(serverURL: URL) async throws -> String {
    var components = URLComponents(url: serverURL.appending(path: "auth/google"), resolvingAgainstBaseURL: false)!
    components.queryItems = [URLQueryItem(name: "client", value: "mac")]
    let startURL = components.url!

    return try await withCheckedThrowingContinuation { continuation in
      let session = ASWebAuthenticationSession(url: startURL, callbackURLScheme: "vibez") { callbackURL, error in
        let token = callbackURL
          .flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false)?.queryItems }?
          .first { $0.name == "token" }?
          .value
        if let token, !token.isEmpty {
          continuation.resume(returning: token)
        } else {
          continuation.resume(throwing: error ?? GoogleSignInError.failed)
        }
      }
      session.presentationContextProvider = self
      self.session = session
      if !session.start() {
        continuation.resume(throwing: GoogleSignInError.failed)
      }
    }
  }

  nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    MainActor.assumeIsolated {
      NSApp.keyWindow ?? NSApp.windows.first { $0.isVisible } ?? ASPresentationAnchor()
    }
  }
}
