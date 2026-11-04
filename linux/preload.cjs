// No bridge is exposed to the hosted page. All observations stay in the isolated world.
const { ipcRenderer } = require('electron');

if (process.isMainFrame) {
  window.addEventListener('DOMContentLoaded', () => {
    if (location.protocol === 'file:') {
      document.getElementById('retry')?.addEventListener('click', () => ipcRenderer.send('vibez:retry'));
      return;
    }
    let last = '';
    let scheduled = false;
    const visible = (id) => {
      const element = document.getElementById(id);
      return !!element && !element.classList.contains('hidden');
    };
    function publish() {
      scheduled = false;
      const state = {
        connected: document.getElementById('statusDot')?.classList.contains('connected') === true,
        channel: visible('radioScreen') ? document.getElementById('channelTitle')?.textContent : '',
        title: visible('radioScreen') && visible('trackInfo') ? document.getElementById('trackTitle')?.textContent : '',
        listeners: visible('radioScreen') ? document.getElementById('listenerCount')?.textContent : '',
        video: visible('radioScreen') && visible('trackInfo') && visible('ytPlayer'),
      };
      const serialized = JSON.stringify(state);
      if (serialized !== last) { last = serialized; ipcRenderer.send('vibez:status', state); }
    }
    new MutationObserver(() => {
      if (!scheduled) { scheduled = true; setTimeout(publish, 150); }
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'] });
    document.addEventListener('click', (event) => {
      const anchor = event.target.closest?.('a[href]');
      if (!anchor) return;
      const url = new URL(anchor.href, location.href);
      if (url.origin === location.origin && url.pathname === '/auth/google') {
        event.preventDefault();
        event.stopImmediatePropagation();
        ipcRenderer.send('vibez:sign-in');
      }
    }, true);
    publish();
  });
}
