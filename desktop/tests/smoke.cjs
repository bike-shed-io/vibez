// Run with Electron on Windows, Linux, or macOS. The fixture uses a private profile.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { app, BrowserWindow, shell, safeStorage } = require('electron');
const { createPlatform } = require('../platform/index.cjs');
const { createCredentialStore } = require('../credentials.cjs');
const { request } = require('../ipc.cjs');

const root = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'vibez-smoke-'));
process.env.VIBEZ_DATA_DIR = path.join(root, 'profile');
process.env.XDG_CONFIG_HOME = path.join(root, 'config');
process.env.XDG_RUNTIME_DIR = path.join(root, 'runtime');
fs.mkdirSync(process.env.XDG_RUNTIME_DIR, { mode: 0o700 });
const platform = createPlatform({ app, safeStorage });
const locations = platform.locations;
let externalUrl;
shell.openExternal = async (value) => { externalUrl = value; };
let available = true;
let fixtureOrigin;
const server = http.createServer((req, res) => {
  if (!available) { res.destroy(); return; }
  if (req.url === '/auth/me') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.headers.authorization === 'Bearer fake.signature' ? { email: 'smoke@example.test' } : {}));
    return;
  }
  if (req.url === '/auth/logout') { res.statusCode = 204; res.end(); return; }
  res.setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html><style>.hidden{display:none}</style>
    <span id="statusDot" class="connected"></span><div id="radioScreen"><b id="channelTitle">Test room</b>
    <div id="trackInfo"><b id="trackTitle">Test &amp; Track</b><div id="ytPlayer" class="hidden"></div></div>
    <span id="listenerCount">2</span></div><a id="signInLink" href="/auth/google?client=web">Sign in</a>`);
});

async function until(check, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const result = await check(); if (result) return result; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for desktop state');
}

server.listen(0, '127.0.0.1', async () => {
  fixtureOrigin = `http://127.0.0.1:${server.address().port}`;
  process.env.VIBEZ_SERVER_URL = fixtureOrigin;
  require(process.env.VIBEZ_SMOKE_MAIN || '../main.cjs');
  try {
    await until(async () => (await request('status', locations.socket)).connected);
    const window = BrowserWindow.getAllWindows()[0];
    assert.equal(window.webContents.getLastWebPreferences().sandbox, true);
    assert.equal(window.webContents.getLastWebPreferences().contextIsolation, true);
    assert.equal(await window.webContents.executeJavaScript('typeof require'), 'undefined');
    const state = await request('status', locations.socket);
    assert.equal(state.title, 'Test & Track');
    assert.equal(state.channel, 'Test room');
    await request('hide', locations.socket);
    assert.equal(window.isVisible(), false);
    await request('open', locations.socket);
    assert.equal(window.isVisible(), true);
    await request('mute', locations.socket);
    assert.equal(window.webContents.isAudioMuted(), true);
    await window.webContents.executeJavaScript(`document.getElementById('ytPlayer').className = ''`);
    await until(async () => (await request('status', locations.socket)).video);
    assert.match((await request('hide', locations.socket)).error, /visible player/);
    assert.equal(window.isVisible(), true);
    // Unsolicited callbacks must not create a session.
    app.emit('second-instance', {}, ['vibez://auth?token=fake.signature']);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fs.existsSync(locations.token), false);
    await window.webContents.executeJavaScript(`document.getElementById('signInLink').click()`);
    await until(() => externalUrl);
    assert.equal(externalUrl, `${fixtureOrigin}/auth/google?client=mac`);
    const signedIn = new Promise((resolve) => window.webContents.once('did-finish-load', resolve));
    app.emit('second-instance', {}, ['vibez://auth?token=fake.signature']);
    await until(() => fs.existsSync(locations.token));
    assert.equal(await createCredentialStore(platform).load(fixtureOrigin), 'fake.signature');
    if (process.platform === 'win32') assert.equal(fs.readFileSync(locations.token).includes(Buffer.from('fake.signature')), false);
    else assert.equal(fs.statSync(locations.token).mode & 0o777, 0o600);
    await signedIn;
    await until(() => window.webContents.getURL() === `${fixtureOrigin}/`);
    await until(async () => window.webContents.executeJavaScript(`!!document.getElementById('signInLink')`));
    app.emit('second-instance', {}, ['vibez://channel/friend']);
    await until(() => window.webContents.getURL() === `${fixtureOrigin}/c/friend`);
    await until(async () => window.webContents.executeJavaScript(`!!document.getElementById('signInLink')`));
    await window.webContents.executeJavaScript(`fetch('/auth/logout', {method:'POST'})`);
    await until(() => !fs.existsSync(locations.token));
    available = false;
    app.emit('second-instance', {}, ['vibez://channel/offline']);
    await until(() => window.webContents.getURL().endsWith('/offline.html'));
    await until(async () => window.webContents.executeJavaScript(`!!document.getElementById('retry')`));
    available = true;
    await window.webContents.executeJavaScript(`document.getElementById('retry').click()`);
    await until(async () => (await request('status', locations.socket)).connected);
    console.log('PASS: real Electron sandbox, preload, status, hide/show, mute, visible video, native auth, deep links, logout, offline retry');
    app.quit();
  } catch (error) {
    console.error(error);
    app.exitCode = 1;
    app.exit(1);
  }
});

app.on('will-quit', () => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });
setTimeout(() => { console.error('Desktop smoke test timed out'); app.exit(1); }, 60000).unref();
