import { CATEGORY_LABELS, categorize } from './categories.js';
const $ = (s) => document.querySelector(s);
const fmt = (sec) => { const m = Math.round(sec / 60); const h = Math.floor(m / 60); return h ? `${h}h ${m % 60}m` : sec < 60 && sec > 0 ? '<1m' : `${m}m`; };
const ago = (ts) => { const s = (Date.now() - ts) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`; };
const send = (msg) => chrome.runtime.sendMessage(msg);

async function render() {
  const s = await send({ type: 'status' });
  const sites = Object.entries(s.today).sort((a, b) => b[1] - a[1]);
  const total = sites.reduce((a, [, v]) => a + v, 0);
  $('#total').textContent = fmt(total);
  const focusLine = s.focus && s.config.blocking?.enabled ? ` Focus block on: distracting sites paused until ${new Date(s.focus.endsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : '';
  $('#now').textContent = (s.config.paused ? 'Paused: nothing is being measured.' : s.current ? `Measuring ${s.current.host}` : 'Not measuring right now (idle, unfocused or excluded).') + focusLine;
  $('#pause').textContent = s.config.paused ? 'Resume' : 'Pause';
  $('#pause').setAttribute('aria-pressed', String(!!s.config.paused));
  const max = sites[0]?.[1] || 1;
  const list = $('#sites');
  list.replaceChildren(...sites.slice(0, 8).map(([host, sec]) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="host"></span><span class="num muted"></span><span class="bar"><i></i></span>`;
    li.querySelector('.host').textContent = host;
    li.querySelector('.host').title = CATEGORY_LABELS[categorize(host, s.config.overrides)];
    li.querySelector('.num').textContent = fmt(sec);
    li.querySelector('i').style.width = `${(sec / max) * 100}%`;
    return li;
  }));
  $('#empty').hidden = sites.length > 0;
  const st = $('#status');
  if (!s.config.server || !s.config.hasKey) { st.className = 'status err'; st.textContent = 'Not connected to Synapse. Totals are kept on this computer until you connect in Settings.'; }
  else if (s.status.ok === false && s.status.lastError) { st.className = 'status err'; st.textContent = `Last sync failed: ${s.status.lastError}`; }
  else { st.className = 'status ok'; st.textContent = s.status.lastSync ? `Synced ${ago(s.status.lastSync)} to ${new URL(s.config.server).host}` : `Connected to ${new URL(s.config.server).host}. First sync within 5 minutes.`; }
  $('#open').hidden = !s.config.server;
  $('#open').dataset.url = s.config.server ? s.config.server + '/#/screen-time' : '';
}

$('#pause').addEventListener('click', async () => { await send({ type: 'setPaused', paused: $('#pause').getAttribute('aria-pressed') !== 'true' }); render(); });
$('#sync').addEventListener('click', async (e) => { e.target.disabled = true; e.target.textContent = 'Syncing'; await send({ type: 'sync' }); e.target.disabled = false; e.target.textContent = 'Sync now'; render(); });
$('#settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('#open').addEventListener('click', (e) => chrome.tabs.create({ url: e.target.dataset.url }));
render();
