import SwiftUI

struct GoLiveView: View {
  @EnvironmentObject private var appModel: VibezAppModel
  @EnvironmentObject private var router: PopoverRouter
  @State private var djDraft = ""

  var body: some View {
    VStack(spacing: 0) {
      BackHeader(title: "Go live")
      Form {
        TextField("DJ name", text: $djDraft)
        TextField("Room name (optional)", text: $appModel.roomName)
        Button("Start") {
          appModel.djName = djDraft.trimmingCharacters(in: .whitespacesAndNewlines) // persist what they went live with
          appModel.goLive()
        }
        .buttonStyle(.borderedProminent)
        .disabled(
          djDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || appModel.user == nil
            || !appModel.isRoomConnected
        )
        if appModel.user == nil {
          Text("Sign in to go live.").font(.caption).foregroundStyle(.secondary)
        }
        if let errorMessage = appModel.errorMessage, !errorMessage.isEmpty {
          Text(errorMessage).font(.caption).foregroundStyle(.red)
        }
      }
      .formStyle(.grouped)
    }
    .navigationBarBackButtonHidden()
    .onAppear { djDraft = appModel.effectiveDJName }
    .onChange(of: appModel.currentChannel) { _, channel in
      if channel != nil { router.path.removeAll() }
    }
  }
}
