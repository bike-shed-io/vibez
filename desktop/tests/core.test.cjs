const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { serverUrl, deepLink, sameOrigin, sanitizeStatus, hasDesktopFlag } = require('../shared/core.cjs');
const { locations: paths, privateDirectory } = require('../platform/posix.cjs');
const { createPlatform } = require('../platform/index.cjs');
const { createCredentialStore } = require('../credentials.cjs');
const { waybar } = require('../platform/linux/waybar.cjs');
const { request, controlServer } = require('../ipc.cjs');
const execute = promisify(execFile);

test('server is HTTPS and origin-only, with loopback HTTP for development', () => {
  assert.equal(serverUrl(), 'https://vibez.bike-shed.io');
  assert.equal(serverUrl('http://127.0.0.1:3005'), 'http://127.0.0.1:3005');
  for (const value of ['file:///tmp/index.html', 'http://example.com', 'https://user:pass@example.com', 'https://example.com/auth', 'https://example.com/?token=x']) {
    assert.throws(() => serverUrl(value));
  }
  assert.equal(sameOrigin('https://vibez.bike-shed.io.evil.test/', serverUrl()), false);
  assert.equal(sameOrigin('https://vibez.bike-shed.io/c/one', serverUrl()), true);
});

test('channel links are bounded and cannot navigate outside the configured server', () => {
  assert.deepEqual(deepLink('vibez://channel/abc_123-def'), { type: 'channel', path: '/c/abc_123-def' });
  assert.deepEqual(deepLink('vibez://open'), { type: 'open' });
  assert.deepEqual(deepLink('vibez://auth?token=abc.def-123_sig'), { type: 'auth', token: 'abc.def-123_sig' });
  assert.deepEqual(deepLink('vibez://auth?error=1'), { type: 'auth-error' });
  for (const value of ['https://channel/abc', 'vibez://channel/../../etc/passwd', 'vibez://channel/a?redirect=evil', 'vibez://user@channel/a', 'vibez://channel/a#evil', 'vibez://channel/%2fetc', 'vibez://auth?token=hello%0aworld']) {
    assert.equal(deepLink(value), null, value);
  }
});

test('protocol-handler arguments cannot trigger desktop commands after the URL separator', () => {
  assert.equal(hasDesktopFlag(['Vibez.exe', '--quit'], '--quit'), true);
  assert.equal(hasDesktopFlag(['Vibez.exe', '--background'], '--background'), true);
  for (const flag of ['--quit', '--uninstall-integration', '--background']) {
    assert.equal(hasDesktopFlag(['Vibez.exe', '--', 'vibez://open', flag], flag), false);
  }
});

test('remote metadata is bounded and Pango markup is escaped in Waybar', () => {
  const result = waybar({ running: true, connected: true, channel: '<b>room</b>', title: 'A & B\nC', listeners: '3', muted: true, token: 'secret' });
  assert.equal(result.text, '♫ A &amp; B C');
  assert.match(result.tooltip, /&lt;b&gt;room&lt;\/b&gt;/);
  assert.equal(result.class, 'muted');
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(sanitizeStatus({ title: 'x'.repeat(9999) }).title.length, 160);
  assert.equal(sanitizeStatus(null).connected, false);
  assert.equal(waybar({ running: false }).class, 'stopped');
});

test('XDG paths agree for the app and the lightweight CLI', { skip: process.platform === 'win32' }, () => {
  const result = paths({ XDG_CONFIG_HOME: '/config', XDG_RUNTIME_DIR: '/run/user/123' }, '/home/test');
  assert.equal(result.token, '/config/vibez-desktop/session-token');
  assert.equal(result.socket, '/run/user/123/vibez-desktop/control.sock');
  assert.equal(paths({}, '/home/test').socket, '/home/test/.local/state/vibez-desktop/control.sock');
});

test('private token writes replace atomically and never become world-readable', { skip: process.platform === 'win32' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibez-token-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const platform = createPlatform({ env: { VIBEZ_DATA_DIR: path.join(root, 'private') } });
  const token = platform.locations.token;
  const store = createCredentialStore(platform);
  await store.save(serverUrl(), 'first');
  await store.save(serverUrl(), 'second');
  assert.equal(await store.load(serverUrl()), 'second');
  assert.equal(await store.load('https://other.example'), null);
  assert.equal(fs.statSync(token).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(token)).mode & 0o777, 0o700);
  fs.symlinkSync(path.dirname(token), path.join(root, 'symlink'));
  assert.throws(() => privateDirectory(path.join(root, 'symlink')));
});

test('actual socket and CLI work without starting Electron and recover from missing app', async (t) => {
  // Keep this path short: Unix sockets on macOS have a small pathname limit.
  const root = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'vibez-ipc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, XDG_RUNTIME_DIR: root, VIBEZ_DATA_DIR: path.join(root, 'profile') };
  const platform = createPlatform({ env });
  const socket = platform.locations.socket;
  const server = await controlServer(platform, (command) => {
    if (command === 'status') return { running: true, connected: true, title: '<track>' };
    throw new Error('not allowed');
  });
  t.after(() => server.close());
  if (process.platform !== 'win32') assert.equal(fs.statSync(socket).mode & 0o777, 0o600);
  assert.equal((await request('status', socket)).title, '<track>');
  assert.equal((await request('arbitrary', socket)).error, 'Invalid command');
  const cli = path.join(__dirname, '../platform/linux/cli.cjs');
  const live = await execute(process.execPath, [cli, 'status', '--waybar'], { env });
  assert.equal(JSON.parse(live.stdout).text, '♫ &lt;track&gt;');
  await new Promise((resolve) => server.close(resolve));
  const stopped = await execute(process.execPath, [cli, 'status', '--waybar'], { env });
  assert.equal(JSON.parse(stopped.stdout).class, 'stopped');
});

test('launcher preserves system display selection unless explicitly overridden', { skip: process.platform === 'win32' }, async (t) => {
  const root = fs.mkdtempSync('/tmp/vibez-launch-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'runtime');
  fs.writeFileSync(runtime, '#!/bin/sh\nprintf \'%s\\n\' "$@"\n', { mode: 0o755 });
  const launcher = path.join(__dirname, '../platform/linux/vibez');
  const env = { ...process.env, VIBEZ_ELECTRON: runtime, VIBEZ_APP_DIR: '/test/app', VIBEZ_OZONE_PLATFORM: '' };
  const normal = await execute('bash', [launcher, 'open', 'vibez://channel/friend'], { env });
  assert.deepEqual(normal.stdout.trim().split('\n'), ['/test/app', 'vibez://channel/friend']);
  const x11 = await execute('bash', [launcher, 'open'], { env: { ...env, VIBEZ_OZONE_PLATFORM: 'x11' } });
  assert.deepEqual(x11.stdout.trim().split('\n'), ['--ozone-platform=x11', '/test/app']);
  await assert.rejects(execute('bash', [launcher, '--no-sandbox'], { env }));
});
