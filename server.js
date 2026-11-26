// Strangers on Air — matchmaking + WebRTC signaling server.
// Serves the website from ./public and pairs waiting users over WebSocket.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const ROUND_SECONDS = 180;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const https = require('https');
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
const CERT_FILE = path.join(__dirname, 'certs', 'dev.pfx');

// ---------- Cloudflare Turnstile (bot check) ----------
// Without your own keys, Cloudflare's official TEST keys are used: the widget shows
// and the full flow runs, but every visitor passes. Put real keys in config.json.
const TEST_SITE_KEY = '1x00000000000000000000AA';
const TEST_SECRET = '1x0000000000000000000000000000000AA';
let fileConfig = {};
try { fileConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch {}
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || fileConfig.turnstileSiteKey || TEST_SITE_KEY;
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || fileConfig.turnstileSecret || TEST_SECRET;
const USING_TEST_KEYS = TURNSTILE_SECRET === TEST_SECRET;

async function verifyTurnstile(token, ip) {
  if (!token || typeof token !== 'string' || token.length > 2048) return false;
  try {
    const body = new URLSearchParams({ secret: TURNSTILE_SECRET, response: token });
    if (ip) body.set('remoteip', ip);
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    const data = await r.json();
    if (!data.success) console.log('turnstile rejected:', (data['error-codes'] || []).join(', '));
    return data.success === true;
  } catch (e) {
    console.log('turnstile check failed:', e.message);
    return false;
  }
}

// Real visitor IP: behind the cloudflared tunnel requests arrive from localhost,
// and Cloudflare puts the visitor's address in CF-Connecting-IP.
// On Render, its proxy puts the visitor's address first in X-Forwarded-For.
function clientIp(req) {
  const sock = (req.socket.remoteAddress || '').replace('::ffff:', '');
  if (process.env.RENDER) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return fwd || sock;
  }
  const local = sock === '127.0.0.1' || sock === '::1';
  return (local && req.headers['cf-connecting-ip']) || sock;
}

// ---------- rate limits ----------
const MAX_SOCKETS_PER_IP = 5;      // open tabs per visitor
const MAX_ACTIONS_PER_MIN = 40;    // find/next/report/chat per connection
const socketsPerIp = new Map();

// ---------- static files ----------
const server = http.createServer(serveStatic);
function serveStatic(req, res) {
  const ip = clientIp(req);
  if (ip !== '127.0.0.1' && ip !== '::1') console.log(`visit from ${ip}: ${req.url}`);
  if (req.url === '/config') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ turnstileSiteKey: TURNSTILE_SITE_KEY }));
  }
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------- data ----------
const ADJ = ['Blue', 'Quiet', 'Lucky', 'Sleepy', 'Brave', 'Fuzzy', 'Cosmic', 'Mellow', 'Swift', 'Sunny', 'Misty', 'Jolly', 'Velvet', 'Neon', 'Wild'];
const ANIMAL = ['Otter', 'Falcon', 'Panda', 'Fox', 'Koala', 'Lynx', 'Heron', 'Gecko', 'Moose', 'Owl', 'Walrus', 'Badger', 'Dolphin', 'Yak', 'Raven'];
const TOPICS = [
  "What's the worst food you've ever eaten?",
  'If you could live in any city for a year, where?',
  "What's a skill you'd learn instantly if you could?",
  'Best concert or live event you ever went to?',
  'What song is stuck in your head lately?',
  "What's something small that made you happy this week?",
  'Cats, dogs, or neither — defend your answer.',
  "What's the most useless talent you have?",
  "If your life had a theme song, what would it be?",
  "What's a movie everyone loves that you don't?",
  'Describe your perfect lazy day.',
  "What's the strangest job you've had or heard of?",
  'Would you rather explore space or the deep ocean?',
  "What's a hobby you got into and then dropped?",
  "What's the best advice you've ever received?",
];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const nickname = () => pick(ADJ) + pick(ANIMAL) + Math.floor(10 + Math.random() * 90);

let nextId = 1;
const clients = new Map(); // id -> client
const waiting = [];        // client ids waiting for a match

function send(c, msg) {
  if (c && c.ws.readyState === 1) c.ws.send(JSON.stringify(msg));
}

function removeFromQueue(c) {
  const i = waiting.indexOf(c.id);
  if (i !== -1) waiting.splice(i, 1);
}

function compatible(a, b) {
  if (a.id === b.id) return false;
  if (a.blocked.has(b.id) || b.blocked.has(a.id)) return false;
  if (a.lang !== b.lang && a.lang !== 'any' && b.lang !== 'any') return false;
  return a.interest === b.interest || a.interest === 'any' || b.interest === 'any';
}

function tryMatch(c) {
  // Prefer the partner who has been waiting the longest.
  for (const otherId of waiting) {
    const o = clients.get(otherId);
    if (!o || o.partner) continue;
    if (!compatible(c, o)) continue;
    // Avoid instantly re-pairing the same two people after "Next" when others are around.
    if (c.lastPartner === o.id && waiting.length > 2) continue;
    removeFromQueue(o);
    pair(c, o);
    return true;
  }
  return false;
}

function pair(a, b) {
  a.partner = b.id; b.partner = a.id;
  a.lastPartner = b.id; b.lastPartner = a.id;
  a.extend = false; b.extend = false;
  a.friend = false; b.friend = false;
  const topic = pick(TOPICS);
  const sharedInterest = a.interest !== 'any' ? a.interest : b.interest;
  send(a, { type: 'matched', role: 'caller', partner: b.nick, topic, interest: sharedInterest, seconds: ROUND_SECONDS });
  send(b, { type: 'matched', role: 'callee', partner: a.nick, topic, interest: sharedInterest, seconds: ROUND_SECONDS });
  console.log(`matched ${a.nick} <-> ${b.nick}`);
}

function enqueue(c) {
  if (c.partner) return;
  removeFromQueue(c);
  if (!tryMatch(c)) {
    waiting.push(c.id);
    send(c, { type: 'waiting' });
  }
}

function endCall(c, reason) {
  const p = clients.get(c.partner);
  c.partner = null;
  if (p && p.partner === c.id) {
    p.partner = null;
    send(p, { type: 'partner-left', reason });
  }
}

function broadcastStats() {
  const msg = { type: 'stats', online: clients.size, waiting: waiting.length };
  for (const c of clients.values()) send(c, msg);
}

// ---------- websocket ----------
// Phones only allow the microphone over HTTPS, so also serve HTTPS on the
// local network when a dev certificate exists (certs/dev.pfx).
const servers = [server];
let httpsServer = null;
if (fs.existsSync(CERT_FILE)) {
  httpsServer = https.createServer(
    { pfx: fs.readFileSync(CERT_FILE), passphrase: process.env.CERT_PASS || 'strangers-dev' },
    serveStatic
  );
  servers.push(httpsServer);
}

for (const s of servers) {
  new WebSocketServer({ server: s }).on('connection', onConnection);
}

const GATED = new Set(['find', 'next', 'report', 'chat']);

function onConnection(ws, req) {
  const ip = clientIp(req);
  const open = socketsPerIp.get(ip) || 0;
  if (open >= MAX_SOCKETS_PER_IP) {
    console.log(`refused ${ip}: too many open connections`);
    ws.close(1008, 'Too many connections');
    return;
  }
  socketsPerIp.set(ip, open + 1);

  const c = {
    id: nextId++, ws, ip, nick: nickname(), interest: 'any', lang: 'any',
    partner: null, lastPartner: null, blocked: new Set(), extend: false, friend: false,
    verified: false, actions: [],
  };
  clients.set(c.id, c);
  console.log(`${c.nick} connected from ${c.ip} (${clients.size} online)`);
  send(c, { type: 'hello', nick: c.nick });
  broadcastStats();

  ws.on('message', async (raw) => {
    if (raw.length > 20000) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.type === 'verify') {
      c.verified = await verifyTurnstile(m.token, c.ip);
      send(c, { type: 'verified', ok: c.verified });
      if (c.verified) console.log(`${c.nick} passed the Cloudflare check`);
      return;
    }
    if (GATED.has(m.type)) {
      if (!c.verified) return send(c, { type: 'need-verify' });
      const now = Date.now();
      c.actions = c.actions.filter((t) => now - t < 60000);
      if (c.actions.length >= MAX_ACTIONS_PER_MIN) return send(c, { type: 'slow-down' });
      c.actions.push(now);
    }

    const p = clients.get(c.partner);

    switch (m.type) {
      case 'find':
        c.interest = String(m.interest || 'any').slice(0, 20);
        c.lang = String(m.lang || 'any').slice(0, 20);
        if (c.partner) endCall(c, 'next');
        console.log(`${c.nick} is looking (vibe: ${c.interest}, lang: ${c.lang})`);
        enqueue(c);
        break;

      case 'signal': // relay SDP offers/answers and ICE candidates
        if (p) send(p, { type: 'signal', data: m.data });
        break;

      case 'next':
        endCall(c, 'next');
        enqueue(c);
        break;

      case 'stop':
        endCall(c, 'left');
        removeFromQueue(c);
        break;

      case 'extend':
        if (!p) break;
        c.extend = true;
        if (p.extend) {
          c.extend = p.extend = false;
          send(c, { type: 'extended', seconds: ROUND_SECONDS });
          send(p, { type: 'extended', seconds: ROUND_SECONDS });
        } else {
          send(p, { type: 'extend-request' });
        }
        break;

      case 'friend':
        if (!p) break;
        c.friend = true;
        if (p.friend) {
          send(c, { type: 'friends', partner: p.nick });
          send(p, { type: 'friends', partner: c.nick });
        } else {
          send(p, { type: 'friend-request' });
        }
        break;

      case 'report':
        if (p) {
          c.blocked.add(p.id);
          console.log(`REPORT: ${c.nick} reported ${p.nick} (${String(m.reason || '').slice(0, 100)})`);
        }
        endCall(c, 'next');
        enqueue(c);
        break;

      case 'chat': // tiny text side-channel (e.g. "can't hear you")
        if (p) send(p, { type: 'chat', text: String(m.text || '').slice(0, 300) });
        break;
    }
    broadcastStats();
  });

  ws.on('close', () => {
    const n = (socketsPerIp.get(ip) || 1) - 1;
    if (n <= 0) socketsPerIp.delete(ip); else socketsPerIp.set(ip, n);
    endCall(c, 'left');
    removeFromQueue(c);
    clients.delete(c.id);
    broadcastStats();
  });
}

server.listen(PORT, () => {
  console.log(`Strangers on Air running at http://localhost:${PORT}`);
  console.log(USING_TEST_KEYS
    ? 'Cloudflare Turnstile: TEST keys (everyone passes). Add real keys to config.json.'
    : 'Cloudflare Turnstile: real keys active.');
});
if (httpsServer) {
  httpsServer.listen(HTTPS_PORT, () => {
    const nets = require('os').networkInterfaces();
    const ips = Object.values(nets).flat().filter((n) => n.family === 'IPv4' && !n.internal).map((n) => n.address);
    for (const ip of ips) console.log(`On your phone (same Wi-Fi): https://${ip}:${HTTPS_PORT}`);
  });
}
