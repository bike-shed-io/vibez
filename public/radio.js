(() => {
  // --- State ---
  let ws = null;
  let roles = { isOwner: false, isTrusted: false, isActiveDj: false, trustedEmails: [] };
  let currentChannel = null;      // ChannelInfo or null
  let directoryEntries = [];
  let isAdmin = false;
  let pendingChannelId = channelIdFromPath();
  let protocolRejected = false;
  let currentTrackUrl = null;
  let refreshPosition = 0;
  let isSeeking = false;
  let currentListenerNames = [];
  let vibezLevel = 0;
  let vibezRange = 0.2;
  let queueItems = [];
  let currentUser = null;
  let errorToastTimer = null;
  let noticeTimer = null;

  function channelIdFromPath() {
    const match = location.pathname.match(/^\/c\/([\w-]+)/);
    return match ? match[1] : null;
  }

  function roomLabel(info) {
    return info.roomName || `${info.ownerName}'s vibes`;
  }

  function loadTrusted() {
    try { return JSON.parse(localStorage.getItem("vibez:trusted") || "[]"); } catch { return []; }
  }

  // --- DOM ---
  const $ = (id) => document.getElementById(id);
  const joinScreen = $("joinScreen");
  const radioScreen = $("radioScreen");
  const directoryScreen = $("directoryScreen");
  const goLiveOpenBtn = $("goLiveOpenBtn");
  const goLiveSignInHint = $("goLiveSignInHint");
  const goLiveForm = $("goLiveForm");
  const djNameInput = $("djNameInput");
  const roomNameInput = $("roomNameInput");
  const goLiveCancelBtn = $("goLiveCancelBtn");
  const directoryEmpty = $("directoryEmpty");
  const channelGrid = $("channelGrid");
  const channelTitle = $("channelTitle");
  const channelDj = $("channelDj");
  const takeDecksBtn = $("takeDecksBtn");
  const renameBtn = $("renameBtn");
  const endLiveBtn = $("endLiveBtn");
  const channelNotice = $("channelNotice");
  const backToChannels = $("backToChannels");
  const trustPanel = $("trustPanel");
  const trustList = $("trustList");
  const trustForm = $("trustForm");
  const trustEmailInput = $("trustEmailInput");
  const nameInput = $("nameInput");
  const joinBtn = $("joinBtn");
  const statusDot = $("statusDot");
  const statusText = $("statusText");
  const trackInfo = $("trackInfo");
  const noTrack = $("noTrack");
  const trackTitle = $("trackTitle");
  const trackArtwork = $("trackArtwork");
  const djName = $("djName");
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
  const airplayBtn = $("airplayBtn");
  const queueCount = $("queueCount");
  const queueList = $("queueList");
  const queueEmpty = $("queueEmpty");
  const queueUrlInput = $("queueUrlInput");
  const queueAddBtn = $("queueAddBtn");
  const queueDjControls = $("queueDjControls");
  const skipBtn = $("skipBtn");
  const shuffleBtn = $("shuffleBtn");
  const clearQueueBtn = $("clearQueueBtn");
  const signInLink = $("signInLink");
  const userChip = $("userChip");
  const userAvatar = $("userAvatar");
  const userName = $("userName");
  const signOutBtn = $("signOutBtn");
  const authError = $("authError");
  const errorToast = $("errorToast");

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
      ws.send(JSON.stringify({ type: "hello", protocol: 2, name }));
    });

    ws.addEventListener("close", () => {
      statusDot.classList.remove("connected");
      statusText.textContent = "Disconnected — reconnecting...";
      if (!protocolRejected) setTimeout(() => connect(name), 2000);
    });

    ws.addEventListener("message", (evt) => {
      const msg = JSON.parse(evt.data);
      handleMessage(msg);
    });
  }

  // --- Message handling ---
  function handleMessage(msg) {
    switch (msg.type) {
      case "welcome":
        isAdmin = msg.isAdmin;
        if (pendingChannelId) {
          ws.send(JSON.stringify({ type: "channel:join", channelId: pendingChannelId }));
          pendingChannelId = null;
        } else if (currentChannel) {
          ws.send(JSON.stringify({ type: "channel:join", channelId: currentChannel.id })); // rejoin after reconnect
        } else {
          showDirectory();
        }
        break;

      case "channels":
        directoryEntries = msg.channels;
        renderDirectory();
        break;

      case "channel:state":
        applyChannel(msg.channel, msg.roles);
        updateListeners(msg.listeners, msg.listeners.length);
        if (msg.trackUrl && msg.streamUrl) {
          showTrack(msg.trackUrl, msg.trackTitle, msg.trackArtwork, msg.streamUrl);
          if (msg.isPlaying) playAt(msg.position, msg.positionTimestamp);
        } else {
          clearPlayer();
        }
        setVibezLevelFromRoom(msg.vibezBoost);
        renderQueue(msg.queue);
        showChannel();
        break;

      case "channel:update":
        applyChannel(msg.channel, msg.roles);
        if (msg.notice) showNotice(msg.notice);
        break;

      case "channel:ended":
        currentChannel = null;
        roles = { isOwner: false, isTrusted: false, isActiveDj: false, trustedEmails: [] };
        stopHeartbeat();
        clearPlayer();
        showDirectory(msg.reason === "ended" ? "The DJ ended the channel." : "That channel ended.");
        break;

      case "track":
        if (!msg.url && !msg.streamUrl) {
          clearPlayer();
        } else {
          showTrack(msg.url, msg.title, msg.artwork, msg.streamUrl);
        }
        break;

      case "queue":
        renderQueue(msg.items || []);
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

      case "listeners":
        updateListeners(msg.names, msg.count);
        renderTrustPanel(msg.people);
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
        if (msg.code === "protocol") {
          protocolRejected = true;
          showError("This page is out of date — reloading…");
          setTimeout(() => location.reload(), 1500);
          break;
        }
        if (msg.code === "channel-not-found") {
          showDirectory("That channel ended.");
          break;
        }
        showError(msg.message);
        break;
    }
  }

  // --- Player ---
  function clearPlayer() {
    trackInfo.classList.add("hidden");
    noTrack.classList.remove("hidden");
    noTrack.textContent = "No track playing — queue is empty";
    currentTrackUrl = null;
    audio.pause();
    audio.removeAttribute("src");
  }

  // --- Channel / directory views ---
  function applyChannel(info, nextRoles) {
    const wasDj = roles.isActiveDj;
    currentChannel = info;
    roles = nextRoles;
    if (roles.isOwner) localStorage.setItem("vibez:trusted", JSON.stringify(roles.trustedEmails));
    channelTitle.textContent = roomLabel(info);
    channelDj.textContent = info.djAway ? `🎧 ${info.activeDjName} (away)` : `🎧 ${info.activeDjName}`;
    updateDj(info.activeDjName);
    djControls.classList.toggle("hidden", !roles.isActiveDj);
    queueDjControls.classList.toggle("hidden", !roles.isActiveDj);
    takeDecksBtn.classList.toggle("hidden", roles.isActiveDj || !(roles.isTrusted || roles.isOwner));
    renameBtn.classList.toggle("hidden", !roles.isOwner);
    endLiveBtn.classList.toggle("hidden", !roles.isOwner);
    trustPanel.classList.toggle("hidden", !roles.isOwner);
    if (roles.isActiveDj && !wasDj) startHeartbeat();
    if (!roles.isActiveDj && wasDj) stopHeartbeat();
    renderQueue(queueItems);
  }

  function showDirectory(message) {
    radioScreen.classList.add("hidden");
    joinScreen.classList.add("hidden");
    directoryScreen.classList.remove("hidden");
    if (location.pathname !== "/") history.pushState(null, "", "/");
    if (message) showNotice(message);
    renderDirectory();
  }

  function showChannel() {
    directoryScreen.classList.add("hidden");
    joinScreen.classList.add("hidden");
    radioScreen.classList.remove("hidden");
    const path = `/c/${currentChannel.id}`;
    if (location.pathname !== path) history.pushState(null, "", path);
  }

  function renderDirectory() {
    channelGrid.replaceChildren(
      ...directoryEntries.map((entry) => {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "channel-card";
        const art = document.createElement("div");
        art.className = "channel-art";
        if (entry.trackArtwork) art.style.backgroundImage = `url("${entry.trackArtwork}")`;
        const title = document.createElement("strong");
        title.textContent = roomLabel(entry);
        const meta = document.createElement("span");
        meta.className = "hint";
        const dj = entry.activeDjName !== entry.ownerName ? ` · 🎧 ${entry.activeDjName}` : "";
        meta.textContent = `${entry.ownerName}${dj} · ${entry.listenerCount} listening${entry.djAway ? " · DJ away" : ""}`;
        const track = document.createElement("span");
        track.className = "channel-track";
        track.textContent = entry.trackTitle || "Nothing playing";
        card.append(art, title, track, meta);
        card.addEventListener("click", () => ws.send(JSON.stringify({ type: "channel:join", channelId: entry.id })));
        if (isAdmin) {
          const end = document.createElement("span");
          end.className = "admin-end";
          end.textContent = "End";
          end.addEventListener("click", (event) => {
            event.stopPropagation();
            ws.send(JSON.stringify({ type: "admin:end", channelId: entry.id }));
          });
          card.append(end);
        }
        return card;
      }),
    );
    directoryEmpty.classList.toggle("hidden", directoryEntries.length > 0);
  }

  function renderTrustPanel(people = []) {
    if (!roles.isOwner) return;
    const trusted = new Set(roles.trustedEmails);
    const rows = [...new Set([...roles.trustedEmails, ...people.map((p) => p.email)])].map((email) => {
      const person = people.find((p) => p.email === email);
      const li = document.createElement("li");
      li.textContent = person ? `${person.name} (${email})` : email;
      const button = document.createElement("button");
      button.className = "btn-small btn-secondary";
      button.textContent = trusted.has(email) ? "Remove" : "Trust as DJ";
      button.addEventListener("click", () =>
        ws.send(JSON.stringify({ type: trusted.has(email) ? "live:untrust" : "live:trust", email })),
      );
      li.append(" ", button);
      return li;
    });
    trustList.replaceChildren(...rows);
  }

  backToChannels.addEventListener("click", (event) => {
    event.preventDefault();
    ws.send(JSON.stringify({ type: "channel:leave" }));
    currentChannel = null;
    roles = { isOwner: false, isTrusted: false, isActiveDj: false, trustedEmails: [] };
    stopHeartbeat();
    clearPlayer();
    showDirectory();
  });

  goLiveOpenBtn.addEventListener("click", () => {
    if (!currentUser) return showError("Sign in to DJ");
    djNameInput.value = localStorage.getItem("vibez:name") || currentUser.givenName;
    roomNameInput.value = localStorage.getItem("vibez:room") || "";
    goLiveForm.classList.remove("hidden");
  });

  goLiveCancelBtn.addEventListener("click", () => goLiveForm.classList.add("hidden"));

  goLiveForm.addEventListener("submit", (event) => {
    event.preventDefault();
    localStorage.setItem("vibez:name", djNameInput.value.trim());
    localStorage.setItem("vibez:room", roomNameInput.value.trim());
    ws.send(JSON.stringify({
      type: "live:start",
      djName: djNameInput.value.trim(),
      roomName: roomNameInput.value.trim(),
      trustedEmails: loadTrusted(),
    }));
    goLiveForm.classList.add("hidden");
  });

  takeDecksBtn.addEventListener("click", () => ws.send(JSON.stringify({ type: "dj:take" })));
  endLiveBtn.addEventListener("click", () => ws.send(JSON.stringify({ type: "live:end" })));

  renameBtn.addEventListener("click", () => {
    const next = window.prompt("Room name", currentChannel?.roomName || "");
    if (next !== null) ws.send(JSON.stringify({ type: "live:rename", roomName: next }));
  });

  trustForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const email = trustEmailInput.value.trim();
    if (email) ws.send(JSON.stringify({ type: "live:trust", email }));
    trustEmailInput.value = "";
  });

  window.addEventListener("popstate", () => {
    const id = channelIdFromPath();
    if (id && id !== currentChannel?.id) ws.send(JSON.stringify({ type: "channel:join", channelId: id }));
    if (!id && currentChannel) backToChannels.click();
  });

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

  // --- AirPlay / Remote Playback ---
  function setupAirplay() {
    if (audio.remote) {
      audio.remote.watchAvailability((available) => {
        airplayBtn.classList.toggle("hidden", !available);
      }).catch(() => {});

      airplayBtn.addEventListener("click", () => {
        audio.remote.prompt().catch(() => {});
      });

      audio.remote.addEventListener("connecting", () => airplayBtn.classList.add("active"));
      audio.remote.addEventListener("connect", () => airplayBtn.classList.add("active"));
      audio.remote.addEventListener("disconnect", () => airplayBtn.classList.remove("active"));
      return;
    }

    if (typeof audio.webkitShowPlaybackTargetPicker === "function") {
      audio.addEventListener("webkitplaybacktargetavailabilitychanged", (e) => {
        airplayBtn.classList.toggle("hidden", e.availability !== "available");
      });
      airplayBtn.addEventListener("click", () => {
        audio.webkitShowPlaybackTargetPicker();
      });
      audio.addEventListener("webkitcurrentplaybacktargetiswirelesschanged", () => {
        airplayBtn.classList.toggle("active", audio.webkitCurrentPlaybackTargetIsWireless);
      });
    }
  }

  setupAirplay();

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
      if (!roles.isActiveDj || !ws) return;
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
    if (roles.isActiveDj && ws) {
      ws.send(JSON.stringify({ type: "dj:seek", position: pos * 1000 }));
    }
  });

  // --- DJ controls ---
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

  // --- Track ended → auto-advance queue ---
  audio.addEventListener("ended", () => {
    if (!ws || !currentTrackUrl || !roles.isActiveDj) return;
    ws.send(JSON.stringify({ type: "track:ended", trackUrl: currentTrackUrl }));
  });

  // --- Queue rendering ---
  function renderQueue(items) {
    queueItems = items || [];
    queueCount.textContent = queueItems.length;

    while (queueList.firstChild) {
      queueList.removeChild(queueList.firstChild);
    }

    if (queueItems.length === 0) {
      const empty = document.createElement("div");
      empty.className = "queue-empty";
      empty.textContent = "Queue is empty";
      queueList.appendChild(empty);
      return;
    }

    queueItems.forEach((item, idx) => {
      const el = document.createElement("div");
      el.className = "queue-item";

      const pos = document.createElement("span");
      pos.className = "queue-item-pos";
      pos.textContent = idx + 1;

      const info = document.createElement("div");
      info.className = "queue-item-info";

      const title = document.createElement("div");
      title.className = "queue-item-title";
      title.textContent = item.title || "Unknown Track";

      const added = document.createElement("div");
      added.className = "queue-item-added";
      added.textContent = "added by " + escapeHtml(item.addedBy);

      info.appendChild(title);
      info.appendChild(added);

      el.appendChild(pos);
      el.appendChild(info);

      if (roles.isActiveDj) {
        const actions = document.createElement("div");
        actions.className = "queue-item-actions";

        if (idx > 0) {
          const upBtn = document.createElement("button");
          upBtn.className = "queue-item-btn";
          upBtn.textContent = "\u25B2";
          upBtn.title = "Move up";
          upBtn.addEventListener("click", () => {
            ws.send(JSON.stringify({ type: "queue:reorder", itemId: item.id, toIndex: idx - 1 }));
          });
          actions.appendChild(upBtn);
        }

        if (idx < queueItems.length - 1) {
          const downBtn = document.createElement("button");
          downBtn.className = "queue-item-btn";
          downBtn.textContent = "\u25BC";
          downBtn.title = "Move down";
          downBtn.addEventListener("click", () => {
            ws.send(JSON.stringify({ type: "queue:reorder", itemId: item.id, toIndex: idx + 1 }));
          });
          actions.appendChild(downBtn);
        }

        const removeBtn = document.createElement("button");
        removeBtn.className = "queue-item-btn remove-btn";
        removeBtn.textContent = "\u2715";
        removeBtn.title = "Remove";
        removeBtn.addEventListener("click", () => {
          ws.send(JSON.stringify({ type: "queue:remove", itemId: item.id }));
        });
        actions.appendChild(removeBtn);

        el.appendChild(actions);
      }

      queueList.appendChild(el);
    });
  }

  // --- Queue controls ---
  queueAddBtn.addEventListener("click", () => {
    const url = queueUrlInput.value.trim();
    if (!url || !ws) return queueUrlInput.focus();
    ws.send(JSON.stringify({ type: "queue:add", url }));
    queueUrlInput.value = "";
  });

  queueUrlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") queueAddBtn.click();
  });

  skipBtn.addEventListener("click", () => {
    if (ws && roles.isActiveDj) ws.send(JSON.stringify({ type: "queue:skip" }));
  });

  shuffleBtn.addEventListener("click", () => {
    if (ws && roles.isActiveDj) ws.send(JSON.stringify({ type: "queue:shuffle" }));
  });

  clearQueueBtn.addEventListener("click", () => {
    if (ws && roles.isActiveDj && queueItems.length > 0) {
      ws.send(JSON.stringify({ type: "queue:clear" }));
    }
  });

  // --- Auth ---
  function showError(message) {
    errorToast.textContent = message;
    errorToast.classList.remove("hidden");
    clearTimeout(errorToastTimer);
    errorToastTimer = setTimeout(() => errorToast.classList.add("hidden"), 4000);
  }

  function showNotice(message) {
    channelNotice.textContent = message;
    channelNotice.classList.remove("hidden");
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => channelNotice.classList.add("hidden"), 4000);
  }

  function renderAuth() {
    signInLink.classList.toggle("hidden", !!currentUser);
    userChip.classList.toggle("hidden", !currentUser);
    goLiveOpenBtn.disabled = !currentUser;
    goLiveSignInHint.classList.toggle("hidden", !!currentUser);
    queueAddBtn.disabled = !currentUser;
    queueUrlInput.disabled = !currentUser;
    if (!currentUser) return;
    userName.textContent = localStorage.getItem("vibez:name") || currentUser.givenName;
    userAvatar.classList.toggle("hidden", !currentUser.picture);
    if (currentUser.picture) userAvatar.src = currentUser.picture;
    if (!nameInput.value) nameInput.value = currentUser.givenName;
  }

  async function loadUser() {
    try {
      const res = await fetch("/auth/me", { credentials: "same-origin" });
      currentUser = res.ok ? await res.json() : null;
    } catch {
      currentUser = null;
    }
    renderAuth();
  }

  signOutBtn.addEventListener("click", async () => {
    try {
      await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
    } catch {
      showError("Sign out failed, reloading anyway");
    } finally {
      location.reload();
    }
  });

  if (new URLSearchParams(location.search).has("auth_error")) {
    authError.classList.remove("hidden");
    history.replaceState(null, "", location.pathname);
  }

  // Auto-join if name already saved
  loadUser();
  if (savedName) {
    join();
  }
})();
