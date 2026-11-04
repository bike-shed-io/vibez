#!/usr/bin/env node
const { spawn, spawnSync } = require('node:child_process');
const { request, waybar } = require('./core.cjs');

async function main(argv) {
  const command = argv[0];
  if (command === 'status') {
    let result;
    try { result = await request('status'); } catch { result = { running: false }; }
    console.log(JSON.stringify(argv.includes('--waybar') ? waybar(result) : result));
    return;
  }
  if (command === 'menu') {
    const options = ['Open Vibez', 'Mute / unmute locally', 'Hide window', 'Quit Vibez'];
    const menu = spawnSync('rofi', ['-dmenu', '-p', 'Vibez', '-no-custom'], { input: options.join('\n'), encoding: 'utf8' });
    if (menu.error?.code === 'ENOENT') return launch();
    if (menu.status !== 0) return;
    const selected = ['open', 'mute', 'hide', 'quit'][options.indexOf(menu.stdout.trim())];
    if (!selected) return;
    if (selected === 'open') return launch();
    const result = await request(selected);
    if (result.error) throw new Error(result.error);
    return;
  }
  if (!['mute', 'hide', 'quit'].includes(command)) throw new Error('Usage: vibez [open|status [--waybar]|menu|mute|hide|quit|vibez://channel/<id>]');
  const result = await request(command);
  if (result.error) throw new Error(result.error);
}

function launch() {
  const child = spawn(process.env.VIBEZ_LAUNCHER || 'vibez', ['open'], { detached: true, stdio: 'ignore' });
  child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  child.unref();
}

main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
