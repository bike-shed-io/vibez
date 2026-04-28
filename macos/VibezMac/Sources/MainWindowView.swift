import AppKit
import SwiftUI

struct MainWindowView: View {
  @EnvironmentObject private var appModel: VibezAppModel
  @EnvironmentObject private var visibilitySettings: AppVisibilitySettings
  @State private var showingSetup = false
  @State private var draftSeekTime = 0.0
  @State private var isEditingSeek = false

  var body: some View {
    Group {
      if appModel.configuration == nil {
        SetupView(mode: .firstRun) { configuration in
          try await appModel.saveConfiguration(configuration)
        }
      } else {
        mainClient
          .sheet(isPresented: $showingSetup) {
            SetupView(mode: .update(existing: appModel.configuration)) { configuration in
              try await appModel.saveConfiguration(configuration)
            }
          }
      }
    }
    .frame(minWidth: 430, minHeight: 720)
    .background(Color(nsColor: .windowBackgroundColor))
    .background {
      WindowAccessor { window in
        configure(window)
      }
    }
    .onReceive(NotificationCenter.default.publisher(for: .vibezOpenSetupRequested)) { _ in
      showingSetup = true
      NSApp.activate(ignoringOtherApps: true)
      if let window = NSApp.windows.first(where: { $0.identifier?.rawValue == "main" }) {
        window.makeKeyAndOrderFront(nil)
      }
    }
  }

  private func configure(_ window: NSWindow) {
    window.identifier = NSUserInterfaceItemIdentifier("main")
    window.isReleasedWhenClosed = false
    window.delegate = HideOnCloseWindowDelegate.shared
  }

  private var mainClient: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        header
        nowPlayingCard
        listenerMixCard
        djCard
        listenersCard
        appSettingsCard
      }
      .padding(20)
    }
  }

  private var header: some View {
    HStack(alignment: .top, spacing: 12) {
      VStack(alignment: .leading, spacing: 6) {
        Text("vibez")
          .font(.largeTitle.weight(.semibold))
        Text("Native Mac alpha for the shared team radio.")
          .font(.subheadline)
          .foregroundStyle(.secondary)

        HStack(spacing: 8) {
          Circle()
            .fill(statusColor)
            .frame(width: 10, height: 10)
          Text(appModel.connectionLabel)
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)
          Text("as \(appModel.listenerName)")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }

      Spacer()

      Button {
        appModel.reconnect()
      } label: {
        Label("Reconnect", systemImage: "arrow.clockwise")
      }

      Button {
        showingSetup = true
      } label: {
        Label("Setup", systemImage: "person.crop.circle.badge.key")
      }
    }
  }

  private var nowPlayingCard: some View {
    card {
      VStack(alignment: .leading, spacing: 14) {
        Text("Now Playing")
          .font(.caption.weight(.semibold))
          .textCase(.uppercase)
          .foregroundStyle(.secondary)

        HStack(alignment: .top, spacing: 14) {
          artworkView

          VStack(alignment: .leading, spacing: 6) {
            Text(appModel.displayTrackTitle)
              .font(.title3.weight(.semibold))
              .lineLimit(3)

            Text(appModel.djLine)
              .font(.subheadline)
              .foregroundStyle(.secondary)

            Text(appModel.playbackLabel)
              .font(.caption)
              .foregroundStyle(.secondary)
          }

          Spacer()
        }

        VStack(alignment: .leading, spacing: 8) {
          HStack {
            Text(appModel.currentTimeLabel)
              .font(.caption.monospacedDigit())
              .foregroundStyle(.secondary)
            Spacer()
            Text(appModel.durationLabel)
              .font(.caption.monospacedDigit())
              .foregroundStyle(.secondary)
          }

          Slider(
            value: Binding(
              get: { isEditingSeek ? draftSeekTime : appModel.currentTime },
              set: { draftSeekTime = $0 }
            ),
            in: 0...max(appModel.duration, 1),
            onEditingChanged: { editing in
              isEditingSeek = editing
              if editing {
                draftSeekTime = appModel.currentTime
              } else {
                appModel.seek(to: draftSeekTime)
              }
            }
          )
          .disabled(!appModel.hasTrack)
        }
      }
    }
  }

  private var artworkView: some View {
    Group {
      if let artworkURL = appModel.trackArtworkURL {
        AsyncImage(url: artworkURL) { image in
          image
            .resizable()
            .scaledToFill()
        } placeholder: {
          placeholderArtwork
        }
      } else {
        placeholderArtwork
      }
    }
    .frame(width: 88, height: 88)
    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .stroke(.white.opacity(0.08), lineWidth: 1)
    )
  }

  private var placeholderArtwork: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .fill(Color.orange.opacity(0.18))
      Image(systemName: "waveform")
        .font(.system(size: 28, weight: .medium))
        .foregroundStyle(.orange)
    }
  }

  private var listenerMixCard: some View {
    card {
      VStack(alignment: .leading, spacing: 16) {
        Text("Your Mix")
          .font(.caption.weight(.semibold))
          .textCase(.uppercase)
          .foregroundStyle(.secondary)

        VStack(alignment: .leading, spacing: 8) {
          labeledValue(title: "Base Volume", value: appModel.baseVolumeLabel)
          Slider(value: $appModel.baseVolume, in: 0...1)
        }

        VStack(alignment: .leading, spacing: 8) {
          labeledValue(title: "Vibez Range", value: appModel.vibezRangeLabel)
          Slider(value: $appModel.vibezRange, in: 0...1)
          Text("How far room vibez can nudge you down or up around your base volume.")
            .font(.caption)
            .foregroundStyle(.secondary)
        }

        VStack(alignment: .leading, spacing: 8) {
          labeledValue(title: "Room Vibez", value: appModel.vibezLevelLabel)
          Slider(value: vibezBinding, in: -1...1)

          HStack {
            Text("Lower")
            Spacer()
            Text("Neutral")
            Spacer()
            Text("Lift")
          }
          .font(.caption.weight(.medium))
          .foregroundStyle(.secondary)

          Text("Collaborative control: any listener can steer this.")
            .font(.caption)
            .foregroundStyle(.secondary)
        }

        VStack(alignment: .leading, spacing: 10) {
          HStack {
            Text("Window")
              .font(.caption.weight(.semibold))
              .foregroundStyle(.secondary)
            Spacer()
            Text(appModel.liveVolumeLabel)
              .font(.caption.weight(.medium))
              .foregroundStyle(.secondary)
          }

          GeometryReader { proxy in
            ZStack(alignment: .leading) {
              Capsule()
                .fill(Color.secondary.opacity(0.18))
                .frame(height: 8)

              Capsule()
                .fill(LinearGradient(colors: [Color.blue.opacity(0.3), Color.white.opacity(0.28), Color.orange.opacity(0.3)], startPoint: .leading, endPoint: .trailing))
                .frame(width: proxy.size.width * appModel.allowedBandWidth, height: 8)
                .offset(x: proxy.size.width * appModel.allowedBandStart)

              Circle()
                .fill(Color.white)
                .frame(width: 12, height: 12)
                .offset(x: markerOffset(width: proxy.size.width, fraction: appModel.baseVolume))

              Circle()
                .fill(liveMarkerColor)
                .frame(width: 14, height: 14)
                .offset(x: markerOffset(width: proxy.size.width, fraction: appModel.liveVolume))
            }
          }
          .frame(height: 16)

          HStack {
            Text(appModel.floorVolumeLabel)
            Spacer()
            Text(appModel.liveVolumeLabel)
            Spacer()
            Text(appModel.ceilingVolumeLabel)
          }
          .font(.caption.monospacedDigit())
          .foregroundStyle(.secondary)
        }
      }
    }
  }

  private var appSettingsCard: some View {
    card {
      VStack(alignment: .leading, spacing: 14) {
        Text("App Settings")
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
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private var djCard: some View {
    card {
      VStack(alignment: .leading, spacing: 16) {
        HStack {
          VStack(alignment: .leading, spacing: 4) {
            Text("DJ Booth")
              .font(.caption.weight(.semibold))
              .textCase(.uppercase)
              .foregroundStyle(.secondary)
            Text(appModel.isDJ ? "You are currently steering playback." : "Claim DJ mode to drive playback.")
              .font(.subheadline)
              .foregroundStyle(.secondary)
          }

          Spacer()

          if appModel.isDJ {
            Button {
              appModel.releaseDJ()
            } label: {
              Label("Stop DJing", systemImage: "stop.circle.fill")
            }
            .buttonStyle(.bordered)
            .disabled(!appModel.isRoomConnected)
          } else {
            Button {
              appModel.claimDJ()
            } label: {
              Label("Become DJ", systemImage: "music.mic.circle.fill")
            }
            .buttonStyle(.borderedProminent)
            .disabled(!appModel.isRoomConnected)
          }
        }

        VStack(alignment: .leading, spacing: 8) {
          TextField("Paste SoundCloud URL…", text: $appModel.trackDraftURL)
            .textFieldStyle(.roundedBorder)
            .disabled(!appModel.isDJ)

          HStack(spacing: 10) {
            Button("Play") {
              appModel.playTrackDraft()
            }
            .buttonStyle(.borderedProminent)
            .disabled(!appModel.isDJ || appModel.trackDraftURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

            Button("Pause") {
              appModel.pauseAsDJIfPossible()
            }
            .buttonStyle(.bordered)
            .disabled(!appModel.isDJ || !appModel.hasTrack)

            Button("Resume") {
              appModel.resumeAsDJIfPossible()
            }
            .buttonStyle(.bordered)
            .disabled(!appModel.isDJ || !appModel.hasTrack)
          }
        }
      }
    }
  }

  private var listenersCard: some View {
    card {
      VStack(alignment: .leading, spacing: 12) {
        HStack {
          Text("Listeners")
            .font(.caption.weight(.semibold))
            .textCase(.uppercase)
            .foregroundStyle(.secondary)
          Spacer()
          Text(appModel.listenerSummary)
            .font(.caption)
            .foregroundStyle(.secondary)
        }

        if appModel.listeners.isEmpty {
          Text("Nobody else is connected right now.")
            .font(.subheadline)
            .foregroundStyle(.secondary)
        } else {
          FlowLayout(spacing: 8) {
            ForEach(appModel.listeners, id: \.self) { listener in
              Text(listener)
                .font(.caption.weight(listener == appModel.djName ? .semibold : .regular))
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(listener == appModel.djName ? Color.orange.opacity(0.22) : Color.secondary.opacity(0.12))
                .clipShape(Capsule())
            }
          }
        }

        if let errorMessage = appModel.errorMessage, !errorMessage.isEmpty {
          Text(errorMessage)
            .font(.caption)
            .foregroundStyle(.red)
        }
      }
    }
  }

  private func card<Content: View>(@ViewBuilder content: () -> Content) -> some View {
    content()
      .padding(18)
      .background(
        RoundedRectangle(cornerRadius: 24, style: .continuous)
          .fill(Color.white.opacity(0.04))
      )
      .overlay(
        RoundedRectangle(cornerRadius: 24, style: .continuous)
          .stroke(Color.white.opacity(0.08), lineWidth: 1)
      )
  }

  private func labeledValue(title: String, value: String) -> some View {
    HStack {
      Text(title)
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
      Spacer()
      Text(value)
        .font(.caption.monospacedDigit())
        .foregroundStyle(.secondary)
    }
  }

  private func markerOffset(width: CGFloat, fraction: Double) -> CGFloat {
    let clamped = max(0, min(1, fraction))
    return max(0, CGFloat(clamped) * width - 7)
  }

  private var vibezBinding: Binding<Double> {
    Binding(
      get: { appModel.vibezLevel },
      set: { appModel.setVibezLevel($0) }
    )
  }

  private var liveMarkerColor: Color {
    if appModel.vibezLevel < -0.001 { return .blue }
    if appModel.vibezLevel > 0.001 { return .orange }
    return .white
  }

  private var statusColor: Color {
    switch appModel.connectionState {
    case .connected:
      return .green
    case .connecting:
      return .orange
    case .setupRequired:
      return .secondary
    case .disconnected:
      return .red
    }
  }
}

private struct FlowLayout<Content: View>: View {
  let spacing: CGFloat
  let content: Content

  init(spacing: CGFloat = 8, @ViewBuilder content: () -> Content) {
    self.spacing = spacing
    self.content = content()
  }

  var body: some View {
    content
      .frame(maxWidth: .infinity, alignment: .leading)
  }
}
