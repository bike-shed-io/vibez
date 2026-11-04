const { sanitizeStatus, escapeMarkup } = require('../../shared/core.cjs');

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

module.exports = { waybar };
