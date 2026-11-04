const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const DEFAULT_SERVER = 'https://vibez.bike-shed.io';

function serverUrl(value = DEFAULT_SERVER) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) {
    throw new Error('VIBEZ_SERVER_URL must be an HTTPS origin (HTTP is allowed on localhost).');
  }
  return url.origin;
}

function paths(env = process.env, home = os.homedir()) {
  const config = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'vibez-desktop');
  const runtime = path.join(env.XDG_RUNTIME_DIR || env.XDG_STATE_HOME || path.join(home, '.local/state'), 'vibez-desktop');
  return { config, runtime, socket: path.join(runtime, 'control.sock'), token: path.join(config, 'session-token') };
}

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error(`Not a private directory owned by this user: ${directory}`);
  }
  fs.chmodSync(directory, 0o700);
}

function saveToken(file, value) {
  privateDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
}

function deepLink(value) {
  try {
    if (typeof value !== 'string' || value.length > 16384) return null;
    const url = new URL(value);
    if (url.protocol !== 'vibez:' || url.username || url.password || url.port || url.hash) return null;
    if (url.hostname === 'open' && /^\/?$/.test(url.pathname) && !url.search) return { type: 'open' };
    if (url.hostname === 'channel' && /^\/[\w-]{1,128}$/.test(url.pathname) && !url.search) {
      return { type: 'channel', path: `/c${url.pathname}` };
    }
    if (url.hostname === 'auth' && /^\/?$/.test(url.pathname)) {
      const token = url.searchParams.get('token');
      if (token && /^[A-Za-z0-9_.-]{1,12000}$/.test(token)) return { type: 'auth', token };
      if (url.searchParams.has('error')) return { type: 'auth-error' };
    }
  } catch {}
  return null;
}

function sameOrigin(value, origin) {
  try { return new URL(value).origin === origin; } catch { return false; }
}

function cleanText(value, length = 160) {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, length) : '';
}

function sanitizeStatus(value = {}) {
  if (!value || typeof value !== 'object') value = {};
  return {
    connected: value.connected === true,
    channel: cleanText(value.channel),
    title: cleanText(value.title),
    listeners: cleanText(value.listeners, 8),
    video: value.video === true,
    muted: value.muted === true,
  };
}

function escapeMarkup(value) {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
}

function waybar(status) {
  const state = sanitizeStatus(status);
  const running = status.running === true;
  const label = !running ? 'Vibez' : state.title || state.channel || 'Vibez';
  const details = !running ? ['Vibez is not running', 'Click to open'] : [
    state.connected ? 'Connected' : 'Connecting / offline', state.channel, state.title,
    state.listeners && `${state.listeners} listeners`, state.muted && 'Locally muted',
  ].filter(Boolean);
  return {
    text: escapeMarkup(`♫ ${label}`),
    class: !running ? 'stopped' : !state.connected ? 'disconnected' : state.muted ? 'muted' : state.channel ? 'listening' : 'connected',
    tooltip: details.map(escapeMarkup).join('\n'),
    alt: !running ? 'stopped' : state.muted ? 'muted' : 'running',
  };
}

function request(command, socketPath = paths().socket, timeout = 1500) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    client.setEncoding('utf8');
    let received = '';
    const fail = (error) => { client.destroy(); reject(error); };
    client.setTimeout(timeout, () => fail(new Error('Vibez did not respond.')));
    client.on('error', fail);
    client.on('connect', () => client.write(`${JSON.stringify({ command })}\n`));
    client.on('data', (data) => {
      received += data.toString();
      if (received.length > 16384) return fail(new Error('Invalid response.'));
      if (received.includes('\n')) {
        client.end();
        try { resolve(JSON.parse(received.split('\n')[0])); } catch (error) { fail(error); }
      }
    });
    client.on('end', () => { if (!received.includes('\n')) fail(new Error('Incomplete response.')); });
  });
}

function controlServer(socketPath, handler) {
  privateDirectory(path.dirname(socketPath));
  fs.rmSync(socketPath, { force: true });
  const server = net.createServer((client) => {
    let input = '';
    client.setEncoding('utf8');
    client.setTimeout(1500, () => client.destroy());
    client.on('error', () => {});
    client.on('data', (data) => {
      input += data;
      if (input.length > 1024) return client.destroy();
      if (!input.includes('\n')) return;
      client.removeAllListeners('data');
      Promise.resolve().then(() => handler(JSON.parse(input.split('\n')[0]).command))
        .then((result) => client.end(`${JSON.stringify(result)}\n`))
        .catch(() => client.end('{"error":"Invalid command"}\n'));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => { fs.chmodSync(socketPath, 0o600); resolve(server); });
  });
}

module.exports = { DEFAULT_SERVER, serverUrl, paths, privateDirectory, saveToken, deepLink, sameOrigin, sanitizeStatus, waybar, request, controlServer };
