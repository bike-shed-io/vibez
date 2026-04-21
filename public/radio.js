(() => {
  // --- State ---
  let ws = null;
  let isDj = false;
  let currentTrackUrl = null;
  let refreshPosition = 0;
  let isSeeking = false;
  let currentListenerNames = [];
  let vibezLevel = 0;
  let vibezRange = 0.2;

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
  const volumeValue = $("volumeValue");
  const volumeSlider = $("volumeSlider");
  const volumeIcon = $("volumeIcon");
  const autoplayPrompt = $("autoplayPrompt");
  const autoplayBtn = $("autoplayBtn");
  const seekBar = $("seekBar");
  const seekCurrent = $("seekCurrent");
  const seekDuration = $("seekDuration");
  const vibezSlider = $("vibezSlider");
  const vibezValue = $("vibezValue");
  const vibezRangeSlider = $("vibezRangeSlider");
  const vibezRangeValue = $("vibezRangeValue");
  const vibezWindowBand = $("vibezWindowBand");
  const vibezWindowBase = $("vibezWindowBase");
  const vibezWindowLive = $("vibezWindowLive");
  const vibezFloor = $("vibezFloor");
  const vibezLive = $("vibezLive");
  const vibezCeiling = $("vibezCeiling");

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

  const savedVibezRange = localStorage.getItem("vibez:range");
  if (savedVibezRange !== null) {
    vibezRange = clampUnit(savedVibezRange);
  } else {
    const legacyMax = localStorage.getItem("vibez:max");
    if (legacyMax !== null) {
      vibezRange = Math.max(0, clampUnit(legacyMax) - clampUnit(volumeSlider.value));
      localStorage.setItem("vibez:range", String(vibezRange));
      localStorage.removeItem("vibez:max");
    }
  }
  vibezRangeSlider.value = String(vibezRange);

  updateVibezSliderVisual();
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
        setVibezLevelFromRoom(msg.vibezBoost ?? 0);
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

      case "vibez":
        setVibezLevelFromRoom(msg.boost ?? 0);
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
  function clampUnit(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(1, number));
  }

  function clampSigned(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(-1, Math.min(1, number));
  }

  function percentText(value) {
    return `${Math.round(clampUnit(value) * 100)}%`;
  }

  function formatVibezLevel(value) {
    const level = clampSigned(value);
    const pct = Math.round(Math.abs(level) * 100);
    if (pct === 0) return "Neutral";
    return level < 0 ? `Lower ${pct}%` : `Lift +${pct}%`;
  }

  function vibezTone(value) {
    if (value < -0.001) return "lower";
    if (value > 0.001) return "lift";
    return "neutral";
  }

  function rangeBounds(base) {
    if (base === 0) {
      return { floor: 0, ceiling: 0 };
    }
    return {
      floor: clampUnit(base - vibezRange),
      ceiling: clampUnit(base + vibezRange),
    };
  }

  function effectiveVolume(base) {
    if (base === 0) return 0;
    return clampUnit(base + vibezLevel * vibezRange);
  }

  function setMarkerPosition(el, value) {
    el.style.left = `${clampUnit(value) * 100}%`;
  }

  function applyVolume() {
    const base = clampUnit(volumeSlider.value);
    const live = effectiveVolume(base);
    audio.volume = live;
    updateVolumeTrackVisual(base);
    updateRangeTrackVisual();
    updateVibezTone();
    updateRangeWindow(base, live);
  }

  function setVibezLevelFromRoom(value) {
    vibezLevel = clampSigned(value);
    vibezSlider.value = String(vibezLevel);
    updateVibezSliderVisual();
    applyVolume();
  }

  function updateVolumeTrackVisual(base) {
    const basePct = (base * 100).toFixed(1);
    volumeSlider.style.background =
      `linear-gradient(to right, var(--accent) 0%, var(--accent) ${basePct}%, var(--border) ${basePct}%, var(--border) 100%)`;
  }

  function updateRangeTrackVisual() {
    const rangePct = (vibezRange * 100).toFixed(1);
    vibezRangeSlider.style.background =
      `linear-gradient(to right, var(--text) 0%, var(--text) ${rangePct}%, var(--border) ${rangePct}%, var(--border) 100%)`;
  }

  function updateRangeWindow(base, live) {
    const { floor, ceiling } = rangeBounds(base);
    const bandLeft = floor * 100;
    const bandWidth = Math.max((ceiling - floor) * 100, 0);

    volumeValue.textContent = percentText(base);
    vibezRangeValue.textContent = `+/- ${Math.round(vibezRange * 100)}%`;
    vibezFloor.textContent = percentText(floor);
    vibezLive.textContent = `Live ${percentText(live)}`;
    vibezCeiling.textContent = percentText(ceiling);

    vibezWindowBand.style.left = `${bandLeft}%`;
    vibezWindowBand.style.width = `${bandWidth}%`;
    setMarkerPosition(vibezWindowBase, base);
    setMarkerPosition(vibezWindowLive, live);
  }

  function updateVibezTone() {
    const tone = vibezTone(vibezLevel);
    vibezValue.textContent = formatVibezLevel(vibezLevel);
    vibezValue.dataset.tone = tone;
    vibezWindowLive.dataset.tone = tone;
    vibezLive.dataset.tone = tone;
  }

  volumeSlider.addEventListener("input", () => {
    localStorage.setItem("vibez:volume", volumeSlider.value);
    applyVolume();
  });

  vibezRangeSlider.addEventListener("input", () => {
    vibezRange = clampUnit(vibezRangeSlider.value);
    localStorage.setItem("vibez:range", String(vibezRange));
    applyVolume();
  });

  let lastVibezSent = 0;
  function updateVibezSliderVisual() {
    const level = clampSigned(vibezSlider.value);
    const pct = (((level + 1) / 2) * 100).toFixed(1);
    const center = "50%";

    if (Math.abs(level) < 0.001) {
      vibezSlider.style.background =
        "linear-gradient(to right, var(--cool-soft) 0%, var(--cool-soft) 50%, var(--warm-soft) 50%, var(--warm-soft) 100%)";
      return;
    }

    if (level < 0) {
      vibezSlider.style.background =
        `linear-gradient(to right, var(--cool-soft) 0%, var(--cool-soft) ${pct}%, var(--cool) ${pct}%, var(--cool) ${center}, var(--warm-soft) ${center}, var(--warm-soft) 100%)`;
      return;
    }

    vibezSlider.style.background =
      `linear-gradient(to right, var(--cool-soft) 0%, var(--cool-soft) ${center}, var(--accent) ${center}, var(--accent) ${pct}%, var(--warm-soft) ${pct}%, var(--warm-soft) 100%)`;
  }
  vibezSlider.addEventListener("input", () => {
    const boost = clampSigned(vibezSlider.value);
    vibezLevel = boost;
    updateVibezSliderVisual();
    applyVolume();
    const now = Date.now();
    if (now - lastVibezSent > 50) {
      lastVibezSent = now;
      if (ws) ws.send(JSON.stringify({ type: "vibez:boost", boost }));
    }
  });
  vibezSlider.addEventListener("change", () => {
    const boost = clampSigned(vibezSlider.value);
    if (ws) ws.send(JSON.stringify({ type: "vibez:boost", boost }));
  });

  // Auto-join if name already saved
  if (savedName) {
    join();
  }
})();
