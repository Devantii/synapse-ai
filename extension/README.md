# Synapse Screen Time (browser extension)

Measures how long you actively spend on each website and adds the daily totals to your Synapse account. Works in Chrome, Edge, Brave and other Chromium browsers (version 116+).

## Install (developer mode)

1. Open `chrome://extensions` (Edge: `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose this `extension` folder.
4. The settings page opens. In Synapse, go to **Privacy → Connect browser extension**, name it, and copy the key.
5. Paste the server address (for example `http://localhost:3000`) and the key, then click **Test and save**.

Pin the extension to see today's totals, pause measuring, or sync on demand.

In Synapse, **Privacy → Save screen-time data** must be on, or uploads are refused.

## Pause distracting sites during focus

While a focus block is running in Synapse (on any device), the extension pauses distracting sites: open tabs and new visits show a calm "paused until 10:25" page instead.

- **What's paused:** Social media, Video & streaming and Games by default. Change the categories, or add specific sites, in Settings.
- **Escape hatch:** **Open for 5 minutes** is always there. Breaks and idle time never pause anything.
- **When it ends:** paused tabs reopen automatically when the block finishes.
- **How it knows:** the extension checks Synapse every 30 seconds, so a block can take up to 30 seconds to kick in.
- **Requirement:** it needs the extension connected to your Synapse account. Your Synapse dashboard itself is never paused.

## Daily limits

Set limits on the **Screen time** page in Synapse, for example `instagram.com`, 45 minutes a day. The extension checks them every 30 seconds:

- **At 80%:** a notification says how many minutes are left (once per site per day).
- **At 100%:** the site pauses until midnight with a "reached its daily limit" page, and **Open for 5 minutes** still works.
- **What counts:** the extension counts this browser's own measured time. The dashboard's progress bars count all your sources, including typed-in and desktop time.

## What counts as time

A second is credited to a site only when all of these are true:

- its tab is the active tab in the focused browser window;
- you've used the keyboard or mouse in the last 60 seconds and the screen isn't locked;
- it's an ordinary `http`/`https` page, not incognito, and not on your ignore list.

Your Synapse dashboard is never counted, because the dashboard measures its own time. Long gaps the extension couldn't observe, such as sleep or a crash, are credited for at most 2 minutes.

Passive watching without touching the mouse, such as a long video, stops counting after 60 seconds.

## Data

| | |
|---|---|
| **Stored in the browser** | Hostname (e.g. `youtube.com`) and seconds per local day, kept 30 days. |
| **Never collected** | Full URLs, page titles, page content, form input, incognito browsing. |
| **Sent** | Per-site minutes for the last 7 days, every 5 minutes, to the server you configured, using your device key. Each upload replaces the previous one for those days, so totals never double up. |

The extension can't read your Synapse data. Its key only allows uploading screen time, and you can revoke it in Synapse at any time.

## Permissions

| Permission | Why |
|---|---|
| `tabs` | Read the active tab's address to get its hostname. Chrome shows this as "Read your browsing history". |
| `idle` | Stop counting when you're away or the screen is locked. |
| `alarms` | Checkpoint every minute and sync every 5 minutes. |
| `storage` | Keep totals and settings on this computer. |
| `notifications` | The heads-up when you reach 80% of a daily limit. |

No host permissions are requested. The Synapse server allows cross-origin requests on its device endpoints, which use bearer keys only, with no cookies.

## Categories

Common sites are pre-mapped (in `categories.js`) to Work, Study, Messaging & email, Social media, Video & streaming, Games or News. Everything else is Other. Change any of your top sites' categories on the settings page.

## Publishing

To distribute it beyond developer mode, zip this folder and submit it to the Chrome Web Store or Edge Add-ons. Their review requires a privacy policy; the Data section above is a good start.

## Firefox

The same extension builds for Firefox (115 or newer):

```bash
cd extension
node build.mjs          # -> dist/synapse-firefox.zip and dist/synapse-chrome.zip
```

Ready-made zips are also attached to the **extension-latest** release on GitHub (rebuilt on every push to `main`, and checked with Mozilla's `web-ext lint`).

**Try it now (until Firefox restarts):** open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick `dist/firefox/manifest.json` (or the zip).

**Install it permanently:** regular Firefox only installs add-ons signed by Mozilla. Signing is free:
1. Make an account on [addons.mozilla.org](https://addons.mozilla.org/developers/) → **Submit a New Add-on**.
2. Choose **On your own** (unlisted, not shown in the store), upload `synapse-firefox.zip`.
3. Automatic review usually takes minutes; download the signed `.xpi` and open it in Firefox.

Choose **On this site** instead to list it publicly on addons.mozilla.org (a human review may follow).

What differs from Chrome: the background runs as a classic script (bundled), options open in a tab, the "Back" button on the paused page opens a blank tab (Firefox doesn't let add-ons open its new-tab page), and the manifest declares the data it collects (`browsingActivity`: per-site minutes sent to your Synapse server).
