import SwiftUI

enum PopoverRoute: Hashable {
  case goLive
  case settings
}

@MainActor
final class PopoverRouter: ObservableObject {
  @Published var path: [PopoverRoute] = []
}

struct PopoverRootView: View {
  @EnvironmentObject private var appModel: VibezAppModel
  @EnvironmentObject private var router: PopoverRouter

  var body: some View {
    VStack(spacing: 0) {
      // updateRequired: ChannelsView shows the update message instead, and reconnecting can't help.
      if appModel.connectionState != .connected && !appModel.updateRequired {
        HStack {
          Text(appModel.connectionLabel)
          Spacer()
          Button("Reconnect") { appModel.reconnect() }
            .controlSize(.small)
        }
        .font(.caption)
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
        .background(Color.orange.opacity(0.15))
      }

      NavigationStack(path: $router.path) {
        Group {
          if appModel.currentChannel != nil && !appModel.updateRequired {
            NowPlayingView()
          } else {
            ChannelsView()
          }
        }
        .navigationDestination(for: PopoverRoute.self) { route in
          switch route {
          case .goLive: GoLiveView()
          case .settings: SettingsView()
          }
        }
      }
    }
    .frame(width: 390, height: 640)
    .overlay(alignment: .bottom) {
      if let notice = appModel.notice {
        Text(notice)
          .font(.callout)
          .padding(8)
          .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
          .padding()
          .task(id: notice) {
            try? await Task.sleep(for: .seconds(4))
            appModel.notice = nil
          }
      }
    }
  }
}

/// Header for pushed screens: AppKit popovers have no toolbar, so NavigationStack shows no back button.
struct BackHeader: View {
  let title: String
  @EnvironmentObject private var router: PopoverRouter

  var body: some View {
    HStack {
      Button {
        _ = router.path.popLast()
      } label: {
        Label("Back", systemImage: "chevron.left")
      }
      .buttonStyle(.borderless)
      Spacer()
      Text(title).font(.headline)
      Spacer()
      Label("Back", systemImage: "chevron.left").hidden() // balances the back button so the title centers
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 10)
  }
}

/// Track artwork with a waveform placeholder.
struct ArtworkView: View {
  let url: URL?
  let size: CGFloat

  var body: some View {
    AsyncImage(url: url) { image in
      image.resizable().scaledToFill()
    } placeholder: {
      ZStack {
        Color.orange.opacity(0.2)
        Image(systemName: "waveform")
          .font(.system(size: size * 0.3, weight: .medium))
          .foregroundStyle(.orange)
      }
    }
    .frame(width: size, height: size)
    .clipShape(RoundedRectangle(cornerRadius: size * 0.18, style: .continuous))
  }
}
