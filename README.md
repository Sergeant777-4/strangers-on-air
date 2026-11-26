# Strangers on Air

Random 3-minute voice calls with strangers. Voice only, anonymous nicknames.

## Run it

```
npm install
npm start
```

Open http://localhost:3000 in two tabs (or two browsers) and press **Talk** in both.

Testing alone without a mic: open `http://localhost:3000/?fake=1`. That tab sends a beeping tone instead of your microphone.

## Public link (anyone on the internet)

With the server running, in a second window:

```
.\tools\cloudflared.exe tunnel --url http://localhost:3000
```

It prints a `https://….trycloudflare.com` link. The link changes every time you restart cloudflared, and it only works while your laptop, the server and cloudflared are all running.

## Cloudflare protection

- **Turnstile bot check:** visitors must pass a Cloudflare check before **Talk** unlocks. The server confirms every check with Cloudflare, so a bot can't skip it by editing the page.
- **Rate limits:** at most 5 open tabs per visitor and 40 searches/skips/reports/chats per minute.

Out of the box it uses Cloudflare's **test keys**, which let everyone pass. To turn on real protection:

1. Sign in at dash.cloudflare.com (a free account works), open **Turnstile**, then **Add widget**.
2. Add the hostname you'll use (for example `trycloudflare.com`, or your own domain), and choose **Managed** mode.
3. Copy `config.example.json` to `config.json` and paste in the **site key** and **secret key**.
4. Restart the server. It should print `Cloudflare Turnstile: real keys active.`

Keep `config.json` private: the secret key must never be shared or uploaded.

## How it works

- `server.js`: serves `public/`, keeps a queue of waiting users, pairs them by vibe and language, and relays WebRTC setup messages over WebSocket. It also handles +3 min (both must agree), Friend (both must agree), Report (skips and blocks that pair) and a small text chat.
- `public/app.js`: microphone, WebRTC call, timer, icebreakers, UI.

## Before putting it online

- Browsers only allow the microphone on `https://` (or `localhost`), so other devices need HTTPS hosting.
- Add a TURN server (for example coturn) so calls work behind strict networks. If calls are forced through TURN (`iceTransportPolicy: 'relay'`), users' IP addresses stay hidden from each other. Right now calls are direct, so the other person's browser can see your IP.
- Reports are only printed to the server console for now. Real moderation (stored reports, bans, rate limits) is needed before strangers use it.
