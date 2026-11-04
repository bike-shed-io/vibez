// Browser-compatible client policies: no Node, Electron, filesystem, or OS dependencies.
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

module.exports = { DEFAULT_SERVER, serverUrl, deepLink, sameOrigin, sanitizeStatus, escapeMarkup };
