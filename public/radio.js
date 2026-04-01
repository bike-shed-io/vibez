(() => {
  // --- State ---
  let ws = null;
  let isDj = false;
  let widget = null;
  let widgetReady = false;
  let currentTrackUrl = null;
  let suppressWidgetEvents = false;

  // --- DOM ---
  const $ = (id) => document.getElementById(id);
  const joinScreen = $("joinScreen");
  const radioScreen = $("radioScreen");
  const nameInput = $("nameInput");
  const joinBtn = $("joinBtn");
  const statusDot = $("statusDot");
  const statusText = $("statusText");
  const trackInfo = $("trackInfo");
  const noTrack = $("noTrack");
  const trackTitle = $("trackTitle");
  const trackArtwork = $("trackArtwork");
  const djName = $("djName");
  const djToggle = $("djToggle");
  const djControls = $("djControls");
  const trackUrlInput = $("trackUrlInput");
  const playBtn = $("playBtn");
  const pauseBtn = $("pauseBtn");
  const resumeBtn = $("resumeBtn");
  const listenerCount = $("listenerCount");
  const listenerList = $("listenerList");
  const scWidgetIframe = $("scWidget");

  // --- Restore name from localStorage ---
  const savedName = localStorage.getItem("vibez:name");
  if (savedName) nameInput.value = savedName;

  // --- Join ---
  function join() {
    const name = nameInput.value.trim();
    if (!name) return nameInput.focus();
    localStorage.setItem("vibez:name", name);
    joinScreen.classList.add("hidden");
    radioScreen.classList.remove("hidden");
    connect(name);
  }

  joinBtn.addEventListener("click", join);
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") join();
  });

  // --- WebSocket ---
  function connect(name) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.addEventListener("open", () => {
      statusDot.classList.add("connected");
      statusText.textContent = "Connected";
      ws.send(JSON.stringify({ type: "join", name }));
    });

    ws.addEventListener("close", () => {
      statusDot.classList.remove("connected");
      statusText.textContent = "Disconnected — reconnecting...";
      setTimeout(() => connect(name), 2000);
    });

    ws.addEventListener("message", (evt) => {
      const msg = JSON.parse(evt.data);
      handleMessage(msg);
    });
  }

  // --- Message handling ---
  function handleMessage(msg) {
    switch (msg.type) {
      case "sync":
        updateDj(msg.djName);
        updateListeners(msg.listeners, msg.listeners?.length || 0);
        if (msg.trackUrl) {
          showTrack(msg.trackUrl, msg.trackTitle, msg.trackArtwork);
          if (msg.isPlaying) {
            const elapsed = Date.now() - msg.positionTimestamp;
            const pos = msg.position + elapsed;
            playAt(pos);
          }
        }
        break;

      case "track":
        showTrack(msg.url, msg.title, msg.artwork);
        break;

      case "play": {
        const elapsed = Date.now() - msg.timestamp;
        const pos = msg.position + elapsed;
        playAt(pos);
        break;
      }

      case "pause":
        pauseAt(msg.position);
        break;

      case "seek": {
        const elapsed = Date.now() - msg.timestamp;
        const pos = msg.position + elapsed;
        seekTo(pos);
        break;
      }

      case "dj:changed":
        updateDj(msg.djName);
        break;

      case "listeners":
        updateListeners(msg.names, msg.count);
        break;

      case "error":
        console.warn("[vibez]", msg.message);
        break;
    }
  }

  // --- SC Widget ---
  function initWidget() {
    widget = SC.Widget(scWidgetIframe);
    widget.bind(SC.Widget.Events.READY, () => {
      widgetReady = true;
    });
  }

  function loadTrack(url, callback) {
    if (!widget) initWidget();
    widgetReady = false;
    const embedUrl = `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}&auto_play=false&show_artwork=true&visual=false`;
    scWidgetIframe.src = embedUrl;

    // Re-bind after src change
    widget = SC.Widget(scWidgetIframe);
    widget.bind(SC.Widget.Events.READY, () => {
      widgetReady = true;
      if (callback) callback();
    });
  }

  function showTrack(url, title, artwork) {
    trackInfo.classList.remove("hidden");
    noTrack.classList.add("hidden");
    trackTitle.textContent = title || "Unknown Track";
    if (artwork) {
      trackArtwork.src = artwork;
      trackArtwork.classList.remove("hidden");
    } else {
      trackArtwork.classList.add("hidden");
    }

    if (url !== currentTrackUrl) {
      currentTrackUrl = url;
      loadTrack(url);
    }
  }

  function playAt(positionMs) {
    const doPlay = () => {
      suppressWidgetEvents = true;
      widget.seekTo(Math.max(0, positionMs));
      widget.play();
      setTimeout(() => { suppressWidgetEvents = false; }, 500);
    };

    if (widgetReady) {
      doPlay();
    } else if (widget) {
      widget.bind(SC.Widget.Events.READY, doPlay);
    }
  }

  function pauseAt(positionMs) {
    if (!widgetReady) return;
    suppressWidgetEvents = true;
    widget.pause();
    widget.seekTo(Math.max(0, positionMs));
    setTimeout(() => { suppressWidgetEvents = false; }, 500);
  }

  function seekTo(positionMs) {
    if (!widgetReady) return;
    suppressWidgetEvents = true;
    widget.seekTo(Math.max(0, positionMs));
    setTimeout(() => { suppressWidgetEvents = false; }, 500);
  }

  // --- DJ position heartbeat ---
  let heartbeatInterval = null;

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatInterval = setInterval(() => {
      if (!isDj || !widgetReady || !ws) return;
      widget.getPosition((pos) => {
        ws.send(JSON.stringify({ type: "dj:position", position: pos }));
      });
    }, 5000);
  }

  function stopHeartbeat() {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  }

  // --- UI updates ---
  function updateDj(name) {
    djName.textContent = name || "—";
    if (!name) {
      noTrack.textContent = "No track playing — waiting for a DJ";
    }
  }

  function updateListeners(names, count) {
    listenerCount.textContent = count;
    listenerList.innerHTML = "";
    if (names) {
      names.forEach((name) => {
        const chip = document.createElement("span");
        chip.className = "listener-chip";
        chip.innerHTML = `<span class="dot"></span> ${escapeHtml(name)}`;
        listenerList.appendChild(chip);
      });
    }
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  // --- DJ controls ---
  djToggle.addEventListener("click", () => {
    if (!isDj) {
      ws.send(JSON.stringify({ type: "dj:claim" }));
      isDj = true;
      djToggle.textContent = "Stop DJing";
      djToggle.className = "btn-danger";
      djControls.classList.remove("hidden");
      startHeartbeat();
    } else {
      ws.send(JSON.stringify({ type: "dj:release" }));
      isDj = false;
      djToggle.textContent = "Become DJ";
      djToggle.className = "btn-secondary";
      djControls.classList.add("hidden");
      stopHeartbeat();
    }
  });

  playBtn.addEventListener("click", () => {
    const url = trackUrlInput.value.trim();
    if (!url) return trackUrlInput.focus();
    ws.send(JSON.stringify({ type: "dj:play", url }));
    trackUrlInput.value = "";
  });

  pauseBtn.addEventListener("click", () => {
    if (!widgetReady) return;
    widget.getPosition((pos) => {
      ws.send(JSON.stringify({ type: "dj:pause", position: pos }));
      widget.pause();
    });
  });

  resumeBtn.addEventListener("click", () => {
    if (!widgetReady) return;
    widget.getPosition((pos) => {
      ws.send(JSON.stringify({ type: "dj:resume", position: pos }));
      widget.play();
    });
  });

  // Auto-join if name already saved
  if (savedName) {
    join();
  }
})();
