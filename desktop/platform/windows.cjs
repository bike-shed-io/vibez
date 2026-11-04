const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const APP_ID = 'io.bike-shed.vibez.desktop';

function locations(env = process.env, home = os.homedir(), appData) {
  const config = env.VIBEZ_DATA_DIR || path.win32.join(env.APPDATA || appData || path.win32.join(home, 'AppData', 'Roaming'), 'Vibez');
  // Separate named pipes per Windows profile; the OS supplies the pipe's default ACL.
  const profile = createHash('sha256').update(path.win32.resolve(config).toLowerCase()).digest('hex').slice(0, 24);
  return { config, socket: `\\\\.\\pipe\\vibez-desktop-${profile}`, token: path.win32.join(config, 'session-token.dpapi') };
}

function createWindows({ env = process.env, home, app, safeStorage } = {}) {
  const files = locations(env, home, app?.getPath('appData'));
  async function requireEncryption() {
    if (!safeStorage || !await safeStorage.isAsyncEncryptionAvailable()) {
      throw new Error('Windows credential encryption is unavailable.');
    }
  }
  return {
    name: 'win32', locations: files,
    prepareData() {
      fs.mkdirSync(files.config, { recursive: true });
      if (!fs.lstatSync(files.config).isDirectory()) throw new Error('Invalid Windows profile directory.');
    },
    fileOptions: { flag: 'wx' },
    protectFile() {}, // NTFS profile ACLs and DPAPI replace POSIX chmod.
    async encodeCredentials(value) { await requireEncryption(); return safeStorage.encryptStringAsync(value); },
    async decodeCredentials(value) { await requireEncryption(); return (await safeStorage.decryptStringAsync(value)).result; },
    prepareIPC() {}, // Named pipes are kernel objects, never filesystem entries.
    secureIPC() {},
    cleanupIPC() {},
    configure() { app?.setAppUserModelId(APP_ID); },
    ready() { if (app?.isPackaged) app.setAsDefaultProtocolClient('vibez'); },
    removeIntegration() {
      if (!app?.isPackaged) return;
      if (app.isDefaultProtocolClient('vibez')) app.removeAsDefaultProtocolClient('vibez');
      app.setLoginItemSettings({ openAtLogin: false, name: APP_ID, path: process.execPath, args: ['--background'] });
    },
    startup: app ? {
      available: () => app.isPackaged,
      enabled: () => app.getLoginItemSettings({ path: process.execPath, args: ['--background'] }).openAtLogin,
      set: (enabled) => app.setLoginItemSettings({ openAtLogin: enabled, name: APP_ID, path: process.execPath, args: ['--background'] }),
    } : null,
    trayIcon: 'vibez.ico', windowIcon: 'vibez.ico',
  };
}

module.exports = { APP_ID, createWindows, locations };
