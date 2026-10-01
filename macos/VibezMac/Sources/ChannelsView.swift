import SwiftUI

struct ChannelsView: View {
  @EnvironmentObject private var appModel: VibezAppModel
  @EnvironmentObject private var router: PopoverRouter

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Text("Live now").font(.title2.weight(.semibold))
        Spacer()
        Button {
          router.path.append(.settings)
        } label: {
          Image(systemName: "gearshape")
        }
        .buttonStyle(.borderless)
        .help("Settings")
      }

      if appModel.updateRequired {
        Spacer()
        Text(appModel.errorMessage ?? "Update Vibez: brew upgrade --cask vibez")
          .font(.title3.weight(.semibold))
          .multilineTextAlignment(.center)
          .textSelection(.enabled)
          .frame(maxWidth: .infinity)
        Spacer()
      } else {
        if appModel.directory.isEmpty {
          Spacer()
          Text("Nobody's live — go live?")
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity)
          Spacer()
        } else {
          ScrollView {
            LazyVStack(spacing: 4) {
              ForEach(appModel.directory) { entry in
                row(entry)
              }
            }
          }
        }

        if appModel.user != nil {
          Button {
            router.path.append(.goLive)
          } label: {
            Label("Go live", systemImage: "music.mic")
              .frame(maxWidth: .infinity)
          }
          .buttonStyle(.borderedProminent)
        } else {
          Button {
            Task { await appModel.signIn() }
          } label: {
            Text(appModel.isSigningIn ? "Signing in…" : "Sign in to go live")
              .frame(maxWidth: .infinity)
          }
          .buttonStyle(.borderedProminent)
          .disabled(appModel.isSigningIn)
        }
      }
    }
    .padding(16)
  }

  private func row(_ entry: DirectoryEntry) -> some View {
    Button {
      appModel.joinChannel(id: entry.id)
    } label: {
      HStack(spacing: 10) {
        ArtworkView(url: entry.trackArtwork.flatMap { URL(string: $0) }, size: 44)
        VStack(alignment: .leading, spacing: 2) {
          Text(entry.displayName).bold().lineLimit(1)
          Text(entry.trackTitle ?? "Nothing playing").lineLimit(1)
          Text("\(entry.ownerName) · 🎧 \(entry.activeDjName) · \(entry.listenerCount)" + (entry.djAway ? " · DJ away" : ""))
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        Spacer(minLength: 0)
      }
      .padding(6)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .contextMenu {
      if appModel.isAdmin {
        Button("End channel", role: .destructive) {
          appModel.adminEnd(channelID: entry.id)
        }
      }
    }
  }
}
