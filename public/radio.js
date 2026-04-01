(() => {
  // --- State ---
  let ws = null;
  let isDj = false;
  let currentTrackUrl = null;
  let refreshPosition = 0;
  let isSeeking = false;
  let currentListenerNames = [];

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
  const audio = $("audioPlayer");
  const volumeSlider = $("volumeSlider");
  const volumeIcon = $("volumeIcon");
  const autoplayPrompt = $("autoplayPrompt");
  const autoplayBtn = $("autoplayBtn");
  const seekBar = $("seekBar");
  const seekCurrent = $("seekCurrent");
  const seekDuration = $("seekDuration");

  // --- Restore name from localStorage ---
  const savedName = localStorage.getItem("vibez:name");
  if (savedName) nameInput.value = savedName;

  // --- Restore volume from localStorage ---
  const savedVolume = localStorage.getItem("vibez:volume");
  if (savedVolume !== null) {
    let vol = parseFloat(savedVolume);
    if (vol > 1) vol = vol / 100; // migrate old 0-100 values
    volumeSlider.value = vol;
    audio.volume = vol;
  } else {
    audio.volume = 0.8;
  }

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
          showTrack(msg.trackUrl, msg.trackTitle, msg.trackArtwork, msg.streamUrl);
          if (msg.isPlaying) {
            playAt(msg.position, msg.positionTimestamp);
          }
        }
        break;

      case "track":
        showTrack(msg.url, msg.title, msg.artwork, msg.streamUrl);
        break;

      case "play":
        playAt(msg.position, msg.timestamp);
        break;

      case "pause":
        pauseAt(msg.position);
        break;

      case "seek":
        audio.currentTime = Math.max(0, (msg.position + (Date.now() - msg.timestamp)) / 1000);
        break;

      case "dj:changed":
        updateDj(msg.djName);
        refreshListenerChips();
        break;

      case "listeners":
        updateListeners(msg.names, msg.count);
        break;

      case "stream:refreshed":
        if (msg.streamUrl) {
          audio.src = msg.streamUrl;
          audio.addEventListener("canplay", () => {
            audio.currentTime = refreshPosition;
            audio.play().catch(() => {});
          }, { once: true });
        }
        break;

      case "error":
        console.warn("[vibez]", msg.message);
        break;
    }
  }

  // --- Track display ---
  function showTrack(url, title, artwork, streamUrl) {
    trackInfo.classList.remove("hidden");
    noTrack.classList.add("hidden");
    trackTitle.textContent = title || "Unknown Track";
    if (artwork) {
      trackArtwork.src = artwork;
      trackArtwork.classList.remove("hidden");
    } else {
      trackArtwork.classList.add("hidden");
    }
    if (url !== currentTrackUrl && streamUrl) {
      currentTrackUrl = url;
      audio.src = streamUrl;
      audio.load();
    }
  }

  // --- Playback ---
  let pendingPlay = null;

  function playAt(position, timestamp) {
    const doPlay = () => {
      const pos = (position + (Date.now() - timestamp)) / 1000;
      audio.currentTime = Math.max(0, pos);
      audio.play().catch(() => {
        // Autoplay blocked — show prompt
        pendingPlay = { position, timestamp };
        autoplayPrompt.classList.remove("hidden");
      });
    };
    if (audio.readyState >= 2) {
      doPlay();
    } else {
      audio.addEventListener("canplay", doPlay, { once: true });
    }
  }

  autoplayBtn.addEventListener("click", () => {
    autoplayPrompt.classList.add("hidden");
    if (pendingPlay) {
      const pos = (pendingPlay.position + (Date.now() - pendingPlay.timestamp)) / 1000;
      audio.currentTime = Math.max(0, pos);
      pendingPlay = null;
    }
    audio.play().catch(() => {});
  });

  function pauseAt(positionMs) {
    audio.pause();
    audio.currentTime = Math.max(0, positionMs / 1000);
  }

  // --- Stream refresh on error ---
  audio.addEventListener("error", () => {
    if (!currentTrackUrl || !ws) return;
    refreshPosition = audio.currentTime;
    ws.send(JSON.stringify({ type: "stream:refresh" }));
  });

  // --- DJ position heartbeat ---
  let heartbeatInterval = null;

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatInterval = setInterval(() => {
      if (!isDj || !ws) return;
      ws.send(JSON.stringify({ type: "dj:position", position: audio.currentTime * 1000 }));
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
    currentListenerNames = names || [];
    listenerCount.textContent = count;
    refreshListenerChips();
  }

  function refreshListenerChips() {
    listenerList.innerHTML = "";
    const currentDj = djName.textContent;
    currentListenerNames.forEach((name) => {
      const chip = document.createElement("span");
      const isDjChip = name === currentDj;
      chip.className = isDjChip ? "listener-chip dj-chip" : "listener-chip";
      chip.innerHTML = isDjChip
        ? `<span class="dot dj"></span> ${escapeHtml(name)} <span class="dj-badge">DJ</span>`
        : `<span class="dot"></span> ${escapeHtml(name)}`;
      listenerList.appendChild(chip);
    });
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  // --- Seek bar ---
  function formatTime(seconds) {
    if (!isFinite(seconds)) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  audio.addEventListener("timeupdate", () => {
    if (isSeeking) return;
    seekCurrent.textContent = formatTime(audio.currentTime);
    if (audio.duration) {
      seekBar.value = audio.currentTime / audio.duration;
      seekDuration.textContent = formatTime(audio.duration);
    }
  });

  audio.addEventListener("loadedmetadata", () => {
    seekDuration.textContent = formatTime(audio.duration);
  });

  seekBar.addEventListener("input", () => {
    isSeeking = true;
    seekCurrent.textContent = formatTime(seekBar.value * audio.duration);
  });

  seekBar.addEventListener("change", () => {
    isSeeking = false;
    const pos = seekBar.value * audio.duration;
    audio.currentTime = pos;
    if (isDj && ws) {
      ws.send(JSON.stringify({ type: "dj:seek", position: pos * 1000 }));
    }
  });

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
    ws.send(JSON.stringify({ type: "dj:pause", position: audio.currentTime * 1000 }));
    audio.pause();
  });

  resumeBtn.addEventListener("click", () => {
    ws.send(JSON.stringify({ type: "dj:resume", position: audio.currentTime * 1000 }));
    audio.play();
  });

  // --- Volume control ---
  volumeSlider.addEventListener("input", () => {
    audio.volume = parseFloat(volumeSlider.value);
    localStorage.setItem("vibez:volume", volumeSlider.value);
  });

  // Auto-join if name already saved
  if (savedName) {
    join();
  }
})();
