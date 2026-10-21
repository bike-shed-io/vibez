// Shared wrapper around YouTube's IFrame Player API. Used by radio.js (web) and yt-player.html
// (the Mac overlay). Vibez syncs metadata only; the video itself plays from YouTube here.
(() => {
  const SNAP_SEC = 2; // a listener this far from the room position jumps to it (after ads, buffering)
  let apiPromise = null;

  function loadApi() {
    if (apiPromise) return apiPromise;
    apiPromise = new Promise((resolve) => {
      if (window.YT && window.YT.Player) return resolve(window.YT);
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (previous) previous();
        resolve(window.YT);
      };
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(script);
    });
    return apiPromise;
  }

  /** Where the room is now, in seconds, from a server `{position, timestamp}` (ms). */
  function roomPosition(positionMs, timestamp) {
    return Math.max(0, (positionMs + (Date.now() - timestamp)) / 1000);
  }

  function needsSnap(currentSec, roomSec) {
    return Math.abs(currentSec - roomSec) > SNAP_SEC;
  }

  const STATE_NAMES = { "-1": "unstarted", 0: "ended", 1: "playing", 2: "paused", 3: "buffering", 5: "cued" };

  /**
   * Builds a player inside `el`. handlers: onState(name), onEnded(), onError(code), onTime(sec, durationSec).
   * Positions are seconds. Resolves once the player is ready.
   */
  async function create(el, handlers = {}) {
    const YT = await loadApi();
    let player = null;
    let state = -1;
    let videoId = null;
    let startSec = 0;
    // `load` only remembers the video. Handing it to the player happens on the first play/pause:
    // cueVideoById followed by loadVideoById in the same tick leaves the player cued, not playing,
    // and `track` + `play` arrive back to back.
    let loaded = false;

    await new Promise((resolve) => {
      player = new YT.Player(el, {
        width: "100%",
        height: "100%",
        playerVars: { playsinline: 1, rel: 0, origin: location.origin },
        events: {
          onReady: () => resolve(),
          onStateChange: (e) => {
            state = e.data;
            if (handlers.onState) handlers.onState(STATE_NAMES[String(state)] || "unstarted");
            if (state === YT.PlayerState.ENDED && handlers.onEnded) handlers.onEnded();
          },
          onError: (e) => {
            if (handlers.onError) handlers.onError(e.data);
          },
        },
      });
    });

    if (handlers.onTime) {
      setInterval(() => {
        if (state === 1) handlers.onTime(player.getCurrentTime() || 0, player.getDuration() || 0);
      }, 500);
    }

    return {
      /** Remembers the video; nothing shows until play or pause. */
      load(id, sec = 0) {
        videoId = id;
        startSec = sec;
        loaded = false;
      },
      play(sec) {
        if (sec != null) startSec = sec;
        if (!loaded) {
          loaded = true;
          return player.loadVideoById({ videoId, startSeconds: startSec });
        }
        if (sec != null) player.seekTo(sec, true);
        player.playVideo();
      },
      pause(sec) {
        if (sec != null) startSec = sec;
        if (!loaded) {
          loaded = true;
          return player.cueVideoById({ videoId, startSeconds: startSec });
        }
        player.pauseVideo();
        if (sec != null) player.seekTo(sec, true);
      },
      seek(sec) {
        startSec = sec;
        if (loaded) player.seekTo(sec, true);
      },
      stop() {
        videoId = null;
        loaded = false;
        player.stopVideo();
      },
      currentTime: () => player.getCurrentTime() || 0,
      duration: () => player.getDuration() || 0,
      isPlaying: () => state === 1 || state === 3,
      setVolume(level) {
        player.setVolume(Math.round(Math.max(0, Math.min(1, level)) * 100));
      },
    };
  }

  window.VibezYouTube = { create, roomPosition, needsSnap };
})();
