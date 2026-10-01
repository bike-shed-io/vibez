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
  @EnvironmentObject private var appModel: VibezAppModel

  @State private var serverURLString: String
  @State private var listenerName: String
  @State private var isSaving = false
  @State private var errorMessage: String?

  init(mode: Mode, onSave: @escaping (VibezConfiguration) async throws -> Void) {
    self.mode = mode
    self.onSave = onSave

    let existing = mode.existingConfiguration
    _serverURLString = State(initialValue: existing?.serverURLString ?? "https://vibez.bike-shed.io")
    _listenerName = State(initialValue: existing?.listenerName ?? Host.current().localizedName ?? "Patrick")
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      VStack(alignment: .leading, spacing: 6) {
        Text(mode.title)
          .font(.largeTitle.weight(.semibold))
        Text("Listening needs no account. Sign in with Google to DJ or add tracks.")
          .font(.subheadline)
          .foregroundStyle(.secondary)
      }

      Group {
        LabeledContent("Server") {
          TextField("https://vibez.bike-shed.io", text: $serverURLString)
            .textFieldStyle(.roundedBorder)
            .frame(width: 320)
        }

        LabeledContent("Name (also your DJ name)") {
          TextField("Your name", text: $listenerName)
            .textFieldStyle(.roundedBorder)
            .frame(width: 220)
        }

        LabeledContent("Account") {
          if let user = appModel.user {
            HStack {
              Text(user.name)
              Button("Sign out") { appModel.signOut() }
            }
          } else {
            Button(appModel.isSigningIn ? "Signing in…" : "Sign in with Google") {
              Task { await appModel.signIn() }
            }
            .disabled(appModel.isSigningIn || appModel.configuration == nil)
          }
        }
      }
      .font(.body)

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
      listenerName: listenerName.trimmingCharacters(in: .whitespacesAndNewlines)
    )

    guard configuration.serverURL != nil else {
      errorMessage = "Enter a valid vibez URL."
      return
    }

    guard !configuration.listenerName.isEmpty else {
      errorMessage = "Choose the name that should appear in the room."
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
