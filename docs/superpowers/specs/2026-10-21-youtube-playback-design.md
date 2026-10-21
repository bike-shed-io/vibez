# YouTube Playback Design

## Goal

Play YouTube links in a room the same way SoundCloud and Suno links play today: the server syncs metadata only (what plays, position, play/pause), and every listener plays the video through YouTube's official embedded player. Vibez never touches the audio.

Single videos only. Playlist links are out of scope (expanding one needs a YouTube Data API key). A video link that carries `&list=` plays that one video.

## Why the official player

YouTube offers no audio file. Extracting one (yt-dlp style) breaks YouTube's terms and the resulting URLs are bound to the requesting IP, so they would not play on listeners' devices anyway. The IFrame Player API is allowed and gives `playVideo`, `pauseVideo`, `seekTo`, `getCurrentTime` and state events, which is all the sync needs. It must stay visible (≥ 200×200), so the Mac app shows it in a floating overlay window.

## Server

- `src/youtube.ts`: `isYouTubeUrl`, `youtubeVideoId(url)` for `youtube.com/watch?v=`, `youtu.be/`, `music.youtube.com/watch?v=`, `/shorts/`, `/embed/`, `/live/`. Title and thumbnail come from `https://www.youtube.com/oembed?url=…&format=json` (no API key). oEmbed 404 → "Video not found"; 401/403 → "This video can't be played outside YouTube" (embedding disabled). Other failures → "Couldn't load this YouTube video".
- `src/sources.ts`: third branch. `resolveStreamUrl` returns `null` for YouTube; there is no stream.
- Channel state and the `track` message gain `videoId: string | null`. The server derives it from the track URL when the track starts, so `TrackRef` and queue items are unchanged. A queue can mix SoundCloud, Suno and YouTube.
- `playbackSnapshot` includes `videoId`. Rooms restored from `.cache/rooms.json` written before this change get `videoId: null`.
- `stream:refresh` stays audio-only; a YouTube track answers with "No stream to refresh".
- `PROTOCOL_VERSION` 2 → 3. Old Mac apps get the existing "Update Vibez: brew upgrade --cask vibez" error.

Clients decide: `videoId` set → YouTube player; otherwise `streamUrl` → `<audio>` / AVPlayer.

## Web (`public/`)

- `youtube.js`: loads the IFrame API once; `createYouTubePlayer(el, {onState, onEnded, onError})` returns `{load(id, positionMs, playing), play(), pause(), seek(sec), currentTime(), duration()}`. Also exports `roomPosition(position, timestamp)` and `needsSnap(currentSec, roomSec)` (threshold 2 s).
- `radio.js`: `showTrack`, `playAt`, `pauseAt`, `seek`, the seek bar, the heartbeat and `ended` route to `audio` or the YouTube player based on `videoId`. No wider restructuring.
- While a YouTube track plays, the player replaces the artwork in the now-playing card (16:9, min 356×200). AirPlay button hidden for YouTube tracks.
- Autoplay blocked → existing `pendingPlay` prompt.
- On every resume from buffering/ad (`PLAYING` state), compare the player time with the room position; snap when off by more than 2 s. No continuous drift correction otherwise (matches the audio path).
- `ENDED` → DJ's client sends `track:ended`. Embed errors 101/150 → listeners see "Can't play this video here"; the DJ's client sends `track:ended` so the room advances.
- `yt-player.html`: full-window page around `youtube.js` for the Mac overlay. Exposes `window.vibez = {load(videoId, positionMs, timestamp, playing), play(positionMs, timestamp), pause(positionMs), seek(positionMs, timestamp)}` and reports through `webkit.messageHandlers.vibez.postMessage`: `{type:"ready"}`, `{type:"state", state}`, `{type:"time", positionMs, durationMs}` about once a second, `{type:"ended"}`, `{type:"error", code}`.

## Mac (`macos/VibezMac`)

- `VideoOverlay.swift`: floating `NSPanel` (above all apps, all Spaces, non-activating), resizable at 16:9, min 356×200, default 356×200 top-right, position remembered. Hosts a `WKWebView` loading `<serverURL>/yt-player.html` with `mediaTypesRequiringUserActionForPlayback = []`.
- `VibezAppModel`: on `track` with `videoId`, stop AVPlayer and show the overlay; otherwise close the overlay and use AVPlayer as today. `play`/`pause`/`seek` go to whichever player is active. The DJ heartbeat uses the page's last reported time for YouTube tracks.
- Closing the overlay stops local playback only. The status-bar menu then offers "Show video", which reopens at the room position. The overlay closes on track end and on leaving the room.
- DJ with the overlay closed: a timer sends `track:ended` when the room position reaches the last reported duration, so the room does not stall.
- AirPlay picker affects AVPlayer only; YouTube follows system output.

## Tests

- `src/youtube.test.ts`: URL parsing, oEmbed success / 404 / 401 with stubbed fetch.
- `src/sources.test.ts`: routing, `resolveStreamUrl` → `null`.
- `src/ws.test.ts`: `track` carries `videoId`; protocol 2 `hello` is rejected; restored room without `videoId` loads as `null`.
- Mac: manual check in a dev build (back up the installed app's defaults/token first).

## Rollout

One PR; server and Mac ship together because of the protocol bump. Pushing main deploys the server and releases the Mac app. Live rooms survive the deploy as today.

## Left out

YouTube playlists; continuous drift correction; SoundCloud on its official widget (next spec); a Chrome extension client (would reuse the `track` message and `youtube.js`).
