import SwiftUI

struct NowPlayingView: View {
  @EnvironmentObject private var appModel: VibezAppModel
  @EnvironmentObject private var router: PopoverRouter

  @State private var draftSeekTime = 0.0
  @State private var isEditingSeek = false
  @State private var renameDraft = ""
  @State private var isRenaming = false

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        if let channel = appModel.currentChannel {
          header(channel)
          nowPlaying
          if appModel.isDJ { djControls }
          if (appModel.roles.isTrusted || appModel.roles.isOwner) && !appModel.isDJ {
            Button {
              appModel.takeDecks()
            } label: {
              Label("Take the decks", systemImage: "music.mic")
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(!appModel.isRoomConnected)
          }
          Divider()
          mix
          Divider()
          queue
          Divider()
          listeners
          if appModel.roles.isOwner {
            Divider()
            ownerFooter(channel)
          }
          Divider()
          HStack {
            sectionTitle("AirPlay")
            Spacer()
            AirPlayPickerView().frame(width: 22, height: 22)
          }
          if let errorMessage = appModel.errorMessage, !errorMessage.isEmpty {
            Text(errorMessage).font(.caption).foregroundStyle(.red)
          }
        }
      }
      .padding(16)
    }
  }

  // MARK: - Sections

  private func header(_ channel: ChannelInfo) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Button {
          appModel.leaveChannel()
        } label: {
          HStack(spacing: 4) {
            Image(systemName: "chevron.left")
            Text(channel.displayName).lineLimit(1)
          }
          .font(.callout.weight(.medium))
          .padding(.horizontal, 10)
          .padding(.vertical, 5)
          .background(Color.secondary.opacity(0.15), in: Capsule())
        }
        .buttonStyle(.plain)
        .help("Back to channels")
        .accessibilityLabel("Back to channels from \(channel.displayName)")

        Spacer()

        Button {
          router.path.append(.settings)
        } label: {
          Image(systemName: "gearshape")
        }
        .buttonStyle(.borderless)
        .help("Settings")
      }

      Text("🎧 \(channel.activeDjName)" + (channel.djAway ? " (away)" : ""))
        .font(.subheadline)
        .foregroundStyle(.secondary)
    }
  }

  private var nowPlaying: some View {
    VStack(spacing: 10) {
      ArtworkView(url: appModel.trackArtworkURL, size: 160)
      Text(appModel.displayTrackTitle)
        .font(.headline)
        .multilineTextAlignment(.center)
        .lineLimit(2)
      Text(appModel.playbackLabel)
        .font(.caption)
        .foregroundStyle(.secondary)

      Slider(
        value: Binding(
          get: { isEditingSeek ? draftSeekTime : appModel.currentTime },
          set: { draftSeekTime = $0 }
        ),
        in: 0...max(appModel.duration, appModel.currentTime, 1),
        onEditingChanged: { editing in
          isEditingSeek = editing
          if editing {
            draftSeekTime = appModel.currentTime
          } else {
            appModel.seek(to: draftSeekTime)
          }
        }
      )
      .disabled(!appModel.isDJ || !appModel.isRoomConnected || !appModel.hasTrack)

      HStack {
        Text(appModel.currentTimeLabel)
        Spacer()
        Text(appModel.durationLabel)
      }
      .font(.caption.monospacedDigit())
      .foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity)
  }

  private var djControls: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 6) {
        TextField("SoundCloud URL…", text: $appModel.trackDraftURL)
          .textFieldStyle(.roundedBorder)
          .onSubmit { appModel.playTrackDraft() }
        Button("Play") { appModel.playTrackDraft() }
          .buttonStyle(.borderedProminent)
          .disabled(isBlank(appModel.trackDraftURL))
      }

      HStack(spacing: 8) {
        Button {
          appModel.pauseAsDJIfPossible()
        } label: {
          Label("Pause", systemImage: "pause.fill").frame(maxWidth: .infinity)
        }
        .disabled(!appModel.hasTrack)

        Button {
          appModel.resumeAsDJIfPossible()
        } label: {
          Label("Resume", systemImage: "play.fill").frame(maxWidth: .infinity)
        }
        .disabled(!appModel.hasTrack)

        Button {
          appModel.seek(to: 0)
        } label: {
          Label("Restart", systemImage: "backward.end.fill").frame(maxWidth: .infinity)
        }
        .disabled(!appModel.hasTrack)
      }
      .buttonStyle(.bordered)
    }
    .disabled(!appModel.isRoomConnected)
  }

  private var mix: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        sectionTitle("Room vibez")
        Spacer()
        Text(appModel.vibezLevelLabel).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
      }
      Slider(value: Binding(get: { appModel.vibezLevel }, set: { appModel.setVibezLevel($0) }), in: -1...1)
        .disabled(!appModel.isRoomConnected)
      HStack {
        Text("Lower")
        Spacer()
        Text("Neutral")
        Spacer()
        Text("Lift")
      }
      .font(.caption2.weight(.medium))
      .foregroundStyle(.secondary)

      volumeBand
        .padding(.top, 4)

      HStack {
        Text("Volume \(appModel.baseVolumeLabel)").frame(width: 92, alignment: .leading)
        Slider(value: $appModel.baseVolume, in: 0...1)
      }
      .font(.caption.monospacedDigit())
      HStack {
        Text("Range \(appModel.vibezRangeLabel)").frame(width: 92, alignment: .leading)
        Slider(value: $appModel.vibezRange, in: 0...1)
      }
      .font(.caption.monospacedDigit())
    }
  }

  /// The band of volumes room vibez may move you through, with markers for your base and live volume.
  private var volumeBand: some View {
    VStack(spacing: 4) {
      GeometryReader { proxy in
        ZStack(alignment: .leading) {
          Capsule()
            .fill(Color.secondary.opacity(0.18))
            .frame(height: 8)
          Capsule()
            .fill(LinearGradient(colors: [.blue.opacity(0.3), .white.opacity(0.28), .orange.opacity(0.3)], startPoint: .leading, endPoint: .trailing))
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
      .font(.caption2.monospacedDigit())
      .foregroundStyle(.secondary)
    }
  }

  private var queue: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        sectionTitle("Queue")
        Spacer()
        Text(appModel.queueSummary).font(.caption).foregroundStyle(.secondary)
      }

      if appModel.user != nil {
        HStack(spacing: 6) {
          TextField("Add SoundCloud URL to queue…", text: $appModel.queueDraftURL)
            .textFieldStyle(.roundedBorder)
            .onSubmit { appModel.addToQueue() }
          Button("Add") { appModel.addToQueue() }
            .buttonStyle(.borderedProminent)
            .disabled(isBlank(appModel.queueDraftURL))
        }
        .disabled(!appModel.isRoomConnected)
      } else {
        Button(appModel.isSigningIn ? "Signing in…" : "Sign in to add tracks") {
          Task { await appModel.signIn() }
        }
        .disabled(appModel.isSigningIn)
      }

      if appModel.isDJ {
        HStack(spacing: 8) {
          Button {
            appModel.skipQueue()
          } label: {
            Label("Skip", systemImage: "forward.fill")
          }
          .disabled(appModel.queue.isEmpty)
          Button {
            appModel.shuffleQueue()
          } label: {
            Label("Shuffle", systemImage: "shuffle")
          }
          .disabled(appModel.queue.count < 2)
          Button(role: .destructive) {
            appModel.clearQueue()
          } label: {
            Label("Clear", systemImage: "trash")
          }
          .disabled(appModel.queue.isEmpty)
        }
        .buttonStyle(.bordered)
        .disabled(!appModel.isRoomConnected)
      }

      if appModel.queue.isEmpty {
        Text("Queue is empty").font(.caption).foregroundStyle(.secondary)
      } else {
        ForEach(Array(appModel.queue.enumerated()), id: \.element.id) { index, item in
          queueRow(item, index: index)
        }
      }
    }
  }

  private func queueRow(_ item: QueueItem, index: Int) -> some View {
    HStack(spacing: 8) {
      Text("\(index + 1)")
        .font(.caption.weight(.bold).monospacedDigit())
        .foregroundStyle(.secondary)
        .frame(width: 18)
      VStack(alignment: .leading, spacing: 2) {
        Text(item.title ?? "Unknown Track").font(.caption.weight(.semibold)).lineLimit(1)
        Text("added by \(item.addedBy)").font(.caption2).foregroundStyle(.secondary)
      }
      Spacer(minLength: 0)
      if appModel.isDJ {
        Group {
          Button {
            appModel.reorderQueue(itemId: item.id, toIndex: index - 1)
          } label: {
            Image(systemName: "chevron.up")
          }
          .disabled(index == 0)
          .help("Move up")
          Button {
            appModel.reorderQueue(itemId: item.id, toIndex: index + 1)
          } label: {
            Image(systemName: "chevron.down")
          }
          .disabled(index == appModel.queue.count - 1)
          .help("Move down")
          Button {
            appModel.removeFromQueue(itemId: item.id)
          } label: {
            Image(systemName: "xmark").foregroundStyle(.red)
          }
          .help("Remove")
        }
        .font(.caption2)
        .buttonStyle(.borderless)
        .disabled(!appModel.isRoomConnected)
      }
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 6)
    .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
  }

  private var listeners: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        sectionTitle("Listeners")
        Spacer()
        Text(appModel.listenerSummary).font(.caption).foregroundStyle(.secondary)
      }

      if appModel.roles.isOwner {
        // Owners see signed-in listeners they can hand the decks to.
        ForEach(appModel.trustablePeople) { person in
          HStack {
            VStack(alignment: .leading, spacing: 1) {
              Text(person.name).font(.caption.weight(.semibold))
              Text(person.email).font(.caption2).foregroundStyle(.secondary)
            }
            Spacer()
            if person.trusted {
              Button("Remove") { appModel.untrust(email: person.email) }
            } else {
              Button("Trust as DJ") { appModel.trust(email: person.email) }
            }
          }
          .controlSize(.small)
          .disabled(!appModel.isRoomConnected)
        }
      }

      if appModel.listeners.isEmpty {
        Text("Nobody else connected right now.").font(.caption).foregroundStyle(.secondary)
      } else {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 6) {
            ForEach(appModel.listeners, id: \.self) { listener in
              let isDJ = listener == appModel.currentChannel?.activeDjName
              Text(listener)
                .font(.caption.weight(isDJ ? .semibold : .regular))
                .padding(.horizontal, 9)
                .padding(.vertical, 5)
                .background(isDJ ? Color.orange.opacity(0.25) : Color.secondary.opacity(0.16), in: Capsule())
            }
          }
        }
      }
    }
  }

  private func ownerFooter(_ channel: ChannelInfo) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      if isRenaming {
        HStack(spacing: 6) {
          TextField("Room name", text: $renameDraft)
            .textFieldStyle(.roundedBorder)
            .onSubmit(saveRename)
          Button("Save", action: saveRename)
            .buttonStyle(.borderedProminent)
          Button("Cancel") { isRenaming = false }
        }
      } else {
        HStack(spacing: 8) {
          Button {
            renameDraft = channel.roomName ?? ""
            isRenaming = true
          } label: {
            Label("Rename", systemImage: "pencil").frame(maxWidth: .infinity)
          }
          Button(role: .destructive) {
            appModel.endLive()
          } label: {
            Label("End channel", systemImage: "stop.circle").frame(maxWidth: .infinity)
          }
        }
        .buttonStyle(.bordered)
      }
    }
    .disabled(!appModel.isRoomConnected)
  }

  // MARK: - Helpers

  private func saveRename() {
    appModel.renameRoom(renameDraft.trimmingCharacters(in: .whitespacesAndNewlines))
    isRenaming = false
  }

  private func sectionTitle(_ title: String) -> some View {
    Text(title)
      .font(.caption.weight(.semibold))
      .textCase(.uppercase)
      .foregroundStyle(.secondary)
  }

  private func isBlank(_ text: String) -> Bool {
    text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  private func markerOffset(width: CGFloat, fraction: Double) -> CGFloat {
    max(0, CGFloat(max(0, min(1, fraction))) * width - 7)
  }

  private var liveMarkerColor: Color {
    if appModel.vibezLevel < -0.001 { return .blue }
    if appModel.vibezLevel > 0.001 { return .orange }
    return .white
  }
}
