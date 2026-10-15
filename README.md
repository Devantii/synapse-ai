# Synapse AI

[![CI](https://github.com/Devantii/synapse-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/Devantii/synapse-ai/actions/workflows/ci.yml)

A digital burnout prevention system: Pomodoro focus timer with restorative breaks, a growing tree garden, live focus rooms with camera video (study-together style), chat and optional voice, a supportive community feed, screen-time logging, and explainable wellbeing insights from a machine-learning model plus fuzzy logic.

One Node.js server (Express + Socket.IO, with PostgreSQL or SQLite) serves both the API and the responsive web dashboard, so there is a single URL and no separate frontend build. A browser extension and a Windows desktop tracker add automatic screen-time measurement, and an optional LiveKit server scales video/voice rooms.

```
synapse-ai/
├── extension/           Chrome/Edge extension: automatic per-website time      → extension/README.md
├── desktop-tracker/     Windows + macOS tracker: automatic per-app time (Python, stdlib) → desktop-tracker/README.md
├── android/             Android app: automatic per-app phone time (Java, no libraries) → android/README.md
├── infra/livekit/       optional media server for large video rooms             → infra/livekit/README.md
└── backend/
    ├── src/
    │   ├── server.js        Express app, security headers, static dashboard, ICE config
    │   ├── db.js            database layer: PostgreSQL (DATABASE_URL) or SQLite, one portable schema
    │   ├── auth.js          bcrypt passwords + signed JWT sessions
    │   ├── routes.js        REST API, validation, consent gates, export & deletion
    │   ├── gamification.js  points, levels, streaks, trees, milestones, daily point cap
    │   ├── analytics.js     feature extraction → logistic regression + fuzzy inference → recommendations
    │   ├── coach.js         AI coach (OpenAI-compatible) with rule-based fallback and safety reply
    │   ├── realtime.js      Socket.IO presence, room chat, focus status, WebRTC signaling
    │   ├── devices.js       device keys + upload API for the extension and desktop tracker
    │   ├── usage.js         merges overlapping screen-time sources so time counts once
    │   └── voice.js         LiveKit join tokens (or peer-to-peer fallback)
    ├── public/              dashboard (index.html, styles.css, app.js — plain ES modules)
    ├── test/run-tests.js    end-to-end API + realtime tests (39 checks, SQLite or Postgres)
    └── .env.example
```

## Setup

Requires **Node.js 20 or newer** (22 LTS recommended).

```powershell
cd backend
npm install
copy .env.example .env      # macOS/Linux: cp .env.example .env
npm start
```

Open http://localhost:3000, create an account, and pick what Synapse may save.

Other commands:

- `npm run dev` restarts the server when files change.
- `npm test` runs the end-to-end suite against a throwaway database.

The database is created automatically. Locally that's a SQLite file at `backend/data.db` (delete it to start fresh); set `DATABASE_URL` to use PostgreSQL instead (see Database below).

**Windows note:** the SQLite driver (`better-sqlite3`) ships prebuilt binaries for current Node LTS versions on Windows, macOS and Linux, so no compiler is needed. If `npm install` ever tries to compile it, you are probably on a very new or odd Node version; switch to the current LTS.

## Environment variables

Set these in `backend/.env` (see `.env.example`). Keep `.env` out of source control.

| Variable | Needed? | What it does |
|---|---|---|
| `JWT_SECRET` | **Required in production** | Signs login tokens. Use a long random string. Unset in development = random secret, so logins reset on restart. The server refuses to start with `NODE_ENV=production` and no secret. |
| `NODE_ENV` | Production | Set to `production` when hosting. |
| `PORT` | Optional | Defaults to 3000. |
| `DATABASE_URL` | Recommended when hosting | PostgreSQL connection string. When set, it's used instead of SQLite. Tables are created on first start. |
| `DATABASE_SSL` | Rarely | Set to `no-verify` only if your provider uses a self-signed certificate. |
| `DB_PATH` | Optional | SQLite file location when `DATABASE_URL` isn't set. |
| `OPENAI_API_KEY` | Optional | Enables AI-written coach replies. Without it the coach replies from your insights and says so. |
| `OPENAI_MODEL`, `OPENAI_BASE_URL` | Optional | Any OpenAI-compatible Chat Completions endpoint. |
| `ADMIN_USERNAMES` | Optional | Comma-separated usernames that can open the Admin (moderation) page. |
| `SMTP_URL`, `MAIL_FROM` | Optional | Turns on weekly email reports and address confirmation. E.g. `smtps://LOGIN:SMTP_KEY@smtp-relay.brevo.com:465` (Brevo's free plan: 300 emails/day) or Gmail with an app password: `smtps://you%40gmail.com:APP_PASSWORD@smtp.gmail.com:465`. `MAIL_FROM` like `Synapse <you@gmail.com>`. |
| `CRON_SECRET` | Optional | Lets the "Weekly email reports" GitHub workflow wake the server on Sundays and send due reports (`render.yaml` generates one; copy it into the repo secret of the same name, plus `SYNAPSE_URL`). |
| `APP_URL` | Optional | Public address used in email links. On Render it's detected automatically. |
| `GOOGLE_CLIENT_ID` | Optional | Turns on "Continue with Google" (sign up / sign in, and linking Google in Privacy). See "Sign in with Google" below. |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Optional | Run room video and voice through a LiveKit media server (large rooms, more networks). Unset = peer-to-peer. See `infra/livekit/README.md`. |
| `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` | Optional | TURN relay for peer-to-peer video/voice on strict networks. Public STUN is used by default. |
| `TRUST_PROXY` | When behind a proxy | Lets rate limiting see real client IPs. |
| `CORS_ORIGIN` | Rarely | Only if you serve the dashboard from another origin. |

## What works

Everything below is functional against the real database, not mocked.

- **Accounts:** signup and login with bcrypt-hashed passwords, 7-day signed sessions, rate-limited auth. Every query filters by the signed-in user, and the test suite checks that one user can't read or delete another's data.
- **Focus timer:** 15/25/50-minute focus blocks and 5/10/15-minute breaks. The timer survives page reloads, rolls into a break after each completed block, and plays a chime. Giving up wilts the tree but keeps partial points.
- **Guided breaks:** in break mode, the timer offers box breathing, a 5-step stretch, the 20-20-20 eye rest, or a short move checklist, and remembers your favourite.
- **Progress page:** a 6-month focus calendar heatmap, focus vs screen time by week (with a table view), your strongest focus hours, which block lengths you actually finish, and your top topics. Hover or tap anything for details.
- **Installable app:** install Synapse from the browser (desktop "Install app" button, or Add to Home Screen on phones). It opens in its own window and still loads offline. Optional notifications when a focus block or break ends while the tab is in the background.
- **Gamification:** points (completed focus = minutes + 10, breaks = 5, early stop = half), levels, day streaks, a garden where blocks of 20+ minutes plant a sapling, maple, cedar or oak, and 10 milestones. Points are capped at 400 a day so grinding is never rewarded over rest.
- **Focus rooms:** live presence (including who is mid-focus and minutes left), persisted chat with flood control, and a study-together video call: "Join with camera" shows everyone on camera in a grid, mics start off (quiet room) and can be switched on, and you can join without a camera to just watch. Camera and mic are requested only when you click. Without LiveKit, video and audio go peer to peer (up to 6 people on the call) and the server only relays signaling; nothing is recorded. With LiveKit configured, rooms scale to many people; Synapse only issues 2-hour camera + microphone join tokens (no screen share). Rooms also have a **group timer** (anyone starts a shared focus block or break; everyone sees the countdown and can "Focus along", which syncs their own timer) and threaded **chat replies**.
- **Today's tasks and daily goal:** a short task list (open tasks carry over to the next day); "Focus" on a task starts a block tagged with it, and completed blocks fill the task's estimate dots. A daily focus goal (30 min to 6 h) shows progress on Today.
- **Ambient sounds:** rain, waves, wind and brown noise, generated live in the browser with the Web Audio API (no audio files, nothing downloaded), on Today and in rooms.
- **Weekly leaderboard:** opt-in only (Rooms page, "Show me"); ranks completed focus time since Monday by display name. Sample data never counts.
- **Burnout early warning:** the load score is recomputed for each of the last 14 days and drawn as a trend with balanced / strained / at-risk bands. A warning appears on Today and Insights when it rises 3 days running, jumps 15+ points on last week, or passes 70.
- **Personal patterns:** compares your own days over 60 days (sleep 7h+ vs less, high vs low stress, heavy vs light scrolling, distraction-heavy days, best start hour, short vs long blocks, strongest weekday). A finding is shown only with enough days on both sides, says what it is based on, and is framed as a pattern, not a cause.
- **Distraction log:** "Got distracted?" during a focus block logs what pulled you away (phone, messages, thoughts…) without stopping the timer; Insights shows the top distractions and peak hour.
- **Smart block length:** Today suggests 15, 25 or 50 minutes from the blocks you actually finish at this time of day, today's energy/stress check-in and how late it is, with the reason.
- **Accountability buddies:** add someone by username; once they accept you see each other's focus time today vs goal and streak (nothing else), and can send a cheer or a nudge, delivered live (rate-limited).
- **Weekly review:** Progress opens with this week vs last (focus, active days, screen time, tasks done, best day, sleep, top distraction) and one concrete focus for next week.
- **Weekly email report:** confirm an address in Privacy, turn the report on, and every Sunday around 6 pm (your time zone) you get focus hours, a day-by-day screen-time and focus chart, and one suggestion. Preview it any time; every email has a one-click unsubscribe. Needs `SMTP_URL`. Free Render servers sleep, so the included GitHub workflow wakes the server on Sundays (set the `SYNAPSE_URL` and `CRON_SECRET` repo secrets); the server also checks every 10 minutes while awake.
- **Community safety:** a "⋯" menu on every post, reply and room message to **report** (spam, harassment, hate, self-harm risk, sexual, other), **hide** a post just for you, or **block** the person (their posts, replies and chat disappear for you, buddy links end, they can't request you, and they aren't told; works for anonymous posters without revealing them). Content with 3 open reports is hidden from everyone but its author until an admin decides. Admins (`ADMIN_USERNAMES`) get a Moderation page: self-harm reports first, then by report count, with Keep / Remove / Remove-and-suspend; suspended accounts can still use their own timer and data but can't post, reply, chat or cheer.
- **Firefox extension:** `node extension/build.mjs` builds Chrome and Firefox versions from the same code (see `extension/README.md`).
- **Community replies** under each check-in, and **sample data** ("Try with sample data" on Insights/Progress) to explore the ML insights before you have your own history.
- **Community:** mood-tagged check-ins, Cheer / Hug / Same-here reactions, live "new check-ins" notice, delete your own posts, and an option to post anonymously.
- **Screen time:** enter daily totals per app or site with categories, edit any day in the last 90, delete entries, and see a 14-day stacked chart. The dashboard also measures its own foreground time (only while the tab is visible and focused).
- **Daily limits:** set minutes per app or site on the Screen time page; progress counts all sources. With the extension, you get a notification at 80% and the site pauses at 100% until midnight, with a 5-minute escape hatch.
- **Focus mode site pausing:** while a focus block runs, the extension pauses distracting sites (social, video, games by default) with a 5-minute escape hatch, and reopens them when the block ends.
- **Automatic tracking:** the browser extension measures per-site time, the desktop tracker (Windows and Mac) measures per-app time, and the Android app measures per-app phone time. Phone time adds to computer time. All count only while you're active. Each connects with a revocable device key created in Privacy; a key can only upload screen time, never read data. Each row shows where it came from. When the same app arrives from several sources, the computer trackers count once among themselves, phone time adds to that, and a typed-in total only counts if it's larger than everything tracked.
- **Wellbeing insights:** 10 features from the last 7 days (screen hours, leisure share, late-night sessions, break ratio, focus hours, abandon rate, week-over-week trend, and optional private stress, energy and sleep check-ins) feed two models:
  - a logistic-regression model whose per-feature contributions are shown as bars ("raises" or "lowers" your score, with your value against a typical one);
  - a Mamdani fuzzy inference system whose fired rules and strengths are listed.
  The final 0-100 load score averages both, with a confidence level based on how many days have data. Each recommendation states the measured pattern that triggered it.
- **AI coach:** chat grounded in your insight summary. Uses an LLM when configured, otherwise a labelled rule-based reply. Messages mentioning self-harm get a safety response with helpline information instead of coaching.
- **Privacy:** a Connected trackers panel to create and revoke device keys, four separate consents (focus activity, screen time, insights, community name), an append-only consent history, JSON export of everything stored, scoped deletion (activity, screen time, check-ins, community) and full account deletion with password confirmation.

## Automatic tracking: what's covered

| Want | Status |
|---|---|
| Time per website (Chrome, Edge, Brave) | **Built:** `extension/`. Load unpacked in developer mode, or publish to the Chrome Web Store / Edge Add-ons. |
| Time per desktop app on Windows and macOS | **Built:** `desktop-tracker/`. Python standard library; can be packaged as an .exe on Windows. |
| Android app usage | **Built:** `android/`. Uses Usage Access; CI builds the APK and publishes it at `/releases/tag/android-latest`. |
| Video/voice for big groups or strict networks | **Built:** set `LIVEKIT_*` (LiveKit Cloud or self-hosted). |
| Firefox / Safari | Not built. Firefox would need small manifest changes; Safari needs an Xcode-wrapped extension. |
| Linux desktop apps | Not built. The tracker's logic is portable; it would need an X11/Wayland foreground and idle layer. |
| iPhone app usage | Not possible for ordinary apps. Apple's Screen Time API needs a special entitlement and doesn't export per-app numbers. Users keep entering phone totals by hand. |

All trackers use the same upload endpoint, so any new one only needs a device key and this call:

```
PUT /api/device/usage
Authorization: Bearer syn_...
{ "days": [ { "day": "2026-10-15", "entries": [ { "app": "VS Code", "category": "work", "minutes": 95.5 } ] } ] }
```

Each upload replaces that device type's earlier totals for those days, so re-sending is safe. `GET /api/device/ping` checks a key.

## Continuous integration

Every push runs `.github/workflows/ci.yml`:
- the backend suite on SQLite and on PostgreSQL 16, with Node 20, 22 and 24;
- the desktop tracker tests (Windows and macOS logic);
- the Android unit tests and APK build (APK published on pushes to `main`);
- a syntax check of the dashboard and extension scripts.

## About the "AI" claims

The ML model is trained when the server starts, on 4,000 synthetic profiles labelled by a scoring function built from common burnout-risk heuristics (long screen hours, few breaks, late sessions, short sleep, high stress). It fits that labelling with about 75% accuracy. That makes it a consistent, explainable coaching heuristic. It is not trained on clinical data and must not be presented as a validated burnout or mental-health assessment; the dashboard says so wherever scores appear. With real, consented outcome data you could retrain it in `analytics.js` (`trainModel`).

## Database

| | When | Notes |
|---|---|---|
| SQLite | `DATABASE_URL` not set (default) | Zero setup; perfect for running on your own computer. |
| PostgreSQL | `DATABASE_URL` set | For hosting: data survives restarts and redeploys. Any Postgres 12+ works. |

**Free hosted Postgres that doesn't expire: Neon**
1. Sign up at https://neon.com (no card) and create a project.
2. Copy the connection string; it looks like `postgresql://user:pass@ep-xxx.aws.neon.tech/neondb?sslmode=require`.
3. Set it as `DATABASE_URL`, either in `backend/.env` or on Render under the service's **Environment** tab. If you deployed with the blueprint, also delete the `synapse-db` database there, since a manually set value replaces the linked one.

Tests: `npm test` uses a temporary SQLite file. `TEST_DATABASE_URL=postgres://... npm test` runs the same 38 checks against Postgres. That database is wiped, and `DATABASE_URL` is never used by tests.

## Deploy (one click, Render)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Devantii/synapse-ai)

`render.yaml` sets everything up: the web service, a free PostgreSQL database wired in as `DATABASE_URL`, Node 22, production mode, a generated `JWT_SECRET`, and the health check. After it deploys, add `OPENAI_API_KEY` or the `LIVEKIT_*` variables under the service's **Environment** tab if you want them.

Free plan limits:
- **Database expiry:** Render's free Postgres expires after 30 days (14-day grace to upgrade). Switch to Neon (above) for a free database that lasts.
- **Sleeping:** the free web service sleeps after about 15 idle minutes and takes 30-60 seconds to wake.

## Hosting

Any Node host with a persistent disk works (Render, Railway, Fly.io, a VPS). Set `NODE_ENV=production`, `JWT_SECRET`, `DB_PATH` on the persistent disk, and `TRUST_PROXY=1` behind a proxy. Serve over HTTPS: browsers only allow microphone access on HTTPS or `localhost`. With PostgreSQL you can run several instances; add the Socket.IO Redis adapter so rooms work across them.

## Sign in with Google

1. Open [Google Cloud Console](https://console.cloud.google.com/) → create (or pick) a project.
2. **APIs & Services → OAuth consent screen**: choose *External*, fill in the app name (Synapse AI) and your email, save. While it's in *Testing*, add the Google accounts that may sign in under *Test users*, or click *Publish app* so anyone can.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID** → *Web application*.
   Under **Authorized JavaScript origins** add your site, e.g. `https://synapse-ai-xxxx.onrender.com` (and `http://localhost:3000` for local use). No redirect URI is needed.
4. Copy the **Client ID** (ends in `.apps.googleusercontent.com`) and set it as `GOOGLE_CLIENT_ID` (Render → synapse-ai → Environment). Redeploy.

The "Continue with Google" button then appears on the sign-in screen. First use creates an account (username from the email, display name from Google); existing users can link Google under Privacy → Sign-in methods. The server verifies Google's signed ID token (signature, expiry, audience) with Google's official library and stores only the Google account id and verified email. No client secret is needed.
