(() => {
  const dialog = document.getElementById('app-shutdown');
  const message = document.getElementById('app-shutdown-message');
  const retry = document.getElementById('app-shutdown-retry');
  function render(state) {
    if (!state) return;
    message.textContent = state.message;
    retry.hidden = state.phase !== 'failed';
    document.getElementById('vpn-terminal-settings').disabled = true;
    document.getElementById('app-shutdown-title').textContent = state.phase === 'failed' ? 'VPN disconnect needs attention' : 'Closing M3';
    // Close another modal first so the shutdown notice remains visible. The
    // terminal button can then open diagnostics on top of this notice.
    if (!dialog.open) {
      document.getElementById('vpn-terminal').close(); dialog.showModal();
    }
  }
  dialog.addEventListener('cancel', event => event.preventDefault());
  document.getElementById('app-shutdown-terminal').addEventListener('click', () => window.vpnTerminal.open());
  retry.addEventListener('click', () => { retry.hidden = true; window.api.retryQuit(); });
  window.api.on('app:shutdown', render);
  window.api.shutdownState().then(render).catch(() => {});
})();
