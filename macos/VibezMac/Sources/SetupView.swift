import SwiftUI

struct SetupView: View {
  enum Mode {
    case firstRun
    case update(existing: VibezConfiguration?)

    var title: String {
      switch self {
      case .firstRun:
        return "Connect Vibez"
      case .update:
        return "Update Connection"
      }
    }

    var buttonLabel: String {
      switch self {
      case .firstRun:
        return "Save & Connect"
      case .update:
        return "Save Changes"
      }
    }

    var existingConfiguration: VibezConfiguration? {
      switch self {
      case .firstRun:
        return nil
      case .update(let existing):
        return existing
      }
    }
  }

  let mode: Mode
  let onSave: (VibezConfiguration) async throws -> Void

  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var visibilitySettings: AppVisibilitySettings

  @State private var serverURLString: String
  @State private var listenerName: String
  @State private var username: String
  @State private var password: String
  @State private var isSaving = false
  @State private var errorMessage: String?

  init(mode: Mode, onSave: @escaping (VibezConfiguration) async throws -> Void) {
    self.mode = mode
    self.onSave = onSave

    let existing = mode.existingConfiguration
    _serverURLString = State(initialValue: existing?.serverURLString ?? "https://vibez.bike-shed.io")
    _listenerName = State(initialValue: existing?.listenerName ?? Host.current().localizedName ?? "Patrick")
    _username = State(initialValue: existing?.username ?? "listener")
    _password = State(initialValue: existing?.password ?? "")
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      VStack(alignment: .leading, spacing: 6) {
        Text(mode.title)
          .font(.largeTitle.weight(.semibold))
        Text("The password is only asked once here and stored locally for now. We can swap this auth flow later.")
          .font(.subheadline)
          .foregroundStyle(.secondary)
      }

      Group {
        LabeledContent("Server") {
          TextField("https://vibez.bike-shed.io", text: $serverURLString)
            .textFieldStyle(.roundedBorder)
            .frame(width: 320)
        }

        LabeledContent("Listener Name") {
          TextField("Your name", text: $listenerName)
            .textFieldStyle(.roundedBorder)
            .frame(width: 220)
        }

        LabeledContent("Username") {
          TextField("listener", text: $username)
            .textFieldStyle(.roundedBorder)
            .frame(width: 180)
        }

        LabeledContent("Password") {
          SecureField("enam2026", text: $password)
            .textFieldStyle(.roundedBorder)
            .frame(width: 220)
        }
      }
      .font(.body)

      Text("Username currently doesn't matter. Listener name does: it's what the room sees when you join and DJ.")
        .font(.caption)
        .foregroundStyle(.secondary)

      Divider()

      VStack(alignment: .leading, spacing: 12) {
        Text("App Visibility")
          .font(.caption.weight(.semibold))
          .textCase(.uppercase)
          .foregroundStyle(.secondary)

        Toggle("Show Dock icon", isOn: $visibilitySettings.showDockIcon)
        Toggle("Show menu bar icon", isOn: $visibilitySettings.showMenuBarIcon)

        Text("Keep at least one access point enabled so Vibez does not disappear.")
          .font(.caption)
          .foregroundStyle(.secondary)

        if let message = visibilitySettings.message {
          Text(message)
            .font(.caption)
            .foregroundStyle(.orange)
        }
      }

      if let errorMessage, !errorMessage.isEmpty {
        Text(errorMessage)
          .font(.caption)
          .foregroundStyle(.red)
      }

      HStack(spacing: 10) {
        if case .update = mode {
          Button("Cancel") {
            dismiss()
          }
          .buttonStyle(.bordered)
        }

        Spacer()

        Button(mode.buttonLabel) {
          save()
        }
        .buttonStyle(.borderedProminent)
        .disabled(isSaving)
      }
    }
    .padding(28)
    .frame(minWidth: 520, minHeight: 440)
  }

  private func save() {
    errorMessage = nil

    let configuration = VibezConfiguration(
      serverURLString: serverURLString,
      listenerName: listenerName.trimmingCharacters(in: .whitespacesAndNewlines),
      username: username.trimmingCharacters(in: .whitespacesAndNewlines),
      password: password
    )

    guard configuration.serverURL != nil else {
      errorMessage = "Enter a valid vibez URL."
      return
    }

    guard !configuration.listenerName.isEmpty else {
      errorMessage = "Choose the name that should appear in the room."
      return
    }

    guard !configuration.password.isEmpty else {
      errorMessage = "Enter the current room password."
      return
    }

    isSaving = true
    Task {
      do {
        try await onSave(configuration)
        await MainActor.run {
          isSaving = false
          dismiss()
        }
      } catch {
        await MainActor.run {
          isSaving = false
          errorMessage = error.localizedDescription
        }
      }
    }
  }
}
