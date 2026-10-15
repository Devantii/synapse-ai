import { CATEGORY_LABELS, categorize } from './categories.js';
const $ = (s) => document.querySelector(s);
const send = (msg) => chrome.runtime.sendMessage(msg);
const show = (el, text, ok) => { el.hidden = false; el.className = 'status ' + (ok ? 'ok' : 'err'); el.textContent = text; };
let state;

async function load() {
  state = await send({ type: 'status' });
  const c = state.config;
  $('#server').value = c.server || '';
  $('#key').value = '';
  $('#key').placeholder = c.hasKey ? 'Saved. Paste a new key to replace it.' : 'syn_...';
  $('#key-hint').textContent = c.hasKey ? 'A key is saved. It is never shown again here.' : '';
  $('#disconnect').hidden = !c.hasKey;
  $('#excluded').value = (c.excluded || []).join('\n');
  const b = c.blocking || { enabled: true, categories: ['social', 'entertainment', 'games'], sites: [] };
  $('#block-on').checked = !!b.enabled;
  $('#block-sites').value = (b.sites || []).join('\n');
  const cats = $('#block-cats');
  cats.querySelectorAll('label').forEach((l) => l.remove());
  for (const [k, v] of Object.entries(CATEGORY_LABELS)) {
    const l = document.createElement('label');
    l.style.cssText = 'display:flex;gap:8px;align-items:center;font-weight:400;margin:0';
    l.innerHTML = `<input type="checkbox" value="${k}" style="width:auto" ${b.categories.includes(k) ? 'checked' : ''} /> `;
    l.append(v);
    cats.append(l);
  }

  const totals = {};
  for (const day of Object.values(state.totals)) for (const [h, s] of Object.entries(day)) totals[h] = (totals[h] || 0) + s;
  const top = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 15);
  $('#cats-empty').hidden = top.length > 0;
  $('#cats').replaceChildren(...top.map(([host]) => {
    const row = document.createElement('div');
    const name = document.createElement('span');
    name.textContent = host;
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', `Category for ${host}`);
    for (const [k, v] of Object.entries(CATEGORY_LABELS)) sel.add(new Option(v, k));
    sel.value = categorize(host, c.overrides);
    sel.addEventListener('change', async () => {
      const overrides = { ...(state.config.overrides || {}), [host]: sel.value };
      await send({ type: 'saveConfig', overrides });
      state.config.overrides = overrides;
    });
    row.append(name, sel);
    return row;
  }));
}

$('#connect').addEventListener('submit', async (e) => {
  e.preventDefault();
  const server = $('#server').value.trim().replace(/\/+$/, '');
  const key = $('#key').value.trim();
  const st = $('#conn-status');
  show(st, 'Checking…', true);
  const r = await send({ type: 'test', server, key });
  if (!r.ok) return show(st, r.error, false);
  await send({ type: 'saveConfig', server, key });
  const synced = await send({ type: 'sync' });
  show(st, `Connected as ${r.user} (${r.device}).` + (r.usageConsent ? (synced.ok ? ' Totals synced.' : ` Sync failed: ${synced.error}`) : ' Turn on "Save screen-time data" in Synapse > Privacy so totals can upload.'), r.usageConsent && synced.ok);
  load();
});
$('#disconnect').addEventListener('click', async () => {
  if (!confirm('Remove the saved key? Measuring continues locally but nothing will upload. Revoke the key in Synapse too if you no longer need it.')) return;
  await send({ type: 'disconnect' });
  show($('#conn-status'), 'Disconnected.', true);
  load();
});
$('#save-blocking').addEventListener('click', async () => {
  await send({ type: 'saveBlocking', blocking: {
    enabled: $('#block-on').checked,
    categories: [...document.querySelectorAll('#block-cats input:checked')].map((i) => i.value),
    sites: $('#block-sites').value.split('\n').map((s) => s.trim()).filter(Boolean),
  } });
  await load();
  $('#save-blocking').textContent = 'Saved';
  setTimeout(() => ($('#save-blocking').textContent = 'Save'), 1500);
});
$('#save-excluded').addEventListener('click', async () => {
  await send({ type: 'saveConfig', excluded: $('#excluded').value.split('\n').map((s) => s.trim()).filter(Boolean) });
  await load();
  $('#save-excluded').textContent = 'Saved';
  setTimeout(() => ($('#save-excluded').textContent = 'Save list'), 1500);
});
$('#clear').addEventListener('click', async () => {
  if (!confirm('Clear all website totals stored on this computer? Data already sent to Synapse stays there.')) return;
  await send({ type: 'clearData' });
  load();
});
load();
