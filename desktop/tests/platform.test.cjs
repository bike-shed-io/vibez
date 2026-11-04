const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { locations, createWindows, APP_ID } = require('../platform/windows.cjs');
const { createCredentialStore } = require('../credentials.cjs');

test('Windows profile paths and per-profile named pipes use Windows conventions', () => {
  const alice = locations({ APPDATA: 'C:\\Users\\Alice\\AppData\\Roaming' });
  const bob = locations({ APPDATA: 'C:\\Users\\Bob\\AppData\\Roaming' });
  assert.equal(alice.config, 'C:\\Users\\Alice\\AppData\\Roaming\\Vibez');
  assert.match(alice.socket, /^\\\\\.\\pipe\\vibez-desktop-[0-9a-f]{24}$/);
  assert.notEqual(alice.socket, bob.socket);
  assert.equal(alice.socket, locations({ APPDATA: 'c:\\users\\alice\\appdata\\roaming' }).socket);
  assert.equal(alice.token.endsWith('session-token.dpapi'), true);
});

test('Windows credentials require OS encryption and never fall back to clear text', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibez-dpapi-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const adapter = createWindows({ env: { VIBEZ_DATA_DIR: root }, safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (value) => Buffer.from(value.split('').reverse().join('')),
    decryptStringAsync: async (value) => ({ result: value.toString().split('').reverse().join(''), shouldReEncrypt: false }),
  } });
  // Native path formatting is tested above; use this host's filesystem for the storage contract.
  adapter.locations.token = path.join(root, 'session-token.dpapi');
  const store = createCredentialStore(adapter);
  await store.save('https://vibez.bike-shed.io', 'private-token');
  assert.equal(fs.readFileSync(adapter.locations.token).includes(Buffer.from('private-token')), false);
  assert.equal(await store.load('https://vibez.bike-shed.io'), 'private-token');
  assert.equal(await store.load('https://other.example'), null);
  store.clear();
  assert.equal(fs.existsSync(adapter.locations.token), false);
  const unavailable = createWindows({ env: { VIBEZ_DATA_DIR: root }, safeStorage: { isAsyncEncryptionAvailable: async () => false } });
  unavailable.locations.token = path.join(root, 'must-not-exist');
  await assert.rejects(createCredentialStore(unavailable).save('https://example.com', 'secret'), /encryption is unavailable/);
  assert.equal(fs.existsSync(unavailable.locations.token), false);
});

test('Windows protocol and startup registration only activate for packaged apps', () => {
  const calls = [];
  const app = {
    isPackaged: false, getPath: () => 'C:\\Profile',
    setAppUserModelId: (value) => calls.push(['appId', value]),
    setAsDefaultProtocolClient: (value) => calls.push(['protocol', value]),
    getLoginItemSettings: () => ({ openAtLogin: true }),
    setLoginItemSettings: (value) => calls.push(['startup', value]),
  };
  const adapter = createWindows({ app });
  adapter.configure();
  adapter.ready();
  assert.deepEqual(calls, [['appId', APP_ID]]);
  assert.equal(adapter.startup.available(), false);
  app.isPackaged = true;
  adapter.ready();
  assert.deepEqual(calls[1], ['protocol', 'vibez']);
  assert.equal(adapter.startup.available(), true);
  assert.equal(adapter.startup.enabled(), true);
  adapter.startup.set(true);
  assert.deepEqual(calls[2][1].args, ['--background']);
});

test('Windows uninstall only removes the current app protocol handler', () => {
  const removed = [];
  const app = {
    isPackaged: true, getPath: () => 'C:\\Profile',
    isDefaultProtocolClient: () => false,
    removeAsDefaultProtocolClient: (scheme) => removed.push(scheme),
    setLoginItemSettings: (value) => removed.push(value),
  };
  const adapter = createWindows({ app });
  adapter.removeIntegration();
  assert.equal(removed.some((value) => value === 'vibez'), false);
  app.isDefaultProtocolClient = () => true;
  adapter.removeIntegration();
  assert.equal(removed.includes('vibez'), true);
  assert.equal(removed.at(-1).openAtLogin, false);
  assert.equal(removed.at(-1).name, APP_ID);
});

test('Windows uninstall manifest deletes known payload files and preserves unrelated files', (t) => {
  const { createUninstallManifest } = require('../build/windows.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibez-uninstall-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const payload = path.join(root, 'app');
  fs.mkdirSync(path.join(payload, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(payload, 'Vibez.exe'), 'runtime');
  fs.writeFileSync(path.join(payload, 'resources/app.asar'), 'app');
  fs.writeFileSync(path.join(root, 'unrelated.txt'), 'keep');
  const manifest = createUninstallManifest(payload);
  assert.match(manifest, /Delete "\$INSTDIR\\Vibez\.exe"/);
  assert.match(manifest, /Delete "\$INSTDIR\\resources\\app\.asar"/);
  assert.equal(manifest.includes('unrelated.txt'), false);
  assert.equal(/RMDir\s+\/r/i.test(manifest), false);
  assert.equal(manifest.includes(root), false);
});
