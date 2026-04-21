import AppKit
import SwiftUI

struct MenuBarContentView: View {
  @Environment(\.openWindow) private var openWindow
  @EnvironmentObject private var appModel: VibezAppModel

  @State private var draftSeekTime = 0.0
  @State private var isEditingSeek = false

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .center, spacing: 10) {
        Circle()
          .fill(statusColor)
          .frame(width: 9, height: 9)

        VStack(alignment: .leading, spacing: 2) {
          Text("vibez")
            .font(.headline)
          Text(appModel.connectionLabel)
            .font(.caption)
            .foregroundStyle(.secondary)
        }

        Spacer()

        Text(appModel.listenerSummary)
          .font(.caption.weight(.medium))
          .foregroundStyle(.secondary)
      }

      if appModel.configuration == nil {
        Text("Finish one-time setup in the main window before using vibez from the menu bar.")
          .font(.footnote)
          .foregroundStyle(.secondary)

        Button {
          NSApp.activate(ignoringOtherApps: true)
          openWindow(id: "main")
        } label: {
          Label("Open Setup", systemImage: "person.crop.circle.badge.key")
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
      } else {
        HStack(alignment: .top, spacing: 12) {
          Group {
            if let artworkURL = appModel.trackArtworkURL {
              AsyncImage(url: artworkURL) { image in
                image
                  .resizable()
                  .scaledToFill()
              } placeholder: {
                artworkPlaceholder
              }
            } else {
              artworkPlaceholder
            }
          }
          .frame(width: 56, height: 56)
          .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
          .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
              .stroke(Color.white.opacity(0.08), lineWidth: 1)
          )

          VStack(alignment: .leading, spacing: 4) {
            Text(appModel.displayTrackTitle)
              .font(.headline)
              .lineLimit(2)

            if let djName = appModel.djName, !djName.isEmpty {
              Text("DJ: \(djName)")
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            Text(appModel.playbackLabel)
              .font(.caption)
              .foregroundStyle(.secondary)
          }

          Spacer(minLength: 0)
        }

        VStack(alignment: .leading, spacing: 8) {
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
            Text("Nobody else connected right now.")
              .font(.caption)
              .foregroundStyle(.secondary)
          } else {
            ScrollView(.horizontal, showsIndicators: false) {
              HStack(spacing: 6) {
                ForEach(appModel.listeners, id: \.self) { listener in
                  Text(listener)
                    .font(.caption.weight(listener == appModel.djName ? .semibold : .regular))
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    .background(listener == appModel.djName ? Color.orange.opacity(0.25) : Color.secondary.opacity(0.16))
                    .clipShape(Capsule())
                }
              }
              .padding(.vertical, 2)
            }
          }
        }

        VStack(alignment: .leading, spacing: 8) {
          HStack {
            Text("Position")
              .font(.caption.weight(.semibold))
              .textCase(.uppercase)
              .foregroundStyle(.secondary)
            Spacer()
            Text("\(appModel.currentTimeLabel) / \(appModel.durationLabel)")
              .font(.caption.monospacedDigit())
              .foregroundStyle(.secondary)
          }

          Slider(
            value: seekBinding,
            in: 0...seekUpperBound,
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

        Divider()

        VStack(alignment: .leading, spacing: 8) {
          HStack {
            Text("Your Mix")
              .font(.caption.weight(.semibold))
              .textCase(.uppercase)
              .foregroundStyle(.secondary)
            Spacer()
            Text(appModel.liveVolumeLabel)
              .font(.caption)
              .foregroundStyle(.secondary)
          }

          HStack {
            Text("Base")
              .font(.caption2)
              .foregroundStyle(.secondary)
            Spacer()
            Text(appModel.baseVolumeLabel)
              .font(.caption.monospacedDigit())
              .foregroundStyle(.secondary)
          }
          Slider(value: volumeBinding, in: 0...1)

          HStack {
            Text("Range")
              .font(.caption2)
              .foregroundStyle(.secondary)
            Spacer()
            Text(appModel.vibezRangeLabel)
              .font(.caption.monospacedDigit())
              .foregroundStyle(.secondary)
          }
          Slider(value: vibezRangeBinding, in: 0...1)

          HStack {
            Text(appModel.floorVolumeLabel)
            Spacer()
            Text(appModel.liveVolumeLabel)
            Spacer()
            Text(appModel.ceilingVolumeLabel)
          }
          .font(.caption2.monospacedDigit())
          .foregroundStyle(.secondary)
        }

        Divider()

        HStack(spacing: 10) {
          Button {
            if appModel.isDJ {
              appModel.releaseDJ()
            } else {
              appModel.claimDJ()
            }
          } label: {
            Label(appModel.isDJ ? "Stop DJ" : "Become DJ", systemImage: appModel.isDJ ? "stop.circle" : "music.mic")
              .frame(maxWidth: .infinity)
          }
          .buttonStyle(.bordered)

          Button {
            appModel.playTrackDraft()
          } label: {
            Label("Play URL", systemImage: "play.fill")
              .frame(maxWidth: .infinity)
          }
          .buttonStyle(.borderedProminent)
          .disabled(!appModel.isDJ || appModel.trackDraftURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }

        TextField("SoundCloud URL…", text: $appModel.trackDraftURL)
          .textFieldStyle(.roundedBorder)
          .disabled(!appModel.isDJ)

        HStack(spacing: 10) {
          Button {
            if appModel.isPlaying {
              appModel.pauseAsDJIfPossible()
            } else {
              appModel.resumeAsDJIfPossible()
            }
          } label: {
            Label(appModel.isPlaying ? "Pause" : "Resume", systemImage: appModel.isPlaying ? "pause.fill" : "play.fill")
              .frame(maxWidth: .infinity)
          }
          .buttonStyle(.bordered)
          .disabled(!appModel.isDJ || !appModel.hasTrack)

          Button {
            appModel.seek(to: 0)
          } label: {
            Label("Restart", systemImage: "backward.end.fill")
              .frame(maxWidth: .infinity)
          }
          .buttonStyle(.bordered)
          .disabled(!appModel.isDJ || !appModel.hasTrack)
        }

        VStack(alignment: .leading, spacing: 8) {
          HStack {
            Text("Vibez")
              .font(.caption.weight(.semibold))
              .textCase(.uppercase)
              .foregroundStyle(.secondary)
            Spacer()
            Text(appModel.vibezLevelLabel)
              .font(.caption.monospacedDigit())
              .foregroundStyle(.secondary)
          }

          Slider(value: vibezBinding, in: -1...1)

          HStack {
            Text("Lower")
            Spacer()
            Text("Neutral")
            Spacer()
            Text("Lift")
          }
          .font(.caption2.weight(.medium))
          .foregroundStyle(.secondary)

          Text("Collaborative: any listener can steer this.")
            .font(.caption2)
            .foregroundStyle(.secondary)
        }

        if let errorMessage = appModel.errorMessage, !errorMessage.isEmpty {
          Text(errorMessage)
            .font(.caption)
            .foregroundStyle(.red)
        }
      }

      Divider()

      Button {
        NSApp.activate(ignoringOtherApps: true)
        openWindow(id: "main")
      } label: {
        Label("Open Vibez", systemImage: "play.rectangle.fill")
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.borderedProminent)

      HStack(spacing: 10) {
        Button {
          appModel.reconnect()
        } label: {
          Label("Reconnect", systemImage: "arrow.clockwise")
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .disabled(appModel.configuration == nil)

        Button(role: .destructive) {
          NSApplication.shared.terminate(nil)
        } label: {
          Label("Quit", systemImage: "power")
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
      }
    }
    .padding(16)
    .frame(width: 370)
  }

  private var artworkPlaceholder: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .fill(Color.orange.opacity(0.2))
      Image(systemName: "waveform")
        .font(.system(size: 18, weight: .medium))
        .foregroundStyle(.orange)
    }
  }

  private var volumeBinding: Binding<Double> {
    Binding(
      get: { appModel.baseVolume },
      set: { appModel.baseVolume = $0 }
    )
  }

  private var vibezRangeBinding: Binding<Double> {
    Binding(
      get: { appModel.vibezRange },
      set: { appModel.vibezRange = $0 }
    )
  }

  private var vibezBinding: Binding<Double> {
    Binding(
      get: { appModel.vibezLevel },
      set: { appModel.setVibezLevel($0) }
    )
  }

  private var seekBinding: Binding<Double> {
    Binding(
      get: { isEditingSeek ? draftSeekTime : appModel.currentTime },
      set: { draftSeekTime = $0 }
    )
  }

  private var seekUpperBound: Double {
    let duration = appModel.duration
    if duration > 0 {
      return duration
    }
    return max(appModel.currentTime, 1)
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
