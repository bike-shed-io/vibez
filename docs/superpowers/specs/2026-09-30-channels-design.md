# Channels Design

## Goal

Replace the single global station with person-based live channels, like Twitch: anyone signed in can go live, everyone can browse live channels and listen in. The owner can trust other people to take over the decks when they're away.

This is part 2 of 3. It depends on part 1 (`2026-09-28-google-auth-design.md`). Part 3 (later) adds persistence: server-side trusted lists, persistent rooms, Slack account linking (issue #8).

## Concepts

- **Channel**: one person's live session. Exists only in memory; ends as described below.
- **Owner**: the signed-in user who went live. The channel is named after them. Identified by Google email.
- **Active DJ**: whoever controls playback right now. Starts as the owner.
- **Trusted DJs**: Google emails the owner allows to take the decks.
- **Lobby**: a connection that is not in any channel.

Every channel is visible to everyone. Listening needs no sign-in.

## Server Model

`station` becomes `channels: Map<string, Channel>`:

```ts
type Channel = {
  id: string;              // short random id, used in URLs
  ownerEmail: string;
  ownerName: string;       // DJ name sent on live:start
  ownerPicture: string | null;
  roomName: string | null;
  trustedEmails: Set<string>;
  activeDjEmail: string;
  activeDjName: string;
  startedAt: number;
  lastPlaybackAt: number;  // last time something was playing
  activeDjGoneSince: number | null;
  // plus today's station state: track fields, isPlaying, position,
  // positionTimestamp, vibezBoost, listeners, queue
};
```

- One live channel per owner email. `live:start` while already live updates the names and trusted list, and joins that channel.
- An owner can be connected from several devices (web + Mac). All of them belong to the same channel.
- Each connection stores `channelId: string | null` plus the user from part 1 (or anonymous).

## Protocol

Clients send `protocol: 2` in their first message. The server answers older clients with `{ type: "error", message: "Update Vibez: brew upgrade --cask vibez" }` and closes the connection.

Client → server:

| Message | Who | Effect |
|---|---|---|
| `hello {protocol, displayName}` | anyone | Sets the display name; connection starts in the lobby and gets `channels`. |
| `live:start {djName, roomName, trustedEmails}` | signed in | Creates (or updates) your channel and joins it. |
| `live:end` | owner | Ends the channel. |
| `live:rename {roomName}` | owner | Renames the room. |
| `live:trust {email}` / `live:untrust {email}` | owner | Edits the trusted list. Untrusting the active DJ gives the decks back to the owner. |
| `dj:take` | owner or trusted, in the channel | Becomes active DJ. Broadcasts `dj:changed {djName, by}`. |
| `channel:join {id}` / `channel:leave` | anyone | Moves between channels and lobby. |
| `dj:*` (play, pause, resume, seek, position, ...) | active DJ's connections | As today, scoped to the channel. |
| `queue:*` | any signed-in member | As today, scoped to the channel. |
| `vibez:boost` | any member | As today, scoped to the channel. |
| `admin:end {id}` | `ADMIN_EMAILS` | Ends any channel. |

`dj:claim` and `dj:release` are removed (replaced by `live:start`, `dj:take`, `live:end`). `join` is replaced by `hello` + `channel:join`.

Server → client:

- `channels`: directory list for everyone (lobby and in-channel), throttled to at most one per second. Each entry: `id, ownerName, ownerPicture, roomName, activeDjName, djAway, trackTitle, trackArtwork, listenerCount`.
- `channel:state`: full snapshot on join (today's `sync` payload plus owner, active DJ, room, trusted flag for the receiver).
- `channel:ended {reason}`: members go back to the lobby.
- Today's per-track, play, and queue messages, sent only to the channel's members.

## Channel End Rules

A channel ends when:

1. The owner sends `live:end`.
2. The active DJ has had no connection for 2 minutes. When the active DJ disconnects, the decks first fall back to the owner if the owner is connected; the 2-minute clock only runs while neither the active DJ nor the owner is connected. While the active DJ is gone, the channel shows `djAway: true`.
3. Nothing has played for 10 minutes (`lastPlaybackAt`).
4. An admin sends `admin:end`.

Listeners keep hearing the current track while the DJ is away, because each client streams from SoundCloud itself.

Timers use an injectable clock so tests can fake time.

## Trusted DJs

- The owner trusts people from the listener list ("Trust as DJ", shown only for signed-in listeners) or by typing an email in settings.
- The owner's device stores the trusted list locally (`localStorage` on web, `UserDefaults` on Mac) and sends it with `live:start`. No server persistence.
- A trusted person in the channel sees "Take the decks" at any time. Taking over needs no confirmation; the previous DJ gets a notice ("Anna took the decks").
- The owner can take the decks back at any time with the same action.

## Slack

- `live:start` posts "<ownerName> went live: *<roomName>*" with a **Listen** button (`https://vibez.bike-shed.io/c/<id>` and `vibez://channel/<id>`). The existing 10-minute per-person dedupe stays.
- `/vibez` without arguments lists live channels with Listen buttons.
- `/vibez play` and `/vibez queue` reply that they are on hold and link issue #8. `playFromSlack` and `queueFromSlack` are removed.

## Web Client

Plain JavaScript in `public/`, no framework.

- Two views: **Directory** (`/`) and **Channel** (`/c/<id>`), switched with the history API. The server serves `index.html` for `/c/*`.
- Directory: grid of cards (artwork, owner avatar, owner name, room name, active DJ if different, "DJ away" badge, listener count). Empty state: "Nobody's live — go live?".
- Channel view: today's player UI scoped to the channel, "← Channels" link, listener list with "Trust as DJ" for the owner, "Take the decks" for trusted users.
- Header: "Sign in with Google" or avatar with Go live / DJ name / Trusted DJs / Sign out.
- Go live form: DJ name and room name, prefilled from local storage.
- Opening `/c/<id>` for a channel that has ended shows the directory with "That channel ended".
- Switching channels stops the current stream and syncs to the new channel's position using the existing sync code.

## Mac App

The popover becomes the whole app.

- Screens inside the popover (`NavigationStack`):
  - **Channels**: live list + "Go live" row. Start screen when not in a channel.
  - **Now Playing**: channel pill at the top (tap → Channels), player, vibez slider, queue, listeners. DJ controls when you are the active DJ; "Take the decks" when trusted.
  - **Go Live**: DJ name, room name.
  - **Settings**: Google sign-in, DJ name, trusted DJs, AirPlay output, quit.
- Audio keeps playing when the popover is closed; the player lives in `VibezAppModel`.
- Menu bar icon shows a live dot while you are the active DJ.
- `vibez://channel/<id>` opens the popover in that channel.
- While Google sign-in runs, the popover behavior switches from `.transient` to `.applicationDefined` so the sign-in sheet doesn't close it.
- Deleted: `MainWindowView.swift`, `HideOnCloseWindowDelegate.swift`, `WindowAccessor.swift`, the Dock/menu-bar visibility settings in `AppVisibilitySettings.swift`, and the separate setup window. `Info.plist` gets `LSUIElement = true` (no Dock icon). Quit stays in the right-click menu and in Settings.

## Edge Cases

- Server restart: all channels disappear; clients reconnect to the lobby.
- Owner goes live from a second device: joins the same channel; `live:end` from either device ends it.
- Banned user: takes effect on their next connection; admins can `admin:end` their channel right away.
- Track ends with an empty queue: channel stays live, the 10-minute idle clock runs.
- Untrusted user sends `dj:take`: error "Not trusted in this channel".

## Rollout

Ships after part 1, as its own push to `main`. The Mac release goes out in the same push. Old Mac apps are rejected with the update message (protocol check above).

## Testing

`bun test`:

- Lifecycle: start, join, leave, end; broadcasts reach only channel members; `channels` reaches everyone.
- Permissions: anonymous `live:start` rejected; `dj:*` from a non-active-DJ rejected; `dj:take` by untrusted rejected, by trusted accepted; `admin:end` by non-admin rejected; untrust of active DJ returns decks to the owner.
- End rules with a fake clock: 2-minute DJ-gone end, fallback to owner, 10-minute idle end.
- Existing queue and playlist tests ported to run inside a channel.

Manual on Mac: browse, join, switch, go live, trust someone, take the decks from a second account, close the popover while music keeps playing, open a `vibez://channel/<id>` link.

## Out of Scope

Server-side persistence (rooms, trusted lists, profiles), private channels, search, chat, Slack play/queue (issue #8), mobile apps, Spotify.
