# Voice server (LiveKit)

Synapse voice rooms work in two modes:

| Mode | When | Good for |
|---|---|---|
| Peer-to-peer | `LIVEKIT_*` not set (default) | Up to about 6 people; nothing extra to run |
| LiveKit (SFU) | `LIVEKIT_*` set | Large rooms, flaky or strict networks |

In LiveKit mode each person uploads their voice once, and the media server forwards it to everyone else. The Synapse server only issues short-lived join tokens (2 hours, microphone-only, one room). Audio never passes through Synapse.

Use **LiveKit server 1.9 or newer**. The browser SDK Synapse ships (2.22) falls back to older servers but connects more slowly.

## Option A: LiveKit Cloud (easiest for hosting)

1. Create a project at https://cloud.livekit.io (it has a free tier).
2. Copy the project URL (`wss://<project>.livekit.cloud`), API key and API secret.
3. Put them in `backend/.env`:

   ```
   LIVEKIT_URL=wss://your-project.livekit.cloud
   LIVEKIT_API_KEY=API...
   LIVEKIT_API_SECRET=...
   ```

4. Restart Synapse. `GET /api/health` now reports `"voice":"livekit"`.

## Option B: run it locally

With Docker:

```
cd infra/livekit
docker compose up -d
```

Without Docker, download `livekit-server` for your OS from https://github.com/livekit/livekit/releases (Windows builds are included) and run:

```
livekit-server --dev
```

Then set `LIVEKIT_URL=ws://localhost:7880`, `LIVEKIT_API_KEY=devkey`, `LIVEKIT_API_SECRET=secret` and restart Synapse.

## Option C: self-host for production

Follow https://docs.livekit.io/home/self-hosting/deployment/. You'll need:

- a domain with TLS, so the URL is `wss://`;
- your own API key and secret (not the dev pair);
- open firewall ports: 443/TCP, 7881/TCP, and a UDP range (default 50000-60000);
- ideally its built-in TURN enabled for strict networks.
