// Strangers on Air — server.
// Serves the website from ./public and, over WebSocket, handles: accounts, random
// voice/text matching with filters, WebRTC call setup, friends, private messages,
// direct friend calls, mini-game relay, blocking, reports and moderation.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { createStore } = require('./db');
const mod = require('./moderation');

const PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CERT_FILE = path.join(__dirname, 'certs', 'dev.pfx');
const ROUND_SECONDS = 180;

let fileConfig = {};
try { fileConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch {}
const cfg = (envName, fileName) => process.env[envName] || fileConfig[fileName];

const db = createStore({ databaseUrl: cfg('DATABASE_URL', 'databaseUrl'), dataFile: path.join(__dirname, 'data', 'db.json') });

// ---------- Cloudflare Turnstile (bot check) ----------
// Without your own keys, Cloudflare's official TEST keys are used (everyone passes).
const TEST_SITE_KEY = '1x00000000000000000000AA';
const TEST_SECRET = '1x0000000000000000000000000000000AA';
const TURNSTILE_SITE_KEY = cfg('TURNSTILE_SITE_KEY', 'turnstileSiteKey') || TEST_SITE_KEY;
const TURNSTILE_SECRET = cfg('TURNSTILE_SECRET', 'turnstileSecret') || TEST_SECRET;

async function verifyTurnstile(token, ip) {
  if (!token || typeof token !== 'string' || token.length > 2048) return false;
  try {
    const body = new URLSearchParams({ secret: TURNSTILE_SECRET, response: token });
    if (ip) body.set('remoteip', ip);
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    const data = await r.json();
    return data.success === true;
  } catch (e) {
    console.log('turnstile check failed:', e.message);
    return false;
  }
}

// ---------- call relay (TURN) ----------
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const TURN_URL = cfg('TURN_URL', 'turnUrl');
if (TURN_URL) {
  ICE_SERVERS.push({
    urls: TURN_URL.split(',').map((s) => s.trim()),
    username: cfg('TURN_USERNAME', 'turnUsername') || '',
    credential: cfg('TURN_CREDENTIAL', 'turnCredential') || '',
  });
}

function clientIp(req) {
  const sock = (req.socket.remoteAddress || '').replace('::ffff:', '');
  if (process.env.RENDER) return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || sock;
  const local = sock === '127.0.0.1' || sock === '::1';
  return (local && req.headers['cf-connecting-ip']) || sock;
}

// ---------- static files ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.json': 'application/json',
};
let memberCount = 0;

function serveStatic(req, res) {
  if (req.url === '/config') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ turnstileSiteKey: TURNSTILE_SITE_KEY, iceServers: ICE_SERVERS, aiModeration: mod.aiEnabled }));
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

// ---------- static data ----------
const ADJ = ['Blue', 'Quiet', 'Lucky', 'Sleepy', 'Brave', 'Fuzzy', 'Cosmic', 'Mellow', 'Swift', 'Sunny', 'Misty', 'Jolly', 'Velvet', 'Neon', 'Wild'];
const ANIMAL = ['Otter', 'Falcon', 'Panda', 'Fox', 'Koala', 'Lynx', 'Heron', 'Gecko', 'Moose', 'Owl', 'Walrus', 'Badger', 'Dolphin', 'Yak', 'Raven'];
const AVATARS = ['🦦', '🦊', '🐼', '🦉', '🐬', '🦁', '🐢', '🐙', '🦄', '🐧', '🐨', '🐸', '🐯', '🦋', '🐳'];
const TOPICS = [
  "What's the worst food you've ever eaten?", 'If you could live in any city for a year, where?',
  "What's a skill you'd learn instantly if you could?", 'Best concert or live event you ever went to?',
  'What song is stuck in your head lately?', "What's something small that made you happy this week?",
  'Cats, dogs, or neither — defend your answer.', "What's the most useless talent you have?",
  'If your life had a theme song, what would it be?', "What's a movie everyone loves that you don't?",
  'Describe your perfect lazy day.', 'Would you rather explore space or the deep ocean?',
  "What's the best advice you've ever received?", "What's a hobby you got into and then dropped?",
];
const INTERESTS = new Set(['chill', 'funny', 'deep', 'music', 'gaming', 'study', 'english', 'sports', 'movies', 'tech', 'travel', 'art', 'food', 'books']);
const GENDERS = new Set(['', 'male', 'female', 'other']);
const REACTIONS = new Set(['👋', '😂', '❤️', '🔥', '👏', '😮']);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const nickname = () => pick(ADJ) + pick(ANIMAL) + Math.floor(10 + Math.random() * 90);
const isCountry = (c) => typeof c === 'string' && /^[A-Z]{2}$/.test(c);
const countryList = (a) => (Array.isArray(a) ? a.filter(isCountry).slice(0, 50) : []);

// ---------- state ----------
let nextConnId = 1, msgSeq = 1, callSeq = 1;
const clients = new Map();           // connId -> client
const online = new Map();            // userId -> Set(connId)
const queues = { voice: [], text: [] };
const recent = new Map();            // userId -> [{userId, nick, avatar, ts}]
const bans = new Map();              // userId -> until (ms)
const calls = new Map();             // callId -> {from, toUser, timer}
const socketsPerIp = new Map();
const MAX_SOCKETS_PER_IP = 6;
const MAX_ACTIONS_PER_MIN = 60;

function send(c, msg) { if (c && c.ws.readyState === 1) c.ws.send(JSON.stringify(msg)); }
function sendUser(userId, msg) { for (const id of online.get(userId) || []) send(clients.get(id), msg); }
const displayName = (c) => (c.user && c.user.username) || c.nick;
const partnerOf = (c) => clients.get(c.partner);

function broadcastStats() {
  const msg = { type: 'stats', online: clients.size, waiting: queues.voice.length + queues.text.length, members: memberCount };
  for (const c of clients.values()) send(c, msg);
}
let statsTimer = null;
const statsSoon = () => { if (!statsTimer) statsTimer = setTimeout(() => { statsTimer = null; broadcastStats(); }, 400); };

// ---------- matching ----------
function removeFromQueues(c) {
  for (const q of Object.values(queues)) { const i = q.indexOf(c.id); if (i !== -1) q.splice(i, 1); }
}
function shared(a, b) {
  const s = new Set(a.prefs.interests);
  return b.prefs.interests.filter((x) => s.has(x));
}
function wants(a, b) {
  const p = a.prefs, u = b.user;
  if (p.genderPref !== 'any' && u.gender !== p.genderPref) return false;
  if (p.countries.length && !p.countries.includes(u.country)) return false;
  if (u.country && p.exclude.includes(u.country)) return false;
  if (p.similarOnly && !shared(a, b).length) return false;
  return true;
}
function compatible(a, b) {
  if (a.id === b.id || a.user.id === b.user.id) return false;
  if (a.blocks.has(b.user.id) || b.blocks.has(a.user.id)) return false;
  if (a.sessionBlocks.has(b.user.id) || b.sessionBlocks.has(a.user.id)) return false;
  if (a.prefs.lang !== b.prefs.lang && a.prefs.lang !== 'any' && b.prefs.lang !== 'any') return false;
  return wants(a, b) && wants(b, a);
}
function tryMatch(c) {
  const q = queues[c.mode];
  let best = null, bestScore = -1;
  for (const otherId of q) {
    const o = clients.get(otherId);
    if (!o || o.partner || !compatible(c, o)) continue;
    if (c.lastPartner === o.user.id && q.length > 2) continue;
    const score = shared(c, o).length;
    if (score > bestScore) { best = o; bestScore = score; }
  }
  if (!best) return false;
  removeFromQueues(best);
  startSession(c, best, { kind: 'random', mode: c.mode });
  return true;
}
function enqueue(c) {
  if (c.partner) return;
  removeFromQueues(c);
  if (!tryMatch(c)) { queues[c.mode].push(c.id); send(c, { type: 'waiting', mode: c.mode }); }
}
function partnerInfo(c) {
  return { nick: displayName(c), userId: c.user.id, avatar: c.user.avatar, country: c.user.country, interests: c.prefs.interests, username: c.user.username };
}
function startSession(a, b, { kind, mode }) {
  a.partner = b.id; b.partner = a.id;
  for (const [x, y] of [[a, b], [b, a]]) {
    x.lastPartner = y.user.id; x.extend = false; x.friendAsk = false; x.voiceAsk = false; x.sessionMode = mode; x.sessionKind = kind;
    const list = (recent.get(x.user.id) || []).filter((r) => r.userId !== y.user.id);
    list.unshift({ userId: y.user.id, nick: displayName(y), avatar: y.user.avatar, ts: Date.now() });
    recent.set(x.user.id, list.slice(0, 20));
  }
  const topic = pick(TOPICS);
  const common = kind === 'random' ? shared(a, b) : [];
  const seconds = kind === 'random' && mode === 'voice' ? ROUND_SECONDS : 0;
  send(a, { type: 'matched', role: 'caller', partner: partnerInfo(b), topic, common, seconds, mode, kind });
  send(b, { type: 'matched', role: 'callee', partner: partnerInfo(a), topic, common, seconds, mode, kind });
  console.log(`${kind} ${mode}: ${displayName(a)} <-> ${displayName(b)}`);
  statsSoon();
}
function endSession(c, reason) {
  const p = partnerOf(c);
  c.partner = null;
  if (p && p.partner === c.id) { p.partner = null; send(p, { type: 'partner-left', reason, kind: p.sessionKind }); }
}

// ---------- friends ----------
async function friendsPayload(userId) {
  const rows = await db.friendships(userId);
  const ids = rows.map((f) => (f.a === userId ? f.b : f.a));
  const users = await db.users(ids);
  const byId = Object.fromEntries(users.map((u) => [u.id, u]));
  const list = rows.map((f) => {
    const other = f.a === userId ? f.b : f.a;
    const status = f.status === 'accepted' ? 'accepted' : f.requester === userId ? 'outgoing' : 'incoming';
    return { user: byId[other], status, online: status === 'accepted' && online.has(other) };
  }).filter((x) => x.user);
  return { type: 'friends', list, unread: await db.unreadCounts(userId) };
}
async function pushFriends(userId) { if (online.has(userId)) sendUser(userId, await friendsPayload(userId)); }
async function areFriends(a, b) { const f = await db.getFriendship(a, b); return !!f && f.status === 'accepted'; }

async function requestFriend(c, otherId) {
  if (!otherId || otherId === c.user.id) return;
  if (await db.blockedEither(c.user.id, otherId)) return send(c, { type: 'toast', key: 'cantAdd' });
  const f = await db.getFriendship(c.user.id, otherId);
  if (f && f.status === 'accepted') return send(c, { type: 'toast', key: 'alreadyFriends' });
  if (f && f.status === 'pending' && f.requester !== c.user.id) {
    await db.setFriendship(c.user.id, otherId, 'accepted', f.requester);
    sendUser(otherId, { type: 'friend-accepted', user: c.user });
    send(c, { type: 'friend-accepted', user: (await db.users([otherId]))[0] });
  } else {
    await db.setFriendship(c.user.id, otherId, 'pending', c.user.id);
    sendUser(otherId, { type: 'friend-request', user: c.user });
    send(c, { type: 'toast', key: 'requestSent' });
  }
  await pushFriends(c.user.id); await pushFriends(otherId);
}

// ---------- moderation helpers ----------
function strike(c, category) {
  c.strikes = (c.strikes || 0) + 1;
  send(c, { type: 'moderated', category, strikes: c.strikes });
  if (c.strikes >= 3) {
    bans.set(c.user.id, Date.now() + 10 * 60 * 1000);
    c.strikes = 0;
    endSession(c, 'left');
    removeFromQueues(c);
    send(c, { type: 'banned', minutes: 10 });
  }
}

// ---------- websocket ----------
const GATED = new Set(['find', 'next', 'report', 'chat', 'react', 'dm-send', 'friend-add', 'friend-request', 'call-friend', 'game', 'profile', 'voice-request', 'contact']);
const CONTACT_TOPICS = new Set(['question', 'idea', 'bug', 'safety', 'other']);

function onConnection(ws, req) {
  const ip = clientIp(req);
  const open = socketsPerIp.get(ip) || 0;
  const isLocal = ip === '127.0.0.1' || ip === '::1'; // your own computer (local testing) isn't limited
  if (!isLocal && open >= MAX_SOCKETS_PER_IP) { ws.close(1008, 'Too many connections'); return; }
  socketsPerIp.set(ip, open + 1);

  const c = {
    id: nextConnId++, ws, ip, nick: nickname(), user: null, verified: false, actions: [],
    mode: 'voice', prefs: { lang: 'any', interests: [], genderPref: 'any', countries: [], exclude: [], similarOnly: false },
    partner: null, lastPartner: null, blocks: new Set(), sessionBlocks: new Set(), strikes: 0,
  };
  clients.set(c.id, c);
  statsSoon();

  ws.on('message', async (raw) => {
    if (raw.length > 1_600_000) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    try { await handle(c, m); } catch (e) { console.log('handler error:', m && m.type, e.message); }
  });

  ws.on('close', async () => {
    const n = (socketsPerIp.get(ip) || 1) - 1;
    if (n <= 0) socketsPerIp.delete(ip); else socketsPerIp.set(ip, n);
    endSession(c, 'left');
    removeFromQueues(c);
    clients.delete(c.id);
    if (c.user) {
      const set = online.get(c.user.id);
      if (set) {
        set.delete(c.id);
        if (!set.size) {
          online.delete(c.user.id);
          db.touch(c.user.id).catch(() => {});
          notifyFriendsPresence(c.user.id, false);
        }
      }
    }
    statsSoon();
  });
}

async function notifyFriendsPresence(userId, isOnline) {
  const rows = await db.friendships(userId);
  for (const f of rows) if (f.status === 'accepted') sendUser(f.a === userId ? f.b : f.a, { type: 'presence', userId, online: isOnline });
}

async function handle(c, m) {
  // --- account ---
  if (m.type === 'auth') {
    let user = m.token ? await db.userByToken(String(m.token).slice(0, 100)) : null;
    let token = null;
    if (!user) {
      const created = await db.createUser({ avatar: pick(AVATARS) });
      user = created.user; token = created.token;
      memberCount++;
    }
    c.user = user;
    c.blocks = new Set(await db.blocks(user.id));
    if (!online.has(user.id)) { online.set(user.id, new Set()); notifyFriendsPresence(user.id, true); }
    online.get(user.id).add(c.id);
    send(c, { type: 'account', token, user, nick: c.nick, ai: mod.aiEnabled });
    send(c, await friendsPayload(user.id));
    statsSoon();
    return;
  }
  if (!c.user) return;

  if (m.type === 'verify') {
    c.verified = await verifyTurnstile(m.token, c.ip);
    return send(c, { type: 'verified', ok: c.verified });
  }
  if (GATED.has(m.type)) {
    if (!c.verified) return send(c, { type: 'need-verify' });
    const now = Date.now();
    c.actions = c.actions.filter((t) => now - t < 60000);
    if (c.actions.length >= MAX_ACTIONS_PER_MIN) return send(c, { type: 'toast', key: 'slowDown' });
    c.actions.push(now);
  }
  const p = partnerOf(c);

  switch (m.type) {
    // --- profile ---
    case 'profile': {
      const f = m.fields || {}, out = {};
      if ('username' in f) {
        const u = String(f.username || '').trim();
        if (u && !/^[A-Za-z0-9_]{3,20}$/.test(u)) return send(c, { type: 'profile-error', key: 'badUsername' });
        if (u) { const taken = await db.userByName(u); if (taken && taken.id !== c.user.id) return send(c, { type: 'profile-error', key: 'usernameTaken' }); }
        out.username = u;
      }
      if ('avatar' in f) out.avatar = String(f.avatar || '🙂').slice(0, 8);
      if ('gender' in f && GENDERS.has(f.gender)) out.gender = f.gender;
      if ('country' in f) out.country = isCountry(f.country) ? f.country : '';
      if ('interests' in f && Array.isArray(f.interests)) out.interests = f.interests.filter((x) => INTERESTS.has(x)).slice(0, 8);
      if ('bio' in f) out.bio = mod.quickFilter(String(f.bio || '').slice(0, 140)).text;
      c.user = await db.updateProfile(c.user.id, out);
      send(c, { type: 'profile-saved', user: c.user });
      pushFriendsOfUser(c.user.id);
      break;
    }

    // --- random matching ---
    case 'find': {
      const until = bans.get(c.user.id);
      if (until && until > Date.now()) return send(c, { type: 'banned', minutes: Math.ceil((until - Date.now()) / 60000) });
      const pr = m.prefs || {};
      c.mode = m.mode === 'text' ? 'text' : 'voice';
      c.prefs = {
        lang: String(pr.lang || 'any').slice(0, 10),
        interests: Array.isArray(pr.interests) ? pr.interests.filter((x) => INTERESTS.has(x)).slice(0, 8) : [],
        genderPref: ['any', 'male', 'female', 'other'].includes(pr.genderPref) ? pr.genderPref : 'any',
        countries: countryList(pr.countries),
        exclude: countryList(pr.exclude),
        similarOnly: !!pr.similarOnly,
      };
      if (c.partner) endSession(c, 'next');
      enqueue(c);
      break;
    }
    case 'next':
      endSession(c, 'next');
      enqueue(c);
      break;
    case 'stop':
      endSession(c, 'left');
      removeFromQueues(c);
      break;

    // --- in-session ---
    case 'signal':
      if (p) send(p, { type: 'signal', data: m.data });
      break;
    case 'chat': {
      if (!p) break;
      const isFriend = c.sessionKind === 'friend';
      const { text } = mod.quickFilter(m.text, { allowContacts: isFriend });
      if (!text.trim()) break;
      const id = msgSeq++, ts = Date.now();
      send(p, { type: 'chat', id, text, ts });
      send(c, { type: 'chat-sent', id, text, ts, local: m.local });
      if (!isFriend) {
        mod.checkText(text).then((v) => {
          if (v.allowed) return;
          send(p, { type: 'retract', id });
          send(c, { type: 'retracted', id, category: v.category });
          strike(c, v.category);
        });
      }
      break;
    }
    case 'typing':
      if (p) send(p, { type: 'typing' });
      break;
    case 'react':
      if (p && REACTIONS.has(m.emoji)) send(p, { type: 'react', emoji: m.emoji });
      break;
    case 'mute':
      if (p) send(p, { type: 'partner-mute', muted: !!m.muted });
      break;
    case 'game': {
      const data = m.data;
      if (p && data && JSON.stringify(data).length < 600) send(p, { type: 'game', data });
      break;
    }
    case 'extend':
      if (!p) break;
      c.extend = true;
      if (p.extend) {
        c.extend = p.extend = false;
        send(c, { type: 'extended', seconds: ROUND_SECONDS });
        send(p, { type: 'extended', seconds: ROUND_SECONDS });
      } else send(p, { type: 'extend-request' });
      break;
    case 'voice-request': // switch a text chat to a voice call (both must agree)
      if (!p || c.sessionMode !== 'text') break;
      c.voiceAsk = true;
      if (p.voiceAsk) {
        c.voiceAsk = p.voiceAsk = false;
        c.sessionMode = p.sessionMode = 'voice';
        send(c, { type: 'voice-start', role: 'caller' });
        send(p, { type: 'voice-start', role: 'callee' });
      } else send(p, { type: 'voice-request' });
      break;
    case 'friend-request':
      if (p) await requestFriend(c, p.user.id);
      break;
    case 'report': {
      const target = p ? p.user.id : String(m.userId || '');
      if (!target) break;
      c.sessionBlocks.add(target);
      await db.addReport({ reporter: c.user.id, reported: target, reason: String(m.reason || '').slice(0, 100), context: String(m.context || '').slice(0, 2000) });
      console.log(`REPORT: ${displayName(c)} reported ${target} (${m.reason})`);
      if (m.block) { await db.block(c.user.id, target); c.blocks.add(target); }
      if (p && p.user.id === target) { endSession(c, 'next'); if (c.sessionKind === 'random') enqueue(c); }
      send(c, { type: 'toast', key: 'reported' });
      break;
    }

    // --- contact form ---
    case 'contact': {
      const now = Date.now();
      if (c.lastContact && now - c.lastContact < 30000) return send(c, { type: 'toast', key: 'slowDown' });
      const message = String(m.message || '').trim().slice(0, 2000);
      if (message.length < 5) break;
      const email = String(m.email || '').trim().slice(0, 120);
      c.lastContact = now;
      await db.addContact({
        userId: c.user.id, name: String(m.name || '').trim().slice(0, 60),
        email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '',
        topic: CONTACT_TOPICS.has(m.topic) ? m.topic : 'other', message,
      });
      console.log(`CONTACT (${m.topic}) from ${displayName(c)}: ${message.slice(0, 80)}`);
      send(c, { type: 'contact-ok' });
      break;
    }

    // --- friends ---
    case 'friend-add': {
      let target = null;
      if (m.username) target = await db.userByName(String(m.username).trim());
      else if (m.userId) target = (await db.users([String(m.userId)]))[0];
      if (!target) return send(c, { type: 'toast', key: 'userNotFound' });
      await requestFriend(c, target.id);
      break;
    }
    case 'friend-respond': {
      const other = String(m.userId || '');
      const f = await db.getFriendship(c.user.id, other);
      if (!f || f.status !== 'pending' || f.requester === c.user.id) break;
      if (m.accept) {
        await db.setFriendship(c.user.id, other, 'accepted', f.requester);
        sendUser(other, { type: 'friend-accepted', user: c.user });
      } else await db.removeFriendship(c.user.id, other);
      await pushFriends(c.user.id); await pushFriends(other);
      break;
    }
    case 'friend-remove': {
      const other = String(m.userId || '');
      await db.removeFriendship(c.user.id, other);
      await pushFriends(c.user.id); await pushFriends(other);
      break;
    }
    case 'block': {
      const other = String(m.userId || '');
      if (!other || other === c.user.id) break;
      await db.block(c.user.id, other);
      await db.removeFriendship(c.user.id, other);
      for (const id of online.get(c.user.id) || []) clients.get(id).blocks.add(other);
      if (p && p.user.id === other) { endSession(c, 'next'); }
      await pushFriends(c.user.id); await pushFriends(other);
      send(c, { type: 'blocks', list: await db.users([...c.blocks]) });
      send(c, { type: 'toast', key: 'blocked' });
      break;
    }
    case 'unblock': {
      const other = String(m.userId || '');
      await db.unblock(c.user.id, other);
      for (const id of online.get(c.user.id) || []) clients.get(id).blocks.delete(other);
      send(c, { type: 'blocks', list: await db.users([...c.blocks]) });
      break;
    }
    case 'blocks':
      send(c, { type: 'blocks', list: await db.users([...c.blocks]) });
      break;
    case 'recent':
      send(c, { type: 'recent', list: recent.get(c.user.id) || [] });
      break;

    // --- private messages (friends only) ---
    case 'dm-send': {
      const to = String(m.to || '');
      if (!(await areFriends(c.user.id, to))) return send(c, { type: 'toast', key: 'friendsOnly' });
      let text = m.text ? mod.quickFilter(m.text, { allowContacts: true }).text : '';
      let image = '';
      if (m.image) {
        if (typeof m.image !== 'string' || m.image.length > 1_400_000 || !/^data:image\/(png|jpeg|webp|gif);base64,/.test(m.image)) {
          return send(c, { type: 'toast', key: 'imageTooBig' });
        }
        const v = await mod.checkImage(m.image);
        if (!v.allowed) return send(c, { type: 'toast', key: 'imageBlocked' });
        image = m.image;
      }
      if (!text.trim() && !image) break;
      const row = await db.addMessage({ sender: c.user.id, recipient: to, text, image });
      const out = { type: 'dm', message: row };
      sendUser(to, out); sendUser(c.user.id, out);
      if (text) {
        mod.checkText(text).then(async (v) => {
          if (v.allowed) return;
          await db.hideMessage(row.id);
          const r = { type: 'dm-removed', id: row.id, with: to };
          sendUser(to, { ...r, with: c.user.id }); sendUser(c.user.id, r);
        });
      }
      break;
    }
    case 'dm-history': {
      const other = String(m.with || '');
      if (!(await areFriends(c.user.id, other))) break;
      const list = await db.conversation(c.user.id, other, 50, Number(m.before) || undefined);
      send(c, { type: 'dm-history', with: other, list, more: list.length === 50 });
      break;
    }
    case 'dm-read':
      await db.markRead(c.user.id, String(m.with || ''));
      break;
    case 'dm-typing':
      if (await areFriends(c.user.id, String(m.to || ''))) sendUser(String(m.to), { type: 'dm-typing', from: c.user.id });
      break;

    // --- direct friend calls ---
    case 'call-friend': {
      const to = String(m.userId || '');
      if (!(await areFriends(c.user.id, to))) return send(c, { type: 'toast', key: 'friendsOnly' });
      if (!online.has(to)) return send(c, { type: 'toast', key: 'friendOffline' });
      const callId = callSeq++;
      const timer = setTimeout(() => {
        calls.delete(callId);
        send(c, { type: 'call-ended', callId, reason: 'no-answer' });
        sendUser(to, { type: 'call-ended', callId, reason: 'missed', from: c.user });
      }, 30000);
      calls.set(callId, { from: c.id, toUser: to, timer, mode: m.mode === 'text' ? 'text' : 'voice' });
      sendUser(to, { type: 'incoming-call', callId, from: c.user, mode: m.mode === 'text' ? 'text' : 'voice' });
      send(c, { type: 'calling', callId, to });
      break;
    }
    case 'call-answer': {
      const call = calls.get(Number(m.callId));
      if (!call || call.toUser !== c.user.id) break;
      clearTimeout(call.timer);
      calls.delete(Number(m.callId));
      const caller = clients.get(call.from);
      for (const id of online.get(c.user.id) || []) if (id !== c.id) send(clients.get(id), { type: 'call-ended', callId: m.callId, reason: 'answered-elsewhere' });
      if (!caller) return send(c, { type: 'call-ended', callId: m.callId, reason: 'cancelled' });
      if (!m.accept) return send(caller, { type: 'call-ended', callId: m.callId, reason: 'declined' });
      for (const x of [c, caller]) { endSession(x, 'left'); removeFromQueues(x); }
      startSession(caller, c, { kind: 'friend', mode: call.mode });
      break;
    }
    case 'call-cancel': {
      const call = calls.get(Number(m.callId));
      if (!call || call.from !== c.id) break;
      clearTimeout(call.timer); calls.delete(Number(m.callId));
      sendUser(call.toUser, { type: 'call-ended', callId: m.callId, reason: 'cancelled', from: c.user });
      break;
    }
  }
  if (['find', 'next', 'stop'].includes(m.type)) statsSoon();
}

async function pushFriendsOfUser(userId) {
  const rows = await db.friendships(userId);
  for (const f of rows) pushFriends(f.a === userId ? f.b : f.a);
}

// ---------- start ----------
const server = http.createServer(serveStatic);
const servers = [server];
let httpsServer = null;
if (fs.existsSync(CERT_FILE)) {
  httpsServer = https.createServer({ pfx: fs.readFileSync(CERT_FILE), passphrase: process.env.CERT_PASS || 'strangers-dev' }, serveStatic);
  servers.push(httpsServer);
}
for (const s of servers) new WebSocketServer({ server: s, maxPayload: 1_700_000 }).on('connection', onConnection);

(async () => {
  try {
    await db.init();
    memberCount = await db.countUsers();
  } catch (e) {
    console.error('Database failed to start:', e.message);
    process.exit(1);
  }
  server.listen(PORT, () => {
    console.log(`Strangers on Air running at http://localhost:${PORT}`);
    console.log(`Storage: ${db.kind === 'postgres' ? 'Postgres database' : 'local file data/db.json (set DATABASE_URL for a real database)'} · ${memberCount} members`);
    console.log(`AI moderation: ${mod.aiEnabled ? `on (${mod.MODEL})` : 'off — set ANTHROPIC_API_KEY to turn it on (word filter is always on)'}`);
    console.log(TURNSTILE_SECRET === TEST_SECRET ? 'Cloudflare Turnstile: TEST keys (everyone passes).' : 'Cloudflare Turnstile: real keys active.');
  });
  if (httpsServer) {
    httpsServer.listen(HTTPS_PORT, () => {
      const nets = require('os').networkInterfaces();
      const ips = Object.values(nets).flat().filter((n) => n.family === 'IPv4' && !n.internal).map((n) => n.address);
      for (const ip of ips) console.log(`On your phone (same Wi-Fi): https://${ip}:${HTTPS_PORT}`);
    });
  }
})();
