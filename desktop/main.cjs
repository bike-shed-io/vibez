const { app, BrowserWindow, Menu, Tray, ipcMain, session, shell, dialog, safeStorage } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { serverUrl, deepLink, sameOrigin, sanitizeStatus } = require('./shared/core.cjs');
const { createPlatform } = require('./platform/index.cjs');
const { createCredentialStore } = require('./credentials.cjs');
const { controlServer } = require('./ipc.cjs');

const platform = createPlatform({ app, safeStorage });
const locations = platform.locations;
const credentials = createCredentialStore(platform);
const origin = serverUrl(process.env.VIBEZ_SERVER_URL);
platform.prepareData();
app.setName('Vibez');
app.setPath('userData', locations.config);
platform.configure();
app.enableSandbox();

let window;
let tray;
let control;
let quitting = false;
let authDeadline = 0;
let loadingOffline = false;
let status = { running: true, ...sanitizeStatus() };
const offlinePage = pathToFileURL(path.join(__dirname, 'offline.html')).href;
let pendingLink = process.argv.map(deepLink).find(Boolean);
const background = process.argv.includes('--background');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else if (process.argv.includes('--quit') || process.argv.includes('--uninstall-integration')) {
  if (process.argv.includes('--uninstall-integration')) platform.removeIntegration?.();
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (argv.includes('--uninstall-integration')) { platform.removeIntegration?.(); return app.quit(); }
    if (argv.includes('--quit')) return app.quit();
    const link = argv.map(deepLink).find(Boolean);
    if (window) handleLink(link); else pendingLink = link || { type: 'open' };
  });
  app.on('open-url', (event, url) => {
    event.preventDefault();
    const link = deepLink(url);
    if (!link) return;
    if (window) handleLink(link); else pendingLink = link;
  });
  app.whenReady().then(start).catch((error) => {
    console.error('[vibez] Startup failed:', error.message);
    app.exit(1);
  });
}

function show() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function hide() {
  if (status.video) return { error: 'YouTube needs a visible player. Leave the channel or quit to close it.' };
  window.hide();
  return { ok: true };
}

function mute() {
  window.webContents.setAudioMuted(!window.webContents.isAudioMuted());
  status.muted = window.webContents.isAudioMuted();
  updateTray();
  return { ok: true };
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip(['Vibez', status.channel, status.title].filter(Boolean).join(' — ').slice(0, 200));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Vibez', click: show },
    { label: status.muted ? 'Unmute locally' : 'Mute locally', click: mute },
    { label: 'Hide window', enabled: !status.video, click: hide },
    ...(platform.startup?.available() ? [{
      label: 'Start Vibez at sign-in', type: 'checkbox', checked: platform.startup.enabled(),
      click: (item) => { platform.startup.set(item.checked); updateTray(); },
    }] : []),
    { type: 'separator' },
    { label: 'Quit Vibez', click: () => app.quit() },
  ]));
}

function trustedSender(event) {
  return window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame &&
    sameOrigin(event.senderFrame.url, origin);
}

async function signIn() {
  authDeadline = Date.now() + 10 * 60_000;
  // Reuse the existing native callback on both desktop platforms; no server deployment.
  await shell.openExternal(`${origin}/auth/google?client=mac`);
}

async function handleLink(link) {
  if (!link || link.type === 'open') return show();
  if (link.type === 'channel') {
    show();
    await window.loadURL(`${origin}${link.path}`).catch(loadFailed);
    return;
  }
  if (!authDeadline || Date.now() > authDeadline) return;
  authDeadline = 0;
  if (link.type === 'auth-error') {
    show();
    dialog.showErrorBox('Vibez sign-in', 'Google sign-in failed. Try again from Vibez.');
    return;
  }
  if (link.type !== 'auth') return;
  try {
    const response = await fetch(`${origin}/auth/me`, {
      headers: { Authorization: `Bearer ${link.token}` }, redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    if (!response.ok || !(await response.json()).email) throw new Error('Session was not accepted.');
    await credentials.save(origin, link.token);
    await installCookie(link.token);
    show();
    window.webContents.reload();
  } catch {
    show();
    dialog.showErrorBox('Vibez sign-in', 'Could not complete sign-in. Check your connection and try again.');
  }
}

async function installCookie(token) {
  await session.defaultSession.cookies.set({
    url: origin, name: 'vibez_session', value: token,
    httpOnly: true, secure: origin.startsWith('https:'), sameSite: 'lax', path: '/',
  });
}

function loadFailed(error) {
  if (!window || window.isDestroyed() || quitting || error.code === 'ERR_ABORTED' || error.code === -3) return;
  console.error('[vibez] Could not load server:', error.code || 'connection failed');
  status = { running: true, ...sanitizeStatus(), muted: window.webContents.isAudioMuted() };
  updateTray();
  if (loadingOffline) return;
  loadingOffline = true;
  window.loadFile(path.join(__dirname, 'offline.html')).catch(() => {}).finally(() => { loadingOffline = false; });
}

function external(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) shell.openExternal(url.href).catch(() => {});
  } catch {}
}

async function start() {
  platform.ready();
  // Session cookies stay in memory. Only the native session token is persisted, privately.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest({ urls: [`${origin}/auth/logout`] }, (details, callback) => {
    if (details.method === 'POST') {
      credentials.clear();
      authDeadline = 0;
    }
    callback({});
  });
  try {
    const token = await credentials.load(origin);
    if (token) await installCookie(token);
  } catch { console.warn('[vibez] Could not restore sign-in; sign in again from Vibez.'); }
  window = new BrowserWindow({
    title: 'Vibez', width: 520, height: 820, minWidth: 400, minHeight: 500,
    show: !background, icon: path.join(__dirname, 'assets', platform.windowIcon), backgroundColor: '#111119',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true,
      nodeIntegration: false, nodeIntegrationInSubFrames: false, webSecurity: true,
      backgroundThrottling: false, autoplayPolicy: 'document-user-activation-required',
    },
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Vibez', submenu: [
      { label: 'Sign in with Google', click: () => signIn().catch(() => {}) },
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => window.webContents.reload() },
      { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
    ] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
  ]));
  window.setAutoHideMenuBar(true);
  window.on('close', (event) => {
    if (!quitting) { event.preventDefault(); const result = hide(); if (result.error) show(); }
  });
  window.on('minimize', () => { if (status.video && !quitting) setImmediate(show); });
  window.webContents.on('will-navigate', (event, url) => {
    if (sameOrigin(url, origin) && new URL(url).pathname !== '/auth/google') return;
    event.preventDefault();
    if (sameOrigin(url, origin) && new URL(url).pathname === '/auth/google') signIn().catch(() => {});
    else external(url);
  });
  window.webContents.on('will-redirect', (event, url) => {
    if (!sameOrigin(url, origin)) { event.preventDefault(); external(url); }
  });
  window.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('render-process-gone', () => {
    status = { running: true, ...sanitizeStatus() };
    updateTray();
    show();
  });
  ipcMain.on('vibez:status', (event, value) => {
    if (!trustedSender(event)) return;
    const previousVideo = status.video;
    status = { running: true, ...sanitizeStatus(value), muted: window.webContents.isAudioMuted() };
    if (status.video && !previousVideo) show();
    updateTray();
  });
  ipcMain.on('vibez:sign-in', (event) => { if (trustedSender(event)) signIn().catch(() => {}); });
  ipcMain.on('vibez:retry', (event) => {
    if (event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame &&
        event.senderFrame.url === offlinePage) window.loadURL(origin).catch(loadFailed);
  });
  try {
    tray = new Tray(path.join(__dirname, 'assets', platform.trayIcon));
    tray.on('click', show);
    updateTray();
  } catch { console.warn('[vibez] Tray unavailable; use the app launcher.'); }
  control = await controlServer(platform, (command) => {
    if (command === 'status') return status;
    if (command === 'open') { show(); return { ok: true }; }
    if (command === 'hide') return hide();
    if (command === 'mute') return mute();
    if (command === 'quit') { setImmediate(() => app.quit()); return { ok: true }; }
    throw new Error('Invalid command');
  });
  window.webContents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
    if (isMainFrame && code !== -3 && sameOrigin(url, origin)) loadFailed({ code });
  });
  await window.loadURL(`${origin}${pendingLink?.type === 'channel' ? pendingLink.path : '/'}`).catch(loadFailed);
  if (pendingLink && pendingLink.type !== 'channel') await handleLink(pendingLink);
  pendingLink = null;
}

app.on('before-quit', () => {
  quitting = true;
  control?.close();
  if (control) platform.cleanupIPC();
});
app.on('activate', show);
app.on('window-all-closed', () => { if (quitting) app.quit(); });
