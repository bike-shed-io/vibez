import Foundation

struct VibezConfiguration: Codable, Equatable {
  var serverURLString: String
  var listenerName: String

  var serverURL: URL? {
    normalizedURL(from: serverURLString)
  }
}

func normalizedURL(from rawValue: String) -> URL? {
  let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else { return nil }

  if let url = URL(string: trimmed), url.scheme != nil {
    return url
  }

  return URL(string: "https://\(trimmed)")
}

func webSocketURL(from serverURL: URL) -> URL? {
  guard var components = URLComponents(url: serverURL, resolvingAgainstBaseURL: false) else {
    return nil
  }

  switch components.scheme {
  case "http":
    components.scheme = "ws"
  case "https":
    components.scheme = "wss"
  case "ws", "wss":
    break
  default:
    components.scheme = "wss"
  }

  components.path = "/ws"
  components.query = nil
  components.fragment = nil
  return components.url
}
