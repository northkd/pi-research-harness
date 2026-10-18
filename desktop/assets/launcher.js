const api = window.researchDesktop;
const local = document.querySelector('#local');
const error = document.querySelector('#connection-error');
function render(state) {
  document.querySelector('#status-title').textContent = state.title;
  document.querySelector('#status-detail').textContent = state.detail;
  document.querySelector('#version').textContent = `v${state.version}`;
  document.querySelector('#indicator').classList.toggle('error', state.phase === 'error');
  local.disabled = state.phase === 'starting';
  if (state.remoteUrl) document.querySelector('#url').value = state.remoteUrl;
}
async function action(fn) {
  error.textContent = '';
  try { await fn(); } catch (cause) { error.textContent = cause.message; }
}
api.onState(render);
api.getState().then(render).catch((cause) => { error.textContent = cause.message; });
local.addEventListener('click', () => action(() => api.startLocal()));
document.querySelector('#logs').addEventListener('click', () => action(() => api.openLogs()));
document.querySelector('#remote-form').addEventListener('submit', (event) => {
  event.preventDefault();
  action(() => api.connect(document.querySelector('#url').value));
});
