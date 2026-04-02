(() => {
  // --- State ---
  let ws = null;
  let isDj = false;
  let currentTrackUrl = null;
  let refreshPosition = 0;
  let isSeeking = false;
  let currentListenerNames = [];
  let vibezBoost = 0;
  let vibezMax = 1.0;

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
  const vibezSlider = $("vibezSlider");
  const vibezValue = $("vibezValue");
  const vibezMaxControl = $("vibezMaxControl");
  const vibezMaxSlider = $("vibezMaxSlider");

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

  const savedVibezMax = localStorage.getItem("vibez:max");
  if (savedVibezMax !== null) {
    vibezMax = parseFloat(savedVibezMax);
    vibezMaxSlider.value = vibezMax;
  }

  applyVolume();

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
        if (msg.vibezBoost > 0) {
          vibezBoost = msg.vibezBoost;
          if (!isDj) vibezMaxControl.classList.remove("hidden");
        }
        applyVolume();
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
        if (!msg.djName) {
          vibezBoost = 0;
          vibezMaxControl.classList.add("hidden");
          applyVolume();
        }
        break;

      case "listeners":
        updateListeners(msg.names, msg.count);
        break;

      case "vibez":
        vibezBoost = msg.boost;
        if (!isDj) {
          if (vibezBoost > 0) {
            vibezMaxControl.classList.remove("hidden");
          } else {
            vibezMaxControl.classList.add("hidden");
          }
        }
        applyVolume();
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
      vibezMaxControl.classList.add("hidden");
      startHeartbeat();
    } else {
      ws.send(JSON.stringify({ type: "dj:release" }));
      isDj = false;
      djToggle.textContent = "Become DJ";
      djToggle.className = "btn-secondary";
      djControls.classList.add("hidden");
      vibezSlider.value = 0;
      vibezValue.textContent = "0%";
      // Now a listener again — show range if vibez still active
      if (vibezBoost > 0) vibezMaxControl.classList.remove("hidden");
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
  function applyVolume() {
    const base = parseFloat(volumeSlider.value);
    const effective = base === 0 ? 0 : Math.min(base + vibezBoost, vibezMax, 1.0);
    audio.volume = Math.max(0, Math.min(1, effective));
    updateVolumeTrackVisual(base);
  }

  function updateVolumeTrackVisual(base) {
    const basePct = (base * 100).toFixed(1);

    if (vibezBoost === 0) {
      volumeSlider.style.background =
        `linear-gradient(to right, var(--accent) 0%, var(--accent) ${basePct}%, var(--border) ${basePct}%, var(--border) 100%)`;
      return;
    }

    const uncapped = base + vibezBoost;
    const effective = Math.min(uncapped, vibezMax, 1.0);
    const effectivePct = (effective * 100).toFixed(1);
    const isCapped = uncapped > vibezMax;

    if (isCapped) {
      // Boost hits the ceiling — green up to max, red beyond
      const maxPct = (Math.min(vibezMax, 1.0) * 100).toFixed(1);
      const uncappedPct = (Math.min(uncapped, 1.0) * 100).toFixed(1);
      volumeSlider.style.background =
        `linear-gradient(to right, var(--accent) 0%, var(--accent) ${basePct}%, var(--success) ${basePct}%, var(--success) ${maxPct}%, var(--danger) ${maxPct}%, var(--danger) ${uncappedPct}%, var(--border) ${uncappedPct}%, var(--border) 100%)`;
    } else {
      // Boost within ceiling — green for boost, dim hint showing headroom to max
      const maxPct = (Math.min(vibezMax, 1.0) * 100).toFixed(1);
      volumeSlider.style.background =
        `linear-gradient(to right, var(--accent) 0%, var(--accent) ${basePct}%, var(--success) ${basePct}%, var(--success) ${effectivePct}%, rgba(0,200,83,0.15) ${effectivePct}%, rgba(0,200,83,0.15) ${maxPct}%, var(--border) ${maxPct}%, var(--border) 100%)`;
    }
  }

  volumeSlider.addEventListener("input", () => {
    localStorage.setItem("vibez:volume", volumeSlider.value);
    applyVolume();
  });

  vibezMaxSlider.addEventListener("input", () => {
    vibezMax = parseFloat(vibezMaxSlider.value);
    localStorage.setItem("vibez:max", String(vibezMax));
    applyVolume();
  });

  let lastVibezSent = 0;
  function updateVibezSliderVisual() {
    const boost = parseFloat(vibezSlider.value);
    const pct = (boost * 100).toFixed(1);
    vibezSlider.style.background =
      `linear-gradient(to right, var(--accent) 0%, var(--accent) ${pct}%, var(--border) ${pct}%, var(--border) 100%)`;
  }
  vibezSlider.addEventListener("input", () => {
    const boost = parseFloat(vibezSlider.value);
    vibezBoost = boost;
    vibezValue.textContent = Math.round(boost * 100) + "%";
    updateVibezSliderVisual();
    applyVolume();
    const now = Date.now();
    if (now - lastVibezSent > 50) {
      lastVibezSent = now;
      if (ws) ws.send(JSON.stringify({ type: "vibez:boost", boost }));
    }
  });
  vibezSlider.addEventListener("change", () => {
    const boost = parseFloat(vibezSlider.value);
    if (ws) ws.send(JSON.stringify({ type: "vibez:boost", boost }));
  });

  // Auto-join if name already saved
  if (savedName) {
    join();
  }
})();
