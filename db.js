// Storage for accounts, friends, private messages, blocks and reports.
// Uses Postgres when DATABASE_URL is set (e.g. a free Neon database), otherwise a
// local JSON file (data/db.json) — fine on a laptop, but Render's free server
// forgets that file on every restart, so set DATABASE_URL there.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const newId = () => crypto.randomBytes(9).toString('base64url');
const newToken = () => crypto.randomBytes(24).toString('base64url');
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const pair = (a, b) => (a < b ? [a, b] : [b, a]);

const PROFILE_FIELDS = ['username', 'avatar', 'gender', 'country', 'interests', 'bio'];

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, username: u.username || '', avatar: u.avatar || '🙂', gender: u.gender || '',
    country: u.country || '', interests: u.interests || [], bio: u.bio || '', lastSeen: u.last_seen || 0,
  };
}

// ---------------- JSON file store ----------------
function jsonStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let d = { users: [], friends: [], messages: [], blocks: [], reports: [], seq: 1 };
  try { d = { ...d, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  let dirty = false;
  const save = () => { dirty = true; };
  setInterval(() => {
    if (!dirty) return;
    dirty = false;
    fs.writeFile(file + '.tmp', JSON.stringify(d), (err) => { if (!err) fs.rename(file + '.tmp', file, () => {}); });
  }, 1500).unref();

  const byId = (id) => d.users.find((u) => u.id === id);
  return {
    kind: 'file',
    async init() {},
    async createUser(defaults) {
      const token = newToken();
      const u = { id: newId(), token_hash: hash(token), created_at: Date.now(), last_seen: Date.now(), interests: [], ...defaults };
      d.users.push(u); save();
      return { user: publicUser(u), token };
    },
    async userByToken(token) { const h = hash(token); return publicUser(d.users.find((u) => u.token_hash === h)); },
    async users(ids) { return ids.map((id) => publicUser(byId(id))).filter(Boolean); },
    async userByName(name) {
      const n = String(name).toLowerCase();
      return publicUser(d.users.find((u) => (u.username || '').toLowerCase() === n));
    },
    async updateProfile(id, fields) {
      const u = byId(id); if (!u) return null;
      for (const k of PROFILE_FIELDS) if (k in fields) u[k] = fields[k];
      save(); return publicUser(u);
    },
    async touch(id) { const u = byId(id); if (u) { u.last_seen = Date.now(); save(); } },
    async countUsers() { return d.users.length; },

    async getFriendship(a, b) { const [x, y] = pair(a, b); return d.friends.find((f) => f.a === x && f.b === y) || null; },
    async setFriendship(a, b, status, requester) {
      const [x, y] = pair(a, b);
      let f = d.friends.find((r) => r.a === x && r.b === y);
      if (!f) { f = { a: x, b: y, created_at: Date.now() }; d.friends.push(f); }
      f.status = status; f.requester = requester; save(); return f;
    },
    async removeFriendship(a, b) { const [x, y] = pair(a, b); d.friends = d.friends.filter((f) => !(f.a === x && f.b === y)); save(); },
    async friendships(id) { return d.friends.filter((f) => f.a === id || f.b === id); },

    async addMessage(m) { const row = { id: d.seq++, ts: Date.now(), ...m }; d.messages.push(row); if (d.messages.length > 50000) d.messages.splice(0, 5000); save(); return row; },
    async conversation(a, b, limit = 50, before = Infinity) {
      return d.messages.filter((m) => ((m.sender === a && m.recipient === b) || (m.sender === b && m.recipient === a)) && m.id < before)
        .slice(-limit);
    },
    async markRead(reader, other) {
      for (const m of d.messages) if (m.recipient === reader && m.sender === other && !m.read) m.read = true;
      save();
    },
    async unreadCounts(id) {
      const out = {};
      for (const m of d.messages) if (m.recipient === id && !m.read) out[m.sender] = (out[m.sender] || 0) + 1;
      return out;
    },
    async hideMessage(id) { const m = d.messages.find((x) => x.id === id); if (m) { m.text = ''; m.image = ''; m.removed = true; save(); } },

    async block(a, b) { if (!d.blocks.some((x) => x.blocker === a && x.blocked === b)) d.blocks.push({ blocker: a, blocked: b }); save(); },
    async unblock(a, b) { d.blocks = d.blocks.filter((x) => !(x.blocker === a && x.blocked === b)); save(); },
    async blocks(id) { return d.blocks.filter((x) => x.blocker === id).map((x) => x.blocked); },
    async blockedEither(a, b) { return d.blocks.some((x) => (x.blocker === a && x.blocked === b) || (x.blocker === b && x.blocked === a)); },

    async addReport(r) { d.reports.push({ id: d.seq++, ts: Date.now(), ...r }); save(); },
    async addContact(c) { (d.contacts = d.contacts || []).push({ id: d.seq++, ts: Date.now(), ...c }); save(); },
  };
}

// ---------------- Postgres store ----------------
function pgStore(url) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false }, max: 5 });
  const q = (text, params) => pool.query(text, params);
  const rowUser = (r) => r && publicUser({ ...r, interests: r.interests || [] });
  return {
    kind: 'postgres',
    async init() {
      await q(`
        create table if not exists users (
          id text primary key, token_hash text unique not null, username text, avatar text, gender text,
          country text, interests jsonb default '[]', bio text, created_at bigint, last_seen bigint);
        create unique index if not exists users_username_lower on users (lower(username)) where username is not null and username <> '';
        create table if not exists friends (a text, b text, status text, requester text, created_at bigint, primary key (a, b));
        create table if not exists messages (id bigserial primary key, sender text, recipient text, text text, image text,
          ts bigint, read boolean default false, removed boolean default false);
        create index if not exists messages_pair on messages (sender, recipient, id);
        create table if not exists blocks (blocker text, blocked text, primary key (blocker, blocked));
        create table if not exists reports (id bigserial primary key, reporter text, reported text, reason text, context text, ts bigint);
        create table if not exists contacts (id bigserial primary key, user_id text, name text, email text, topic text, message text, ts bigint);
      `);
    },
    async createUser(defaults) {
      const token = newToken(), id = newId(), now = Date.now();
      const r = await q(`insert into users (id, token_hash, username, avatar, gender, country, interests, bio, created_at, last_seen)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) returning *`,
        [id, hash(token), defaults.username || null, defaults.avatar || null, defaults.gender || null, defaults.country || null,
          JSON.stringify(defaults.interests || []), defaults.bio || null, now]);
      return { user: rowUser(r.rows[0]), token };
    },
    async userByToken(token) { const r = await q('select * from users where token_hash=$1', [hash(token)]); return rowUser(r.rows[0]); },
    async users(ids) { if (!ids.length) return []; const r = await q('select * from users where id = any($1)', [ids]); return r.rows.map(rowUser); },
    async userByName(name) { const r = await q('select * from users where lower(username)=lower($1)', [name]); return rowUser(r.rows[0]); },
    async updateProfile(id, fields) {
      const sets = [], vals = [];
      for (const k of PROFILE_FIELDS) if (k in fields) { vals.push(k === 'interests' ? JSON.stringify(fields[k]) : fields[k]); sets.push(`${k}=$${vals.length}`); }
      if (!sets.length) return (await this.users([id]))[0];
      vals.push(id);
      const r = await q(`update users set ${sets.join(',')} where id=$${vals.length} returning *`, vals);
      return rowUser(r.rows[0]);
    },
    async touch(id) { await q('update users set last_seen=$1 where id=$2', [Date.now(), id]); },
    async countUsers() { const r = await q('select count(*)::int as n from users'); return r.rows[0].n; },

    async getFriendship(a, b) { const [x, y] = pair(a, b); const r = await q('select * from friends where a=$1 and b=$2', [x, y]); return r.rows[0] || null; },
    async setFriendship(a, b, status, requester) {
      const [x, y] = pair(a, b);
      const r = await q(`insert into friends (a,b,status,requester,created_at) values ($1,$2,$3,$4,$5)
        on conflict (a,b) do update set status=excluded.status, requester=excluded.requester returning *`, [x, y, status, requester, Date.now()]);
      return r.rows[0];
    },
    async removeFriendship(a, b) { const [x, y] = pair(a, b); await q('delete from friends where a=$1 and b=$2', [x, y]); },
    async friendships(id) { const r = await q('select * from friends where a=$1 or b=$1', [id]); return r.rows; },

    async addMessage(m) {
      const r = await q('insert into messages (sender, recipient, text, image, ts) values ($1,$2,$3,$4,$5) returning *',
        [m.sender, m.recipient, m.text || '', m.image || '', Date.now()]);
      return { ...r.rows[0], id: Number(r.rows[0].id), ts: Number(r.rows[0].ts) };
    },
    async conversation(a, b, limit = 50, before = Number.MAX_SAFE_INTEGER) {
      const r = await q(`select * from (select * from messages where ((sender=$1 and recipient=$2) or (sender=$2 and recipient=$1)) and id < $3
        order by id desc limit $4) t order by id asc`, [a, b, before, limit]);
      return r.rows.map((m) => ({ ...m, id: Number(m.id), ts: Number(m.ts) }));
    },
    async markRead(reader, other) { await q('update messages set read=true where recipient=$1 and sender=$2 and not read', [reader, other]); },
    async unreadCounts(id) {
      const r = await q('select sender, count(*)::int as n from messages where recipient=$1 and not read group by sender', [id]);
      return Object.fromEntries(r.rows.map((x) => [x.sender, x.n]));
    },
    async hideMessage(id) { await q("update messages set text='', image='', removed=true where id=$1", [id]); },

    async block(a, b) { await q('insert into blocks values ($1,$2) on conflict do nothing', [a, b]); },
    async unblock(a, b) { await q('delete from blocks where blocker=$1 and blocked=$2', [a, b]); },
    async blocks(id) { const r = await q('select blocked from blocks where blocker=$1', [id]); return r.rows.map((x) => x.blocked); },
    async blockedEither(a, b) {
      const r = await q('select 1 from blocks where (blocker=$1 and blocked=$2) or (blocker=$2 and blocked=$1) limit 1', [a, b]);
      return r.rowCount > 0;
    },

    async addReport(r) { await q('insert into reports (reporter, reported, reason, context, ts) values ($1,$2,$3,$4,$5)', [r.reporter, r.reported, r.reason, r.context, Date.now()]); },
    async addContact(c) { await q('insert into contacts (user_id, name, email, topic, message, ts) values ($1,$2,$3,$4,$5,$6)', [c.userId, c.name, c.email, c.topic, c.message, Date.now()]); },
  };
}

function createStore({ databaseUrl, dataFile }) {
  return databaseUrl ? pgStore(databaseUrl) : jsonStore(dataFile);
}

module.exports = { createStore, publicUser };
