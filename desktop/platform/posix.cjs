const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error(`Not a private directory owned by this user: ${directory}`);
  }
  fs.chmodSync(directory, 0o700);
}

function locations(env = process.env, home = os.homedir()) {
  const config = env.VIBEZ_DATA_DIR || path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'vibez-desktop');
  const runtime = path.join(env.XDG_RUNTIME_DIR || env.XDG_STATE_HOME || path.join(home, '.local/state'), 'vibez-desktop');
  return { config, runtime, socket: path.join(runtime, 'control.sock'), token: path.join(config, 'session-token') };
}

function createPosix({ env = process.env, home, app, platform = process.platform } = {}) {
  const files = locations(env, home);
  return {
    name: platform, locations: files,
    prepareData: () => privateDirectory(files.config),
    fileOptions: { mode: 0o600, flag: 'wx' },
    protectFile: (file) => fs.chmodSync(file, 0o600),
    encodeCredentials: async (value) => Buffer.from(value, 'utf8'),
    decodeCredentials: async (value) => value.toString('utf8'),
    prepareIPC() { privateDirectory(files.runtime); fs.rmSync(files.socket, { force: true }); },
    secureIPC: () => fs.chmodSync(files.socket, 0o600),
    cleanupIPC: () => fs.rmSync(files.socket, { force: true }),
    configure() {
      if (app && platform === 'linux') {
        app.setDesktopName('vibez.desktop');
        // PowerPat has no working Secret Service. Avoid Chromium keyring activation too.
        app.commandLine.appendSwitch('password-store', 'basic');
      }
    },
    ready() {},
    startup: null,
    trayIcon: 'tray.png', windowIcon: 'vibez.png',
  };
}

module.exports = { createPosix, locations, privateDirectory };
