const q = new URLSearchParams(location.search);
const host = q.get('host') || 'This site';
const until = Number(q.get('until')) || 0;
const original = q.get('url') || '';
const isLimit = q.get('reason') === 'limit';
const limitMin = Number(q.get('limit')) || 0;
const started = Date.now();
const $ = (s) => document.querySelector(s);
const safeUrl = /^https?:\/\//.test(original) ? original : null;

$('#host').textContent = host;
document.title = `${host} is paused`;
if (isLimit) {
  $('#why').textContent = 'has reached its daily limit';
  $('#foot').textContent = `You set a ${limitMin}-minute daily limit for this site in Synapse. Change or remove it on the Screen time page.`;
}
const pad = (n) => String(n).padStart(2, '0');

function tick() {
  const ms = until - Date.now();
  if (ms <= 0) {
    $('#left').textContent = '00:00';
    $('#msg').textContent = isLimit ? 'A new day: your limit has reset. Opening the page again.' : 'Focus block finished. Nice work. Opening the page again.';
    if (safeUrl) setTimeout(() => location.replace(safeUrl), 1200);
    return;
  }
  const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
  $('#left').textContent = isLimit ? `${limitMin}m` : `${pad(m)}:${pad(s)}`;
  const total = Math.max(until - started, 1);
  $('#arc').style.strokeDashoffset = String(276.5 * (1 - ms / Math.max(total, ms)));
  $('#msg').textContent = isLimit
    ? `You've used your ${limitMin} minutes for today. It opens again tomorrow.`
    : `It'll open again at ${new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}, when your focus block ends.`;
  if (isLimit) { $('#arc').style.strokeDashoffset = '0'; setTimeout(tick, 30000); return; }
  setTimeout(tick, 1000);
}
tick();

$('#back').addEventListener('click', () => (history.length > 2 ? history.go(-2) : chrome.tabs.update({ url: 'chrome://newtab/' })));
$('#allow').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'allowTemp', host });
  if (safeUrl) location.replace(safeUrl);
});
