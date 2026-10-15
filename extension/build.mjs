#!/usr/bin/env node
// Builds the extension for Chrome/Edge and Firefox from the same source:
//   node build.mjs            -> dist/chrome/, dist/firefox/, dist/synapse-chrome.zip, dist/synapse-firefox.zip
// Firefox differences: background runs as a classic script (bundled, no ES-module import), the promise-based
// `browser` namespace is used as `chrome`, options open in a tab, and an add-on id + data-collection
// declaration are added for addons.mozilla.org.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');
const FILES = ['background.js', 'categories.js', 'blocked.html', 'blocked.js', 'options.html', 'options.js', 'popup.html', 'popup.js', 'ui.css', 'icons'];
const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));
const COMPAT = "// Firefox: use the promise-based `browser` namespace for `chrome.*` calls.\nif (globalThis.browser?.runtime?.id && globalThis.chrome !== globalThis.browser) { try { globalThis.chrome = globalThis.browser; } catch {} }\n";

function copy(target) {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const f of FILES) cpSync(join(here, f), join(target, f), { recursive: true });
}

function zip(folder, out) {
  rmSync(out, { force: true });
  execFileSync('zip', ['-qr', '-X', out, '.'], { cwd: folder });
}

// --- Chrome / Edge: the source as-is.
const chromeDir = join(dist, 'chrome');
copy(chromeDir);
writeFileSync(join(chromeDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

// --- Firefox.
const ffDir = join(dist, 'firefox');
copy(ffDir);
const strip = (src) => src.replace(/^export\s+(const|function|async function|let)\s/gm, '$1 ');
const categories = strip(readFileSync(join(here, 'categories.js'), 'utf8'));
const background = readFileSync(join(here, 'background.js'), 'utf8').replace(/^import\s+\{[^}]*\}\s+from\s+'\.\/categories\.js';\s*$/m, '');
if (/^import\s/m.test(background)) throw new Error('background.js has an import the Firefox bundle does not handle');
writeFileSync(join(ffDir, 'background.js'), `${COMPAT}\n// ---- categories.js (inlined)\n${categories}\n// ---- background.js\n${background}`);
rmSync(join(ffDir, 'categories.js')); // still needed by popup/options:
cpSync(join(here, 'categories.js'), join(ffDir, 'categories.js'));
for (const page of ['popup.js', 'options.js', 'blocked.js']) {
  const p = join(ffDir, page);
  const src = readFileSync(p, 'utf8');
  // Module scripts run imports first, so the shim goes in its own module imported at the top.
  writeFileSync(p, `import './compat.js';\n${src}`);
}
writeFileSync(join(ffDir, 'compat.js'), COMPAT);

const ff = { ...manifest };
delete ff.minimum_chrome_version;
ff.background = { scripts: ['background.js'] };
ff.options_ui = { page: 'options.html', open_in_tab: true };
delete ff.options_page;
ff.browser_specific_settings = {
  gecko: {
    id: 'screen-time@synapse-ai.app',
    strict_min_version: '115.0',
    // Required for new add-ons on addons.mozilla.org: this extension sends per-site minutes to your Synapse server.
    data_collection_permissions: { required: ['browsingActivity'] },
  },
};
writeFileSync(join(ffDir, 'manifest.json'), JSON.stringify(ff, null, 2));

zip(chromeDir, join(dist, 'synapse-chrome.zip'));
zip(ffDir, join(dist, 'synapse-firefox.zip'));
console.log('Built dist/synapse-chrome.zip and dist/synapse-firefox.zip (version ' + manifest.version + ')');
if (!existsSync(join(ffDir, 'compat.js'))) process.exit(1);
