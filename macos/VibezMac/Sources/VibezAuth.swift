import AppKit
import AuthenticationServices
import Foundation
import Security

struct VibezUser: Decodable, Equatable {
  let email: String
  let name: String
  let givenName: String
  let picture: String?
  let isAdmin: Bool
}

enum SessionTokenStore {
  private static let service = "io.bike-shed.vibez.mac"
  private static let account = "session"

  private static var baseQuery: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
  }

  static func load() -> String? {
    var query = baseQuery
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
          let data = item as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  static func save(_ token: String) {
    clear()
    var query = baseQuery
    query[kSecValueData as String] = Data(token.utf8)
    SecItemAdd(query as CFDictionary, nil)
  }

  static func clear() {
    SecItemDelete(baseQuery as CFDictionary)
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
