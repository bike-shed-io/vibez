import SwiftUI

struct SettingsView: View {
  @EnvironmentObject private var appModel: VibezAppModel

  @State private var serverURLString = ""
  @State private var listenerName = ""
  @State private var isSaving = false
  @State private var saveError: String?
  @State private var emailDraft = ""

  var body: some View {
    VStack(spacing: 0) {
      BackHeader(title: "Settings")
      Form {
        Section("Connection") {
          TextField("Server", text: $serverURLString)
          // Empty means "use the default" (Google first name, else "Listener").
          TextField("Display name", text: $listenerName, prompt: Text(appModel.listenerName))
          if let saveError {
            Text(saveError).font(.caption).foregroundStyle(.red)
          }
          Button(isSaving ? "Saving…" : "Save & reconnect", action: save)
            .disabled(isSaving || !hasConnectionChanges)
        }

        Section("Account") {
          if let user = appModel.user {
            LabeledContent(user.name) {
              Button("Sign out") { appModel.signOut() }
            }
          } else {
            Button(appModel.isSigningIn ? "Signing in…" : "Sign in with Google") {
              Task { await appModel.signIn() }
            }
            .disabled(appModel.isSigningIn)
            Text("Listening needs no account. Sign in to go live or add tracks.")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
          // Empty shows (and uses) the default: Google given name, else display name.
          TextField("DJ name", text: $appModel.djName, prompt: Text(appModel.effectiveDJName))
        }

        Section("Trusted DJs") {
          ForEach(appModel.trustedEmails, id: \.self) { email in
            LabeledContent(email) {
              Button {
                removeTrusted(email)
              } label: {
                Image(systemName: "minus.circle")
              }
              .buttonStyle(.borderless)
              .help("Remove")
            }
          }
          HStack {
            TextField("Email", text: $emailDraft, prompt: Text("name@example.com"))
              .onSubmit(addTrusted)
            Button("Add", action: addTrusted)
              .disabled(!emailDraft.contains("@"))
          }
          Text("Trusted DJs can take the decks when you're live.")
            .font(.caption)
            .foregroundStyle(.secondary)
        }

        Section("Your mix") {
          LabeledContent("Volume \(appModel.baseVolumeLabel)") {
            Slider(value: $appModel.baseVolume, in: 0...1)
          }
          LabeledContent("Vibez range \(appModel.vibezRangeLabel)") {
            Slider(value: $appModel.vibezRange, in: 0...1)
          }
          LabeledContent("AirPlay") {
            AirPlayPickerView().frame(width: 22, height: 22)
          }
        }

        Section {
          Button("Quit Vibez", role: .destructive) { NSApp.terminate(nil) }
        }
      }
      .formStyle(.grouped)
    }
    .navigationBarBackButtonHidden()
    .onAppear {
      serverURLString = appModel.configuration?.serverURLString ?? ""
      listenerName = appModel.configuration?.listenerName ?? ""
    }
  }

  private var hasConnectionChanges: Bool {
    serverURLString != appModel.configuration?.serverURLString
      || listenerName != appModel.configuration?.listenerName
  }

  private var isLiveOwner: Bool {
    appModel.roles.isOwner
  }

  private func addTrusted() {
    let email = emailDraft.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard email.contains("@") else { return }
    emailDraft = ""
    if isLiveOwner {
      appModel.trust(email: email) // the server's roles update rewrites trustedEmails
    } else if !appModel.trustedEmails.contains(email) {
      appModel.trustedEmails.append(email)
    }
  }

  private func removeTrusted(_ email: String) {
    if isLiveOwner {
      appModel.untrust(email: email)
    } else {
      appModel.trustedEmails.removeAll { $0 == email }
    }
  }

  private func save() {
    saveError = nil
    let configuration = VibezConfiguration(
      serverURLString: serverURLString.trimmingCharacters(in: .whitespacesAndNewlines),
      listenerName: listenerName.trimmingCharacters(in: .whitespacesAndNewlines)
    )
    guard configuration.serverURL != nil else {
      saveError = "Enter a valid vibez URL."
      return
    }
    isSaving = true
    Task {
      do {
        try await appModel.saveConfiguration(configuration)
      } catch {
        saveError = error.localizedDescription
      }
      isSaving = false
    }
  }
}
