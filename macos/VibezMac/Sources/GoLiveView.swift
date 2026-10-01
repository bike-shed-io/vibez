import SwiftUI

struct GoLiveView: View {
  @EnvironmentObject private var appModel: VibezAppModel
  @EnvironmentObject private var router: PopoverRouter

  var body: some View {
    VStack(spacing: 0) {
      BackHeader(title: "Go live")
      Form {
        TextField("DJ name", text: $appModel.djName)
        TextField("Room name (optional)", text: $appModel.roomName)
        Button("Start") { appModel.goLive() }
          .buttonStyle(.borderedProminent)
          .disabled(
            appModel.djName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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
    .onChange(of: appModel.currentChannel) { _, channel in
      if channel != nil { router.path.removeAll() }
    }
  }
}
