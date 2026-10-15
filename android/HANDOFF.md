# Phone v2 – handoff (unfinished, branch `phone-v2`)

Done and tested:
- Backend: phone focus/session endpoints (`backend/src/sessions.js`, `devices.js`), QR connect on the Privacy page. 41/41 backend tests pass.
- Android core (pure Java, unit-tested): `MiniJson`, `PhoneLogic` (limits/alerts, timer, deep link, bedtime), `UsageAggregator.analyze` (hourly, pickups).
- Android UI helpers: `Palette`, `Ui`, `BarChartView`, `Prefs` (rewritten), resources (themes, widget layout, ic_stat).
- Written but NOT yet compiled: `Notifs`, `FocusController`, `FocusAlarmReceiver`, `SynapseWidget`.

Still to do:
1. `Sync.run`: use `UsageReader.analyze(c,7)`; fetch + `Prefs.saveLimits`; send `PhoneLogic.limitAlerts` via `Notifs.limit` (dedupe with `Prefs.sentAlerts/markSent`); bedtime nudge (`PhoneLogic.minutesSinceBedtime/shouldNudge`); refresh `api.summary()`; call `SynapseWidget.update(...)`.
2. `SyncJobService`: period 15 min.
3. Rewrite `MainActivity`: tabs Today / Week / Focus / Settings; handle `synapse://connect?server=&key=` deep link (`PhoneLogic.parseConnectLink`); request POST_NOTIFICATIONS on API 33+. The old MainActivity may not compile against the new `Prefs`.
4. `AndroidManifest.xml`: theme `@style/AppTheme`; permissions POST_NOTIFICATIONS, SCHEDULE_EXACT_ALARM; MainActivity `launchMode="singleTop"` + VIEW/BROWSABLE intent-filter scheme `synapse` host `connect`; receiver `.FocusAlarmReceiver` (exported=false); receiver `.SynapseWidget` with APPWIDGET_UPDATE + meta-data `android.appwidget.provider` -> `@xml/synapse_widget_info`.
5. Push, let CI (`android` job) compile, fix errors, then merge to `main`.
