# Synapse for Android

Measures how long each app is open on your phone and adds the daily totals to your Synapse account, next to your browser and computer time. Android 8.0 or newer.

## Install

1. On your phone, open https://github.com/Devantii/synapse-ai/releases/tag/android-latest and download **synapse-android.apk**.
2. Open the file. Android asks to allow installing from your browser or Files app; allow it for this install.
3. Open **Synapse** and tap **Allow usage access**. Find Synapse in the list and switch it on, then go back.
4. In Synapse on the web, open **Privacy → Connect Android phone** and copy the key. In the app, enter your server address (for example `https://synapse-ai-xxxx.onrender.com`) and the key, then tap **Connect**.

It syncs right away, then about every 30 minutes when the phone has internet, including after a restart.

Every push to `main` rebuilds the APK automatically (see the **Android app** job in GitHub Actions). It's a debug build signed with a development key: fine for installing directly, not for the Play Store.

## What it measures

The app reads Android's own app usage log, the same data Digital Wellbeing uses:

- **Counted:** time from when an app comes to the front until you leave it, the screen turns off, or the phone locks.
- **Split:** time is divided at midnight.
- **Capped:** one unbroken stretch counts at most 3 hours, in case Android misses a "closed" event.
- **Not counted:** home screens, the system UI and the Synapse app itself.
- **Categories:** well-known apps (Instagram, WhatsApp, YouTube…) have fixed categories; everything else uses the app's Play Store category.

Apps are reported by name. That way "Instagram" on the phone and "instagram.com" in the browser line up in Synapse, and phone time is **added** to computer time.

## Privacy

| | |
|---|---|
| **Read** | Which app was in front and for how long. |
| **Never read** | What you do inside apps, messages, notifications, photos, location, contacts. |
| **Sent** | Per-app minutes for the last 7 days, using a device key that can only upload screen time. Revoke it in Synapse > Privacy any time. |
| **Permissions** | Usage access (you grant it in Settings), internet, and "run at startup" so the 30-minute sync survives restarts. |

## Build it yourself

Open the `android` folder in Android Studio and press Run, or from a terminal:

```
cd android
./gradlew assembleDebug        # APK in app/build/outputs/apk/debug/
./gradlew testDebugUnitTest    # core logic tests
```

## Code layout

| Path | What |
|---|---|
| `core/UsageAggregator.java` | Turns usage events into minutes per app per day (pure Java, unit-tested). |
| `core/Payload.java` | Builds the upload JSON; merges apps with the same name; drops tiny amounts. |
| `core/AppCategories.java` | App → Synapse category. |
| `core/SynapseApi.java` | Device-key API client (plain `java.net`). |
| `UsageReader.java` | Reads Android's usage events and app names. |
| `SyncJobService.java` | Background sync every ~30 minutes (JobScheduler). |
| `MainActivity.java` | The single screen. |

The app has no third-party libraries. JUnit is used only for tests.

## What the app does (v2)

- **Today**: phone time vs your 7-day average, pickups, first pickup, focus streak, your daily limits as meters, top apps by category.
- **Week**: 7-day chart; tap a day to see its hour-by-hour chart, busiest hour and app list.
- **Focus**: 15/25/50-minute focus blocks and 5/10/15-minute breaks. The countdown keeps running in a notification when you leave the app; when a block starts, your connected browser extension pauses distracting sites. Finished blocks earn points and a garden tree, as on the website. "Start break" right from the done notification.
- **Settings**: connect by scanning the QR code on Synapse > Privacy > Connect Android phone (or type the address and key); limit alerts at 80%/100%; bedtime nudge; usage access.
- **Home-screen widget**: today's time, pickups and top app.
- Syncs about every 15 minutes in the background.

## v3

- **Insights tab:** your level and title, weekly review (focus, days active, screen time, sleep, top distraction, one thing for next week), the 14-day load score with early warning, personal patterns and badges.
- **Today:** daily focus goal, early warning, and your Synapse tasks (add, tick off).
- **Focus:** suggested block length, "Focus on a task" (the finished block counts towards it), and **Got distracted?** during a block.
- **Focus guard (optional, Settings):** during a focus block, opening a social, video or game app, or one with a daily limit, shows "Paused during focus" with the time left. You can go back, use the app for 2 minutes, or end the block. Needs Usage access and **Display over other apps**; it runs as a foreground service only while a focus block runs.
- **Language:** English or हिन्दी (Settings).
