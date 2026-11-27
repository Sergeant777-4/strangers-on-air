// Strangers on Air — client.
const $ = (id) => document.getElementById(id);
const t = (k, v) => window.I18N.t(k, v);
const params = new URLSearchParams(location.search);
const FAKE_MIC = params.has('fake'); // ?fake=1 sends a test tone instead of the mic (testing)
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ================= data =================
const INTERESTS = [
  ['chill', '😌 Chill'], ['funny', '😂 Funny'], ['deep', '🌌 Deep talk'], ['music', '🎵 Music'], ['gaming', '🎮 Gaming'],
  ['study', '📚 Study'], ['english', '🗣️ English practice'], ['sports', '⚽ Sports'], ['movies', '🎬 Movies'], ['tech', '💻 Tech'],
  ['travel', '✈️ Travel'], ['art', '🎨 Art'], ['food', '🍜 Food'], ['books', '📖 Books'],
];
const LANGS = ['any', 'en', 'ar', 'fr', 'es', 'de', 'tr', 'pt', 'ru', 'it', 'hi', 'ur', 'id', 'ja', 'ko', 'zh', 'fa', 'nl', 'pl', 'sw'];
const COUNTRIES = ['US', 'GB', 'CA', 'AU', 'IE', 'NZ', 'FR', 'DE', 'ES', 'IT', 'PT', 'NL', 'BE', 'CH', 'AT', 'SE', 'NO', 'DK', 'FI', 'PL',
  'CZ', 'RO', 'GR', 'TR', 'CY', 'RU', 'UA', 'MA', 'DZ', 'TN', 'EG', 'LY', 'SA', 'AE', 'QA', 'KW', 'BH', 'OM', 'JO', 'LB', 'IQ', 'SY', 'PS',
  'IL', 'IR', 'PK', 'IN', 'BD', 'LK', 'NP', 'CN', 'JP', 'KR', 'TW', 'HK', 'SG', 'MY', 'ID', 'PH', 'TH', 'VN', 'NG', 'GH', 'KE', 'ET', 'ZA',
  'SN', 'CI', 'CM', 'TZ', 'UG', 'BR', 'AR', 'MX', 'CO', 'CL', 'PE', 'VE', 'EC', 'CU', 'DO'];
const AVATARS = ['🦦', '🦊', '🐼', '🦉', '🐬', '🦁', '🐢', '🐙', '🦄', '🐧', '🐨', '🐸', '🐯', '🦋', '🐳', '🐻', '🐰', '🐵', '🦕', '🌵', '🌻', '🍉', '🚀', '⭐', '🎧', '👽', '🤖', '👻', '😎', '🙂'];
const EMOJI = '😀 😂 🤣 😊 😍 🥰 😘 😎 🤔 🙄 😅 😭 😡 🥺 😴 🤯 🥳 😇 🤗 🤫 😬 🙃 😉 😋 👍 👎 👏 🙌 🙏 💪 👋 🤝 ❤️ 🧡 💛 💚 💙 💜 🔥 ✨ 🎉 💯 ✅ ❌ ⭐ 🌙 ☀️ 🌈 🍕 🍔 ☕ 🎵 🎮 ⚽ 📚 ✈️ 🐶 🐱'.split(' ');
const TOPICS_LOCAL = [
  "What's your comfort food?", "What's the last thing that made you laugh out loud?", 'Morning person or night owl?',
  "What's a place you'd love to visit someday?", "What's your go-to karaoke song?", "What's the best thing you've watched recently?",
  'What would you do with a free day tomorrow?', "What's a small thing that instantly improves your day?",
  'If you could master one instrument overnight, which one?', "What's the most beautiful place you've ever been?",
];

const regionNames = (() => { try { return new Intl.DisplayNames([I18N.lang, 'en'], { type: 'region' }); } catch { return null; } })();
const langNames = (() => { try { return new Intl.DisplayNames([I18N.lang, 'en'], { type: 'language' }); } catch { return null; } })();
const countryName = (c) => (c && regionNames ? regionNames.of(c) : c) || '';
const flag = (c) => (c && /^[A-Z]{2}$/.test(c) ? String.fromCodePoint(...[...c].map((ch) => 0x1f1a5 + ch.charCodeAt(0))) : '');
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function timeAgo(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  try {
    const rtf = new Intl.RelativeTimeFormat(I18N.lang, { numeric: 'auto' });
    if (s < 60) return rtf.format(-Math.round(s), 'second');
    if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
    if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
    return rtf.format(-Math.round(s / 86400), 'day');
  } catch { return new Date(ts).toLocaleString(); }
}

// ================= storage =================
const store = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
let prefs = Object.assign({ lang: 'any', interests: [], genderPref: 'any', countries: [], exclude: [], similarOnly: false }, store.get('soa-prefs', {}));
let soundOn = store.get('soa-sound', true);
let history = store.get('soa-history', []);

// ================= state =================
let ws, me = null, token = store.get('soa-token', ''), verified = false, aiModeration = false;
let ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const S = { active: false, mode: 'voice', kind: 'random', partner: null, searching: false, seconds: 0, record: null };
let pc = null, pendingIce = [], localStream = null, connected = false, muted = false;
let audioCtx = null, meterRaf = null, myMeterRaf = null, qualityId = null, wakeLock = null;
let timerId = null, secondsLeft = 0, roundTotal = 180;
let friends = [], unread = {}, dmWith = null, dmOldest = null, recentList = [], blockList = [];
let outgoingCall = null, incomingCall = null, ringStop = null;
let lastTypingSent = 0, typingTimer = null, dmTypingTimer = null;

// ================= small UI helpers =================
function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = text;
  $('toasts').appendChild(el);
  setTimeout(() => el.classList.add('out'), 2800);
  setTimeout(() => el.remove(), 3200);
}
function notice(text) { $('notice').textContent = text || ''; }
function setStatus(text) { $('status').textContent = text; }
function countTo(el, target) {
  const start = Number(el.textContent) || 0;
  if (start === target || reduceMotion) { el.textContent = target; return; }
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / 500);
    el.textContent = Math.round(start + (target - start) * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
function sound(kind) {
  if (!soundOn) return;
  try {
    const ctx = getAudioCtx();
    const notes = { match: [660, 880], leave: [440, 330], ping: [880], pop: [1200], win: [660, 880, 1100], msg: [990, 1320] }[kind] || [660];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      const at = ctx.currentTime + i * 0.12;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.12, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + (kind === 'pop' ? 0.08 : 0.22));
      o.connect(g).connect(ctx.destination); o.start(at); o.stop(at + 0.3);
    });
  } catch {}
}
function ring() {
  stopRing();
  let on = true;
  const tick = () => { if (on) { sound('msg'); setTimeout(() => on && sound('ping'), 250); } };
  tick();
  const id = setInterval(tick, 1500);
  if (navigator.vibrate) navigator.vibrate([400, 200, 400]);
  ringStop = () => { on = false; clearInterval(id); };
}
function stopRing() { if (ringStop) ringStop(); ringStop = null; }
function floatEmoji(emoji, who) {
  if (reduceMotion) return;
  const el = document.createElement('span');
  el.className = 'float ' + who; el.textContent = emoji;
  el.style.left = (who === 'me' ? 55 + Math.random() * 30 : 15 + Math.random() * 30) + '%';
  el.style.setProperty('--drift', (Math.random() * 80 - 40).toFixed(0) + 'px');
  $('floats').appendChild(el);
  setTimeout(() => el.remove(), 2600);
}
function confetti() {
  if (reduceMotion) return;
  const colors = ['#e11d48', '#2563eb', '#059669', '#fb7185', '#f59e0b'];
  for (let i = 0; i < 60; i++) {
    const c = document.createElement('i');
    c.className = 'confetti';
    c.style.left = 50 + (Math.random() * 30 - 15) + '%';
    c.style.background = colors[i % colors.length];
    c.style.setProperty('--x', (Math.random() * 600 - 300).toFixed(0) + 'px');
    c.style.setProperty('--y', (Math.random() * -500 - 150).toFixed(0) + 'px');
    c.style.setProperty('--r', (Math.random() * 900 - 450).toFixed(0) + 'deg');
    c.style.animationDelay = (Math.random() * 0.15).toFixed(2) + 's';
    $('floats').appendChild(c);
    setTimeout(() => c.remove(), 1800);
  }
}
function ripple(e) {
  const b = e.currentTarget, r = b.getBoundingClientRect();
  const s = document.createElement('span');
  s.className = 'ripple';
  s.style.left = (e.clientX - r.left) + 'px'; s.style.top = (e.clientY - r.top) + 'px';
  b.appendChild(s);
  setTimeout(() => s.remove(), 600);
}
function browserNotify(title, body) {
  if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  try { new Notification(title, { body, icon: '/apple-touch-icon.png' }); } catch {}
}
let titleTimer = null;
function flashTitle(text) {
  if (!document.hidden) return;
  let on = false;
  clearInterval(titleTimer);
  titleTimer = setInterval(() => { document.title = (on = !on) ? text : 'Strangers on Air'; }, 900);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { clearInterval(titleTimer); document.title = 'Strangers on Air'; } });
function initTilt(root = document) {
  if (reduceMotion || matchMedia('(hover: none)').matches) return;
  root.querySelectorAll('.tilt').forEach((el) => {
    if (el._tilt) return; el._tilt = true;
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
      el.style.transform = `perspective(700px) rotateX(${(-y * 10).toFixed(2)}deg) rotateY(${(x * 12).toFixed(2)}deg) translateZ(4px)`;
      el.style.setProperty('--gx', ((x + 0.5) * 100).toFixed(0) + '%');
      el.style.setProperty('--gy', ((y + 0.5) * 100).toFixed(0) + '%');
    });
    el.addEventListener('pointerleave', () => { el.style.transform = ''; });
  });
}
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
// SVG icons from the sprite in index.html
function setIcon(btn, name) { const u = btn.querySelector('use'); if (u) u.setAttribute('href', '#i-' + name); }
function svgIcon(name, cls = 'i') {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg'); s.setAttribute('class', cls); s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS(ns, 'use'); u.setAttribute('href', '#i-' + name); s.appendChild(u);
  return s;
}

// ================= navigation =================
let view = 'home';
const DEEP_LINKS = ['start', 'about', 'contact', 'blog', 'friends', 'history', 'profile'];
function go(v) {
  view = v;
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === v));
  document.querySelectorAll('#tabs [data-go], #appbar [data-go], #accountMenu [data-go]').forEach((b) => {
    b.classList.toggle('active', b.dataset.go === v);
    if (b.dataset.go === v) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  $('accountBtn').classList.toggle('active', ['friends', 'history', 'profile'].includes(v));
  closeMenus();
  if (v === 'blog') showBlogList();
  if (v === 'start') { renderTurnstile(); updateStart(); }
  // window.history (the page's own `history` variable holds saved chats)
  // "#/about" (not "#about", which would make the browser jump to the section's id)
  if (DEEP_LINKS.includes(v) || v === 'home') window.history.replaceState(null, '', v === 'home' ? location.pathname + location.search : '#/' + v);
  document.body.classList.toggle('in-session-elsewhere', S.active && v !== 'session');
  document.body.classList.toggle('on-home', v === 'home');
  if (v === 'home') window.Globe && Globe.setMode('idle');
  if (v === 'session') window.Globe && Globe.setMode(S.partner ? 'call' : 'search');
  if (v === 'friends') renderFriends();
  if (v === 'history') renderHistory();
  window.scrollTo({ top: 0 });
}
document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));

// ----- header menus -----
function closeMenus() {
  $('accountMenu').hidden = true; $('accountBtn').setAttribute('aria-expanded', 'false');
  $('tabs').classList.remove('open'); $('menuBtn').setAttribute('aria-expanded', 'false');
}
$('accountBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const open = $('accountMenu').hidden;
  closeMenus();
  $('accountMenu').hidden = !open; $('accountBtn').setAttribute('aria-expanded', String(open));
  if (open) $('accountMenu').querySelector('button').focus();
});
$('menuBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const open = !$('tabs').classList.contains('open');
  closeMenus();
  $('tabs').classList.toggle('open', open); $('menuBtn').setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', (e) => { if (!e.target.closest('.account, #tabs, #menuBtn')) closeMenus(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && (!$('accountMenu').hidden || $('tabs').classList.contains('open'))) { closeMenus(); $('accountBtn').focus(); } });
// "Start chatting": go to the start panel (it has the voice / text choice)
// "Start chatting" opens the Start page: Cloudflare check → 18+ → voice or text
let wantedMode = null;
function openStart(mode) {
  if (S.active) return go('session');
  wantedMode = mode || null;
  go('start');
  setTimeout(() => {
    const next = !verified ? null : !$('adult').checked ? $('adult') : $(wantedMode === 'text' ? 'startText' : 'startVoice');
    if (next) next.focus({ preventScroll: true });
  }, 350);
}
$('navStart').addEventListener('click', () => openStart());
const returnPill = el('button', 'return-pill');
returnPill.addEventListener('click', () => go('session'));
document.body.appendChild(returnPill);
function updateReturnPill() {
  returnPill.textContent = '● ' + (S.partner ? t('inCallWith', { name: S.partner.nick }) : t('looking'));
  document.body.classList.toggle('in-session-elsewhere', S.active && view !== 'session');
}

// ================= theme, language, sound =================
function setTheme(th) {
  document.documentElement.dataset.theme = th;
  store.set('soa-theme', th);
  setIcon($('themeBtn'), th === 'dark' ? 'sun' : 'moon');
  document.querySelector('meta[name=theme-color]').content = th === 'dark' ? '#070c19' : '#f1e6de';
  window.Globe && Globe.refresh && Globe.refresh();
  window.HeroGlobe && HeroGlobe.refresh && HeroGlobe.refresh();
}
setTheme(document.documentElement.dataset.theme || 'light');
$('themeBtn').addEventListener('click', () => {
  const root = document.documentElement;
  root.classList.add('theme-anim');
  setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark');
  clearTimeout(setTheme.t);
  setTheme.t = setTimeout(() => root.classList.remove('theme-anim'), 500);
});
function renderSoundBtn() { setIcon($('soundBtn'), soundOn ? 'volume' : 'volume-x'); $('soundBtn').setAttribute('aria-pressed', String(soundOn)); }
renderSoundBtn();
$('soundBtn').addEventListener('click', () => { soundOn = !soundOn; store.set('soa-sound', soundOn); renderSoundBtn(); sound('ping'); });
$('uiLang').value = I18N.lang;
$('uiLang').addEventListener('change', () => I18N.setLang($('uiLang').value));
document.addEventListener('langchange', () => { renderStatic(); renderFriends(); renderHistory(); updateFilterSummary(); updateReturnPill(); if (verified) shield(t('verified'), 'ok'); });

// ================= filters & profile fields =================
function chipSet(container, selected, onChange) {
  container.innerHTML = '';
  for (const [key, label] of INTERESTS) {
    const b = el('button', 'chip' + (selected.includes(key) ? ' active' : ''), label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(selected.includes(key)));
    b.onclick = () => {
      const i = selected.indexOf(key);
      if (i === -1) { if (selected.length >= 8) return; selected.push(key); } else selected.splice(i, 1);
      b.classList.toggle('active');
      b.setAttribute('aria-pressed', String(b.classList.contains('active')));
      onChange();
    };
    container.appendChild(b);
  }
}
function savePrefs() { store.set('soa-prefs', prefs); updateFilterSummary(); }
function renderStatic() {
  chipSet($('interestChips'), prefs.interests, () => { savePrefs(); syncProfileInterests(); });
  chipSet($('pfInterests'), prefs.interests, () => { savePrefs(); chipSet($('interestChips'), prefs.interests, () => { savePrefs(); syncProfileInterests(); }); });
  $('lang').innerHTML = '';
  for (const l of LANGS) {
    const o = el('option', null, l === 'any' ? '🌐 ' + t('anyLang') : (langNames ? langNames.of(l) : l));
    o.value = l; $('lang').appendChild(o);
  }
  $('lang').value = prefs.lang;
  $('genderPref').value = prefs.genderPref;
  $('similarOnly').checked = prefs.similarOnly;
  $('myCountry').innerHTML = '';
  const none = el('option', null, '—'); none.value = ''; $('myCountry').appendChild(none);
  for (const c of [...COUNTRIES].sort((a, b) => countryName(a).localeCompare(countryName(b)))) {
    const o = el('option', null, `${flag(c)} ${countryName(c)}`); o.value = c; $('myCountry').appendChild(o);
  }
  if (me) { $('myCountry').value = me.country || ''; $('myGender').value = me.gender || ''; }
  updateFilterSummary();
}
function syncProfileInterests() { chipSet($('pfInterests'), prefs.interests, () => { savePrefs(); renderStatic(); }); }
function updateFilterSummary() {
  $('pickCountries').textContent = prefs.countries.length ? t('onlyN', { n: prefs.countries.length }) : t('anywhere');
  $('pickExclude').textContent = prefs.exclude.length ? t('excludeN', { n: prefs.exclude.length }) : t('excludeNone');
  const bits = [];
  if (prefs.interests.length) bits.push(prefs.interests.length + ' ♥');
  if (prefs.lang !== 'any') bits.push(prefs.lang.toUpperCase());
  if (prefs.genderPref !== 'any') bits.push(t(prefs.genderPref === 'female' ? 'women' : prefs.genderPref === 'male' ? 'men' : 'otherGender'));
  if (prefs.countries.length) bits.push(prefs.countries.map(flag).slice(0, 4).join(''));
  if (prefs.exclude.length) bits.push('🚫' + prefs.exclude.length);
  $('filterSummary').textContent = bits.join(' · ');
}
$('lang').addEventListener('change', () => { prefs.lang = $('lang').value; savePrefs(); });
$('genderPref').addEventListener('change', () => { prefs.genderPref = $('genderPref').value; savePrefs(); });
$('similarOnly').addEventListener('change', () => { prefs.similarOnly = $('similarOnly').checked; savePrefs(); });
$('myGender').addEventListener('change', () => sendProfile({ gender: $('myGender').value }));
$('myCountry').addEventListener('change', () => sendProfile({ country: $('myCountry').value }));

let countryTarget = 'countries';
function openCountries(target) {
  countryTarget = target;
  $('countryDlgTitle').textContent = t(target === 'countries' ? 'pickCountriesTitle' : 'pickExcludeTitle');
  $('countrySearch').value = '';
  renderCountryList();
  $('countryDlg').showModal();
}
function renderCountryList() {
  const q = $('countrySearch').value.toLowerCase();
  const list = $('countryList');
  list.innerHTML = '';
  for (const c of [...COUNTRIES].sort((a, b) => countryName(a).localeCompare(countryName(b)))) {
    const name = countryName(c);
    if (q && !name.toLowerCase().includes(q) && !c.toLowerCase().includes(q)) continue;
    const lab = el('label', 'country-item');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = prefs[countryTarget].includes(c);
    cb.onchange = () => {
      const arr = prefs[countryTarget];
      if (cb.checked) { if (!arr.includes(c)) arr.push(c); } else arr.splice(arr.indexOf(c), 1);
    };
    lab.append(cb, el('span', null, `${flag(c)} ${name}`));
    list.appendChild(lab);
  }
}
$('countrySearch').addEventListener('input', renderCountryList);
$('pickCountries').addEventListener('click', () => openCountries('countries'));
$('pickExclude').addEventListener('click', () => openCountries('exclude'));
$('countryDlg').addEventListener('close', () => {
  if ($('countryDlg').returnValue === 'clear') prefs[countryTarget] = [];
  savePrefs();
});

// ================= Cloudflare Turnstile =================
let pendingToken = null, turnstileId = null;
function shield(text, cls) { $('shieldStatus').textContent = text; $('shieldStatus').className = 'shield-status ' + (cls || ''); }
function updateStart() {
  const adult = $('adult').checked, ok = adult && verified;
  $('startVoice').disabled = !ok; $('startText').disabled = !ok;
  $('stepCheck').className = verified ? 'done' : 'current';
  $('stepAdult').className = adult ? 'done' : verified ? 'current' : '';
  $('stepMode').className = ok ? 'current' : '';
  $('startHint').hidden = ok;
  if (ok && wantedMode && view === 'start') {
    const b = $(wantedMode === 'text' ? 'startText' : 'startVoice');
    b.classList.add('pulse-once'); setTimeout(() => b.classList.remove('pulse-once'), 1600);
  }
}
// The Cloudflare widget is drawn only when the Start page is shown (it can't run while hidden).
let turnstileSiteKey = null;
function renderTurnstile() {
  if (turnstileId !== null || !window.turnstile || !turnstileSiteKey || view !== 'start') return;
  turnstileId = turnstile.render('#turnstile', {
    sitekey: turnstileSiteKey,
    theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
    callback: (tok) => { pendingToken = tok; shield('…'); sendToken(); },
    'expired-callback': () => turnstile.reset(turnstileId),
    'error-callback': () => shield('Cloudflare check failed. Reload the page.', 'bad'),
  });
}
window.onTurnstileLoad = async () => {
  const cfg = await fetch('/config').then((r) => r.json());
  turnstileSiteKey = cfg.turnstileSiteKey;
  renderTurnstile();
};
function sendToken() { if (pendingToken && me && ws && ws.readyState === 1) { send({ type: 'verify', token: pendingToken }); pendingToken = null; } }
function needVerifyAgain() { verified = false; updateStart(); shield(t('checking')); if (window.turnstile && turnstileId !== null) turnstile.reset(turnstileId); }
fetch('/config').then((r) => r.json()).then((cfg) => {
  if (Array.isArray(cfg.iceServers) && cfg.iceServers.length) ICE = { iceServers: cfg.iceServers };
  aiModeration = !!cfg.aiModeration;
  $('modInfo').textContent = t(aiModeration ? 'aiOn' : 'aiOff');
}).catch(() => {});

// ================= WebSocket =================
function send(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }
function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  ws.onopen = () => send({ type: 'auth', token });
  ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } handle(m); };
  ws.onclose = () => {
    const wasVerified = verified;
    if (S.active) endLocalSession(false);
    if (wasVerified) { needVerifyAgain(); toast('Reconnecting…'); }
    setTimeout(connect, 1500);
  };
}

async function handle(m) {
  switch (m.type) {
    // --- account ---
    case 'account':
      if (m.token) { token = m.token; store.set('soa-token', token); }
      me = m.user;
      fillProfile();
      sendToken();
      break;
    case 'stats':
      for (const [id, v] of [['statOnline', m.online], ['statWaiting', m.waiting || 0], ['statMembers', m.members || 0]]) if ($(id)) countTo($(id), v);
      break;
    case 'verified':
      verified = m.ok; updateStart();
      if (m.ok) shield(t('verified'), 'ok'); else { shield(t('checkFailed'), 'bad'); setTimeout(needVerifyAgain, 1500); }
      break;
    case 'need-verify':
      if (S.active) endLocalSession(false);
      needVerifyAgain(); openStart(); toast(t('checkFirst')); break;
    case 'toast':
      toast(t(m.key)); if (m.key === 'slowDown') $('cSend').disabled = false; break;
    case 'contact-ok':
      contactDone(true); break;
    case 'profile-saved':
      me = m.user; fillProfile(); $('profileError').textContent = ''; break;
    case 'profile-error':
      $('profileError').textContent = t(m.key); break;

    // --- session ---
    case 'waiting':
      showSearching(m.mode); break;
    case 'matched':
      await onMatched(m); break;
    case 'voice-start':
      notice(t('voiceStarting'));
      try { await getMic(); } catch { toast(t('micNeeded')); return; }
      S.mode = 'voice'; applySessionMode();
      await startRTC(m.role);
      break;
    case 'signal':
      await onSignal(m.data); break;
    case 'partner-left': {
      const wasFriend = m.kind === 'friend';
      sound('leave');
      toast(`${S.partner ? S.partner.nick : ''} ${m.reason === 'left' ? t('theyLeft') : t('theySkipped')}`);
      const mode = S.mode;
      endLocalSession(false);
      if (wasFriend) { go(dmWith ? 'friends' : 'home'); }
      else { showSearching(mode); send({ type: 'find', mode, prefs }); }
      break;
    }
    case 'chat':
      addMsg($('msgs'), { id: m.id, who: 'them', text: m.text, ts: m.ts });
      recordMsg('them', m.text, m.ts);
      $('typing').hidden = true;
      sound('msg');
      if (view !== 'session') toast(`${S.partner ? S.partner.nick : ''}: ${m.text.slice(0, 60)}`);
      break;
    case 'chat-sent':
      addMsg($('msgs'), { id: m.id, who: 'me', text: m.text, ts: m.ts });
      recordMsg('me', m.text, m.ts);
      break;
    case 'retract': case 'retracted': {
      const node = $('msgs').querySelector(`[data-id="${m.id}"] .txt`);
      if (node) { node.textContent = t('removedMsg'); node.parentElement.classList.add('removed'); }
      break;
    }
    case 'moderated':
      toast(t('moderatedMsg', { cat: m.category, n: m.strikes })); break;
    case 'banned':
      endLocalSession(true); go('home'); toast(t('banned', { n: m.minutes })); break;
    case 'typing':
      $('typing').hidden = false;
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => { $('typing').hidden = true; }, 3000);
      break;
    case 'react':
      floatEmoji(m.emoji, 'them'); sound('pop'); break;
    case 'partner-mute':
      $('partnerMuted').hidden = !m.muted; break;
    case 'game':
      window.Games.handle(m.data); break;
    case 'extend-request':
      notice(t('wantsExtend')); $('extendBtn').classList.add('on'); sound('ping'); break;
    case 'extended':
      secondsLeft += m.seconds; roundTotal = secondsLeft;
      $('extendBtn').classList.remove('on'); $('extendBtn').disabled = false;
      notice(t('extended')); confetti(); sound('win'); tick(); break;
    case 'voice-request':
      notice(t('wantsVoice')); $('voiceBtn').classList.add('on'); sound('ping'); break;

    // --- friends ---
    case 'friends':
      friends = m.list; unread = m.unread || {};
      renderFriends(); updateBadges();
      break;
    case 'presence': {
      const f = friends.find((x) => x.user.id === m.userId);
      if (f) { f.online = m.online; if (!m.online) f.user.lastSeen = Date.now(); renderFriends(); }
      break;
    }
    case 'friend-request':
      if (S.partner && S.partner.userId === m.user.id) { notice(t('wantsFriend')); $('friendBtn').classList.add('on'); }
      else toast(t('friendRequestFrom', { name: m.user.username || S.partner?.nick || '🙂' }));
      sound('ping');
      browserNotify('Strangers on Air', t('friendRequestFrom', { name: m.user.username || '🙂' }));
      break;
    case 'friend-accepted':
      toast(t('friendsNow', { name: m.user.username || (S.partner && S.partner.userId === m.user.id ? S.partner.nick : '🙂') }));
      confetti(); sound('win');
      if (S.partner && S.partner.userId === m.user.id) { $('friendBtn').disabled = true; $('friendBtn').classList.remove('on'); }
      break;
    case 'recent':
      recentList = m.list; renderRecent(); break;
    case 'blocks':
      blockList = m.list; renderBlocked(); break;

    // --- private messages ---
    case 'dm-history':
      if (m.with !== dmWith) break;
      renderDMHistory(m.list, m.more);
      break;
    case 'dm': {
      const msg = m.message;
      const other = msg.sender === me.id ? msg.recipient : msg.sender;
      if (dmWith === other && view === 'friends' && !document.hidden) {
        appendDM(msg);
        if (msg.sender !== me.id) send({ type: 'dm-read', with: other });
        $('dmTyping').hidden = true;
      } else if (msg.sender !== me.id) {
        unread[other] = (unread[other] || 0) + 1;
        updateBadges(); renderFriends();
        const f = friends.find((x) => x.user.id === other);
        const name = f ? displayFriend(f.user) : '🙂';
        toast(t('newMessage', { name }));
        browserNotify(t('newMessage', { name }), msg.text || '🖼️');
      }
      if (msg.sender !== me.id) sound('msg');
      break;
    }
    case 'dm-removed': {
      const node = $('dmMsgs').querySelector(`[data-id="${m.id}"]`);
      if (node) { node.classList.add('removed'); node.querySelector('.txt').textContent = t('removedMsg'); const img = node.querySelector('img'); if (img) img.remove(); }
      break;
    }
    case 'dm-typing':
      if (m.from === dmWith) {
        $('dmTyping').hidden = false;
        clearTimeout(dmTypingTimer);
        dmTypingTimer = setTimeout(() => { $('dmTyping').hidden = true; }, 3000);
      }
      break;

    // --- friend calls ---
    case 'calling':
      outgoingCall = m.callId;
      break;
    case 'incoming-call':
      incomingCall = m;
      $('callAvatar').textContent = m.from.avatar || '🙂';
      $('callName').textContent = displayFriend(m.from);
      $('callText').textContent = m.mode === 'text' ? t('incomingText') : t('incomingCall');
      if (!$('callDlg').open) $('callDlg').showModal();
      ring();
      browserNotify(displayFriend(m.from), t('incomingCall'));
      flashTitle('📞 ' + displayFriend(m.from));
      break;
    case 'call-ended':
      stopRing();
      if (incomingCall && incomingCall.callId == m.callId) {
        if ($('callDlg').open) $('callDlg').close('ended');
        if (m.reason === 'missed' && m.from) toast(t('missedCall', { name: displayFriend(m.from) }));
        incomingCall = null;
      }
      if (outgoingCall == m.callId) {
        outgoingCall = null;
        $('callingBar') && $('callingBar').remove();
        if (m.reason === 'declined') toast(t('callDeclined'));
        else if (m.reason === 'no-answer') toast(t('noAnswer'));
      }
      break;
  }
}

// ================= audio & WebRTC =================
async function getMic() {
  if (localStream) return localStream;
  if (FAKE_MIC) {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.frequency.value = 220 + Math.random() * 440; gain.gain.value = 0.05;
    setInterval(() => { gain.gain.value = gain.gain.value > 0.01 ? 0 : 0.05; }, 600);
    const dest = ctx.createMediaStreamDestination();
    osc.connect(gain).connect(dest); osc.start();
    localStream = dest.stream;
  } else {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  }
  return localStream;
}
function makeAnalyser(stream) {
  const ctx = getAudioCtx();
  const an = ctx.createAnalyser(); an.fftSize = 256;
  ctx.createMediaStreamSource(stream).connect(an);
  return [an, new Uint8Array(an.frequencyBinCount)];
}
function levelOf(an, data) { an.getByteFrequencyData(data); return Math.min(1, data.reduce((a, b) => a + b, 0) / data.length / 60); }
function startMeter(stream) {
  stopMeter();
  const [an, data] = makeAnalyser(stream);
  const loop = () => {
    const lv = levelOf(an, data);
    $('pulse').style.opacity = (lv * 0.6).toFixed(2);
    $('pulse').style.transform = `scale(${1 + lv * 0.4})`;
    $('avatar').style.setProperty('--talk', lv.toFixed(2));
    meterRaf = requestAnimationFrame(loop);
  };
  loop();
}
function stopMeter() {
  if (meterRaf) cancelAnimationFrame(meterRaf); meterRaf = null;
  $('pulse').style.opacity = ''; $('pulse').style.transform = ''; $('avatar').style.setProperty('--talk', 0);
}
function startMyMeter() {
  if (myMeterRaf || !localStream) return;
  const [an, data] = makeAnalyser(localStream);
  const loop = () => { $('myLevel').style.transform = `scaleX(${muted ? 0 : levelOf(an, data)})`; myMeterRaf = requestAnimationFrame(loop); };
  loop();
}
async function startRTC(role) {
  closeRTC();
  connected = false;
  setStatus(t('connecting'));
  pc = new RTCPeerConnection(ICE);
  const stream = await getMic();
  stream.getTracks().forEach((tr) => { tr.enabled = !muted; pc.addTrack(tr, stream); });
  startMyMeter();
  if (muted) send({ type: 'mute', muted: true });
  pc.onicecandidate = (e) => e.candidate && send({ type: 'signal', data: { candidate: e.candidate } });
  pc.ontrack = (e) => { $('remoteAudio').srcObject = e.streams[0]; $('remoteAudio').play().catch(() => {}); startMeter(e.streams[0]); };
  pc.onconnectionstatechange = () => {
    if (!pc) return;
    if (pc.connectionState === 'connected' && !connected) {
      connected = true;
      setStatus(t('connected'));
      if (S.seconds) startTimer(S.seconds); else $('timer').textContent = S.kind === 'friend' ? '∞' : '';
      startQuality(); keepAwake(true);
      notice('');
    } else if (pc.connectionState === 'failed') setStatus(t('connFailed'));
  };
  if (role === 'caller') {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: 'signal', data: { sdp: pc.localDescription } });
  }
}
async function onSignal(data) {
  if (!pc) {
    // the other side started voice first (e.g. switch-to-voice race): set up as callee
    if (data.sdp && data.sdp.type === 'offer' && S.active) { try { await getMic(); } catch { return; } S.mode = 'voice'; applySessionMode(); await startRTC('callee'); }
    else return;
  }
  if (data.sdp) {
    await pc.setRemoteDescription(data.sdp);
    for (const c of pendingIce) await pc.addIceCandidate(c).catch(() => {});
    pendingIce = [];
    if (data.sdp.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: 'signal', data: { sdp: pc.localDescription } });
    }
  } else if (data.candidate) {
    if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
    else pendingIce.push(data.candidate);
  }
}
function closeRTC() {
  connected = false;
  stopTimer(); stopMeter(); stopQuality(); keepAwake(false);
  if (pc) { pc.onconnectionstatechange = null; pc.close(); pc = null; }
  pendingIce = [];
  $('remoteAudio').srcObject = null;
  $('partnerMuted').hidden = true;
}
function startQuality() {
  stopQuality();
  $('quality').hidden = false;
  qualityId = setInterval(async () => {
    if (!pc) return;
    let rtt = null;
    (await pc.getStats()).forEach((s) => { if (s.type === 'candidate-pair' && s.nominated && s.currentRoundTripTime != null) rtt = s.currentRoundTripTime * 1000; });
    if (rtt === null) return;
    $('quality').dataset.q = rtt < 150 ? 'good' : rtt < 350 ? 'ok' : 'bad';
    $('qualityText').textContent = (rtt < 150 ? 'Great' : rtt < 350 ? 'OK' : 'Weak') + ` · ${Math.round(rtt)} ms`;
  }, 2000);
}
function stopQuality() { clearInterval(qualityId); qualityId = null; $('quality').hidden = true; }
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request('screen');
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { wakeLock = null; }
}
function startTimer(seconds) {
  stopTimer();
  secondsLeft = roundTotal = seconds;
  tick();
  timerId = setInterval(() => { secondsLeft--; tick(); if (secondsLeft <= 0) next(); }, 1000);
}
function stopTimer() { clearInterval(timerId); timerId = null; $('timer').textContent = ''; $('timer').style.color = ''; $('ringBar').style.strokeDashoffset = 0; }
function tick() {
  const s = Math.max(0, secondsLeft);
  $('timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  $('ringBar').style.strokeDashoffset = (339.3 * (1 - s / roundTotal)).toFixed(1);
  $('timer').style.color = s <= 20 ? 'var(--danger)' : '';
}

// ================= sessions =================
function applySessionMode() {
  const sec = $('session');
  sec.classList.toggle('mode-voice', S.mode === 'voice');
  sec.classList.toggle('mode-text', S.mode === 'text');
  sec.classList.toggle('kind-friend', S.kind === 'friend');
  sec.classList.toggle('kind-random', S.kind === 'random');
  sec.classList.toggle('has-partner', !!S.partner);
  $('sessMode').textContent = S.mode === 'voice' ? (S.kind === 'friend' ? 'Friend call' : 'Voice call · messages open') : 'Text chat';
}
function showSearching(mode) {
  closeRTC();
  saveRecord();
  Object.assign(S, { active: true, mode, kind: 'random', partner: null, searching: true, seconds: 0 });
  applySessionMode();
  go('session');
  window.Globe && Globe.setMode('search');
  $('session').classList.remove('ended');
  $('session').classList.add('searching');
  $('partnerName').textContent = ''; $('partnerFlag').textContent = ''; $('common').innerHTML = '';
  $('whoAvatar').textContent = '🎧'; $('avatarEmoji').textContent = '🎧';
  setStatus(t('looking'));
  $('topic').textContent = '—';
  $('msgs').innerHTML = ''; $('typing').hidden = true;
  $('gamePanel').hidden = true;
  window.Games.reset();
  ['extendBtn', 'friendBtn', 'reportBtn', 'voiceBtn', 'gamesBtn'].forEach((id) => { $(id).disabled = true; $(id).classList.remove('on'); });
  notice('');
  updateReturnPill();
}
async function onMatched(m) {
  closeRTC();
  saveRecord();
  Object.assign(S, { active: true, mode: m.mode, kind: m.kind, partner: m.partner, searching: false, seconds: m.seconds || 0 });
  S.record = { id: Date.now(), partner: m.partner.nick, avatar: m.partner.avatar, mode: m.mode, kind: m.kind, start: Date.now(), msgs: [] };
  applySessionMode();
  if (view !== 'session') go('session');
  $('session').classList.remove('searching', 'ended');
  $('session').classList.add('matched');
  setTimeout(() => $('session').classList.remove('matched'), 900);
  window.Globe && Globe.setMode('call');
  $('partnerName').textContent = m.partner.nick;
  $('partnerFlag').textContent = flag(m.partner.country);
  $('partnerFlag').title = countryName(m.partner.country);
  $('whoAvatar').textContent = m.partner.avatar || '🙂';
  $('avatarEmoji').textContent = m.partner.avatar || '🙂';
  $('common').innerHTML = '';
  if (m.common && m.common.length) {
    $('common').append(el('span', 'common-label', t('sharedInterests') + ':'));
    for (const k of m.common) { const it = INTERESTS.find((x) => x[0] === k); if (it) $('common').append(el('span', 'chip mini', it[1])); }
  }
  $('topic').textContent = m.topic;
  $('msgs').innerHTML = '';
  addMsg($('msgs'), { who: 'sys', text: t('matchedWith', { name: m.partner.nick }) });
  ['extendBtn', 'friendBtn', 'reportBtn', 'voiceBtn', 'gamesBtn'].forEach((id) => { $(id).disabled = false; $(id).classList.remove('on'); });
  if (S.kind === 'friend' || friends.some((f) => f.user.id === m.partner.userId && f.status === 'accepted')) $('friendBtn').disabled = true;
  notice('');
  window.Games.reset();
  sound('match');
  if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
  flashTitle('🔴 ' + t('matchedWith', { name: m.partner.nick }));
  updateReturnPill();
  if (m.mode === 'voice') {
    try { await getMic(); } catch { toast(t('micNeeded')); }
    await startRTC(m.role);
  } else {
    setStatus(t('chatting'));
    $('timer').textContent = '';
    setTimeout(() => $('chatInput').focus(), 100);
  }
}
function endLocalSession(sendStop) {
  if (sendStop) send({ type: 'stop' });
  closeRTC();
  saveRecord();
  Object.assign(S, { active: false, partner: null, searching: false });
  $('gamePanel').hidden = true;
  notice('');
  updateReturnPill();
}
function next(e) {
  if (S.kind === 'friend') return stop();
  const mode = S.mode === 'voice' && S.record && S.record.mode === 'text' ? 'text' : S.mode;
  if (!S.active) { $('session').classList.remove('ended'); return startRandom(mode || 'voice', e); } // call again after ending
  showSearching(mode);
  send({ type: 'next' });
}
// End call: hang up but stay on the chat page so you can press Call again.
function stop() {
  if (!S.active) return; // already ended
  if (S.kind === 'friend') { endLocalSession(true); go(dmWith ? 'friends' : 'home'); return; }
  const wasSearching = S.searching, who = S.partner && S.partner.nick;
  endLocalSession(true);
  const sess = $('session');
  sess.classList.remove('searching', 'has-partner');
  sess.classList.add('ended');
  window.Globe && Globe.setMode('idle');
  setStatus(wasSearching ? 'Search stopped' : 'Call ended');
  $('timer').textContent = '';
  if (!wasSearching) addMsg($('msgs'), { who: 'sys', text: who ? `You ended the call with ${who}` : 'Call ended' });
  ['extendBtn', 'friendBtn', 'reportBtn', 'voiceBtn', 'gamesBtn'].forEach((id) => { $(id).disabled = true; $(id).classList.remove('on'); });
  notice('Press Call to talk to someone new');
  sound('leave');
}
async function startRandom(mode, e) {
  if (e) ripple(e);
  getAudioCtx();
  if (mode === 'voice') {
    try { await getMic(); } catch (err) { toast(t('micNeeded')); return; }
  }
  showSearching(mode);
  send({ type: 'find', mode, prefs });
}
$('startVoice').addEventListener('click', (e) => startRandom('voice', e));
$('startText').addEventListener('click', (e) => startRandom('text', e));
// hero / card / CTA buttons: start right away when ready, otherwise bring up the start panel
document.querySelectorAll('[data-start]').forEach((b) => b.addEventListener('click', (e) => {
  if ($('adult').checked && verified) return startRandom(b.dataset.start, e);
  openStart(b.dataset.start);
}));
// 3D scroll-in reveal
if ('IntersectionObserver' in window && !reduceMotion) {
  const io = new IntersectionObserver((entries) => entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } }), { threshold: 0.15 });
  document.querySelectorAll('.reveal-up').forEach((n) => io.observe(n));
} else document.querySelectorAll('.reveal-up').forEach((n) => n.classList.add('in'));
$('year').textContent = new Date().getFullYear();
// landing page: safety rules button, and links that jump to a home section
$('lpRules').addEventListener('click', () => $('rulesDlg').showModal());
$('sessRules').addEventListener('click', () => $('rulesDlg').showModal());
document.querySelectorAll('.year-now').forEach((n) => { n.textContent = new Date().getFullYear(); });
// Social profile links: paste each page's address here. Empty ones show "coming soon" instead of opening.
const SOCIAL = { facebook: '', reddit: '', x: '', instagram: '' };
document.querySelectorAll('[data-social]').forEach((a) => {
  const url = SOCIAL[a.dataset.social];
  if (url) a.href = url;
  else a.addEventListener('click', (e) => { e.preventDefault(); toast(a.getAttribute('aria-label') + ' page coming soon'); });
});
document.querySelectorAll('[data-scroll-to]').forEach((b) => b.addEventListener('click', () => {
  const target = b.dataset.scrollTo;
  if (view !== 'home') go('home');
  setTimeout(() => { const n = $(target); if (n) n.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' }); }, view === 'home' ? 0 : 80);
}));
$('adult').addEventListener('change', updateStart);
$('nextBtn').addEventListener('click', (e) => { ripple(e); next(); });
$('stopBtn').addEventListener('click', stop);

// ----- chat messages -----
function addMsg(box, { id, who, text, ts, image }) {
  const d = el('div', 'msg ' + who);
  if (id != null) d.dataset.id = id;
  if (image) { const img = el('img'); img.src = image; img.alt = ''; img.loading = 'lazy'; img.onclick = () => window.open().document.write(`<img src="${image}" style="max-width:100%">`); d.append(img); }
  d.append(el('span', 'txt', text || ''));
  if (ts && who !== 'sys') d.append(el('time', null, fmtTime(ts)));
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
  return d;
}
function recordMsg(who, text, ts) { if (S.record) S.record.msgs.push({ who, text, ts }); }
function saveRecord() {
  const r = S.record;
  S.record = null;
  if (!r || !r.msgs.length || r.kind === 'friend') return;
  history.unshift(r);
  history = history.slice(0, 40);
  store.set('soa-history', history);
}
$('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('chatInput').value.trim();
  if (!text || !S.partner) return;
  send({ type: 'chat', text });
  $('chatInput').value = '';
});
$('chatInput').addEventListener('input', () => {
  if (!S.partner || Date.now() - lastTypingSent < 2000) return;
  lastTypingSent = Date.now();
  send({ type: 'typing' });
});

// ----- toolbar -----
function setMuted(v) {
  muted = v;
  if (localStream) localStream.getAudioTracks().forEach((tr) => (tr.enabled = !muted));
  $('muteBtn').classList.toggle('on', muted);
  setIcon($('muteBtn'), muted ? 'mic-off' : 'mic');
  $('muteBtn').setAttribute('aria-pressed', String(muted));
  $('muteBtn').querySelector('b').textContent = t(muted ? 'unmute' : 'mute');
  if (S.partner) send({ type: 'mute', muted });
}
$('muteBtn').addEventListener('click', () => setMuted(!muted));
$('extendBtn').addEventListener('click', () => {
  send({ type: 'extend' }); $('extendBtn').disabled = true;
  if (!$('extendBtn').classList.contains('on')) notice(t('askedExtend'));
});
$('voiceBtn').addEventListener('click', async () => {
  try { await getMic(); } catch { toast(t('micNeeded')); return; }
  send({ type: 'voice-request' }); $('voiceBtn').disabled = true;
  if (!$('voiceBtn').classList.contains('on')) notice(t('askedVoice'));
});
$('friendBtn').addEventListener('click', () => { send({ type: 'friend-request' }); $('friendBtn').disabled = true; });
function setGamesOpen(open) { $('gamePanel').hidden = !open; $('gamesBtn').setAttribute('aria-expanded', String(open)); if (open) window.Games.render(); }
$('gamesBtn').addEventListener('click', () => setGamesOpen($('gamePanel').hidden));
$('gameClose').addEventListener('click', () => { setGamesOpen(false); $('gamesBtn').focus(); });
document.querySelectorAll('[data-game]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('[data-game]').forEach((x) => x.classList.toggle('active', x === b));
  window.Games.select(b.dataset.game);
}));
window.Games.init({
  body: $('gameBody'),
  send: (data) => send({ type: 'game', data }),
  notify: (kind, game) => {
    if (kind === 'win') { confetti(); sound('win'); }
    if (kind === 'invite') {
      setGamesOpen(true);
      document.querySelectorAll('[data-game]').forEach((x) => x.classList.toggle('active', x.dataset.game === game));
      sound('ping');
    }
  },
});
$('shuffle').addEventListener('click', () => {
  const card = $('topicCard');
  card.classList.remove('flip'); void card.offsetWidth; card.classList.add('flip');
  setTimeout(() => { $('topic').textContent = TOPICS_LOCAL[Math.floor(Math.random() * TOPICS_LOCAL.length)]; }, 200);
});
$('reactions').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b || !S.partner) return;
  send({ type: 'react', emoji: b.dataset.e }); floatEmoji(b.dataset.e, 'me');
});
let reportTarget = null;
$('reportBtn').addEventListener('click', () => { reportTarget = null; $('reportDlg').showModal(); });
$('reportDlg').addEventListener('close', () => {
  if ($('reportDlg').returnValue !== 'ok') return;
  const context = [...$(reportTarget ? 'dmMsgs' : 'msgs').querySelectorAll('.msg')].slice(-10).map((n) => (n.classList.contains('me') ? 'me: ' : 'them: ') + n.textContent).join('\n');
  send({ type: 'report', userId: reportTarget || undefined, reason: $('reportReason').value, block: $('reportBlock').checked, context });
  if (!reportTarget && S.kind === 'random') { showSearching(S.mode); }
  if (reportTarget && $('reportBlock').checked) closeDM();
});

// ----- emoji picker -----
let emojiTarget = null;
function openEmoji(btn, input) {
  const pop = $('emojiPop');
  document.querySelectorAll('.emoji-btn[aria-expanded]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  if (!pop.hidden && emojiTarget === input) { pop.hidden = true; return; }
  btn.setAttribute('aria-expanded', 'true');
  emojiTarget = input;
  if (!pop.childElementCount) {
    for (const e of EMOJI) {
      const b = el('button', null, e); b.type = 'button';
      b.onclick = () => { emojiTarget.value += e; emojiTarget.focus(); };
      pop.appendChild(b);
    }
  }
  const r = btn.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(window.innerWidth - 300, r.left)) + 'px';
  pop.style.top = Math.max(8, r.top - 210) + 'px';
  pop.hidden = false;
}
$('emojiBtn').addEventListener('click', (e) => openEmoji(e.currentTarget, $('chatInput')));
$('dmEmojiBtn').addEventListener('click', (e) => openEmoji(e.currentTarget, $('dmInput')));
function closeEmoji() { $('emojiPop').hidden = true; document.querySelectorAll('.emoji-btn[aria-expanded]').forEach((b) => b.setAttribute('aria-expanded', 'false')); }
document.addEventListener('click', (e) => { if (!e.target.closest('#emojiPop, .emoji-btn')) closeEmoji(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('emojiPop').hidden) { closeEmoji(); e.stopPropagation(); } }, true);
// keyboard access for the image picker label
document.querySelectorAll('label.emoji-btn[role=button]').forEach((l) => l.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); l.querySelector('input').click(); } }));

// ================= friends =================
const displayFriend = (u) => (u && u.username) || ((u && u.avatar) || '🙂') + ' ' + t('navFriends').replace(/s$/, '');
function updateBadges() {
  const incoming = friends.filter((f) => f.status === 'incoming').length;
  const unreadTotal = Object.values(unread).reduce((a, b) => a + b, 0);
  const total = incoming + unreadTotal;
  for (const id of ['friendsBadge', 'friendsBadgeMenu', 'friendsBadgeBar']) { $(id).hidden = !total; $(id).textContent = total; }
  $('reqBadge').hidden = !incoming; $('reqBadge').textContent = incoming;
}
function personRow(u, { sub, badge, actions = [], onClick, isOnline } = {}) {
  const row = el('div', 'person' + (onClick ? ' clickable' : ''));
  const av = el('div', 'who-avatar small', u.avatar || '🙂');
  if (isOnline !== undefined) av.append(el('i', 'presence ' + (isOnline ? 'on' : 'off')));
  const txt = el('div', 'person-text');
  txt.append(el('div', 'person-name', (u.username || u.nick || '—') + (u.country ? ' ' + flag(u.country) : '')));
  if (sub) txt.append(el('div', 'person-sub', sub));
  row.append(av, txt);
  if (badge) row.append(el('i', 'badge', badge));
  const acts = el('div', 'person-actions');
  for (const [label, fn, cls, aria] of actions) {
    const isIcon = label.startsWith('icon:');
    const b = el('button', cls || 'ghost small', isIcon ? null : label); b.type = 'button';
    if (isIcon) { b.append(svgIcon(label.slice(5))); b.setAttribute('aria-label', aria || ''); }
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    acts.append(b);
  }
  if (actions.length) row.append(acts);
  if (onClick) row.addEventListener('click', onClick);
  return row;
}
function renderFriends() {
  if (!$('friendList')) return;
  const accepted = friends.filter((f) => f.status === 'accepted').sort((a, b) => (b.online - a.online) || (unread[b.user.id] || 0) - (unread[a.user.id] || 0));
  $('friendList').innerHTML = '';
  if (!accepted.length) $('friendList').append(el('p', 'empty', t('noFriends')));
  for (const f of accepted) {
    $('friendList').append(personRow(f.user, {
      isOnline: f.online,
      sub: f.online ? '● ' + t('online') : t('lastSeen', { t: timeAgo(f.user.lastSeen) }),
      badge: unread[f.user.id] || '',
      actions: [['icon:phone', () => callFriend(f.user.id), 'icon-btn', t('call')]],
      onClick: () => openDM(f.user.id),
    }));
  }
  $('requestList').innerHTML = '';
  const reqs = friends.filter((f) => f.status !== 'accepted');
  if (!reqs.length) $('requestList').append(el('p', 'empty', t('noRequests')));
  for (const f of reqs) {
    if (f.status === 'incoming') {
      $('requestList').append(personRow(f.user, { sub: f.user.bio || '', actions: [
        [t('accept'), () => send({ type: 'friend-respond', userId: f.user.id, accept: true }), 'big small-big'],
        [t('decline'), () => send({ type: 'friend-respond', userId: f.user.id, accept: false })],
      ] }));
    } else {
      $('requestList').append(personRow(f.user, { sub: '⏳ ' + t('requestSent'), actions: [[t('cancel'), () => send({ type: 'friend-remove', userId: f.user.id })]] }));
    }
  }
  $('myNameHint').textContent = me && me.username ? t('shareName', { name: me.username }) : t('noUsername');
  if (dmWith) updateDMHeader();
}
function renderRecent() {
  $('recentList').innerHTML = '';
  if (!recentList.length) $('recentList').append(el('p', 'empty', t('noRecent')));
  for (const r of recentList) {
    const isFriend = friends.some((f) => f.user.id === r.userId);
    $('recentList').append(personRow({ nick: r.nick, avatar: r.avatar }, {
      sub: timeAgo(r.ts),
      actions: isFriend ? [] : [[t('addFriend'), () => send({ type: 'friend-add', userId: r.userId })]],
    }));
  }
}
function renderBlocked() {
  $('blockedList').innerHTML = '';
  if (!blockList.length) $('blockedList').append(el('p', 'empty', t('noBlocked')));
  for (const u of blockList) $('blockedList').append(personRow(u, { actions: [[t('unblock'), () => send({ type: 'unblock', userId: u.id })]] }));
}
document.querySelectorAll('[data-ft]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('[data-ft]').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.ft').forEach((x) => { x.hidden = x.id !== 'ft-' + b.dataset.ft; });
  if (b.dataset.ft === 'recent') send({ type: 'recent' });
  if (b.dataset.ft === 'blocked') send({ type: 'blocks' });
}));
$('addForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('addName').value.trim();
  if (!name) return;
  send({ type: 'friend-add', username: name });
  $('addName').value = '';
});
$('notifBtn').addEventListener('click', async () => {
  if (!('Notification' in window)) return;
  const p = await Notification.requestPermission();
  if (p === 'granted') { toast(t('notifOn')); $('notifBtn').hidden = true; }
});
if ('Notification' in window && Notification.permission === 'granted') $('notifBtn').hidden = true;

// ----- private messages -----
function updateDMHeader() {
  const f = friends.find((x) => x.user.id === dmWith);
  if (!f) return;
  $('dmAvatar').textContent = f.user.avatar || '🙂';
  $('dmName').textContent = (f.user.username || '🙂') + ' ' + flag(f.user.country);
  $('dmStatus').textContent = f.online ? '● ' + t('online') : t('lastSeen', { t: timeAgo(f.user.lastSeen) });
}
function openDM(userId) {
  dmWith = userId; dmOldest = null;
  $('dm').hidden = false;
  document.querySelector('.friends-layout').classList.add('dm-open');
  $('dmMsgs').innerHTML = ''; $('dmMenu').hidden = true; $('dmTyping').hidden = true;
  updateDMHeader();
  send({ type: 'dm-history', with: userId });
  send({ type: 'dm-read', with: userId });
  unread[userId] = 0; updateBadges(); renderFriends();
  setTimeout(() => $('dmInput').focus(), 50);
}
function closeDM() {
  dmWith = null;
  $('dm').hidden = true;
  document.querySelector('.friends-layout').classList.remove('dm-open');
}
function renderDMHistory(list, more) {
  const box = $('dmMsgs');
  const prevHeight = box.scrollHeight;
  const loadingOlder = dmOldest !== null;
  const frag = document.createDocumentFragment();
  if (more) {
    const b = el('button', 'link load-more', t('loadMore')); b.type = 'button';
    b.onclick = () => { b.remove(); send({ type: 'dm-history', with: dmWith, before: dmOldest }); };
    frag.append(b);
  }
  const tmp = el('div');
  for (const m of list) appendDM(m, tmp);
  frag.append(...tmp.childNodes);
  if (list.length) dmOldest = list[0].id;
  if (loadingOlder) { box.prepend(frag); box.scrollTop = box.scrollHeight - prevHeight; }
  else { box.append(frag); box.scrollTop = box.scrollHeight; }
}
function appendDM(m, box = $('dmMsgs')) {
  const d = addMsg(box, { id: m.id, who: m.sender === me.id ? 'me' : 'them', text: m.removed ? t('removedMsg') : m.text, ts: m.ts, image: m.removed ? '' : m.image });
  if (m.removed) d.classList.add('removed');
}
$('dmBack').addEventListener('click', closeDM);
$('dmForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('dmInput').value.trim();
  if (!text || !dmWith) return;
  send({ type: 'dm-send', to: dmWith, text });
  $('dmInput').value = '';
});
$('dmInput').addEventListener('input', () => {
  if (!dmWith || Date.now() - lastTypingSent < 2000) return;
  lastTypingSent = Date.now();
  send({ type: 'dm-typing', to: dmWith });
});
$('dmImage').addEventListener('change', async () => {
  const file = $('dmImage').files[0];
  $('dmImage').value = '';
  if (!file || !dmWith) return;
  try {
    const dataUrl = await shrinkImage(file, 1024, 0.8);
    send({ type: 'dm-send', to: dmWith, image: dataUrl });
  } catch { toast(t('imageTooBig')); }
});
function shrinkImage(file, max, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const url = c.toDataURL('image/jpeg', quality);
      URL.revokeObjectURL(img.src);
      url.length > 1_300_000 ? reject() : resolve(url);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}
$('dmCall').addEventListener('click', () => dmWith && callFriend(dmWith));
$('dmMore').addEventListener('click', () => { $('dmMenu').hidden = !$('dmMenu').hidden; $('dmMore').setAttribute('aria-expanded', String(!$('dmMenu').hidden)); });
$('dmRemove').addEventListener('click', () => { send({ type: 'friend-remove', userId: dmWith }); closeDM(); });
$('dmBlock').addEventListener('click', () => { send({ type: 'block', userId: dmWith }); closeDM(); });
$('dmReport').addEventListener('click', () => { reportTarget = dmWith; $('dmMenu').hidden = true; $('reportDlg').showModal(); });

// ----- friend calls -----
async function callFriend(userId) {
  try { await getMic(); } catch { toast(t('micNeeded')); return; }
  const f = friends.find((x) => x.user.id === userId);
  send({ type: 'call-friend', userId });
  const bar = el('div', 'calling-bar');
  bar.id = 'callingBar';
  bar.append(el('span', null, '📞 ' + t('calling', { name: f ? displayFriend(f.user) : '' })));
  const cancel = el('button', 'danger-btn', t('cancel'));
  cancel.onclick = () => { if (outgoingCall) send({ type: 'call-cancel', callId: outgoingCall }); outgoingCall = null; bar.remove(); };
  bar.append(cancel);
  $('callingBar') && $('callingBar').remove();
  document.body.append(bar);
  setTimeout(() => bar.isConnected && !outgoingCall && bar.remove(), 32000);
}
$('callDlg').addEventListener('close', async () => {
  stopRing();
  const c = incomingCall;
  incomingCall = null;
  if (!c) return;
  const accept = $('callDlg').returnValue === 'accept';
  if (accept && c.mode === 'voice') { try { await getMic(); } catch { toast(t('micNeeded')); send({ type: 'call-answer', callId: c.callId, accept: false }); return; } }
  send({ type: 'call-answer', callId: c.callId, accept });
});

// ================= history =================
function renderHistory() {
  const list = $('historyList');
  list.innerHTML = '';
  $('transcript').hidden = true; list.hidden = false;
  if (!history.length) list.append(el('p', 'empty', t('noHistory')));
  for (const h of history) {
    const last = h.msgs[h.msgs.length - 1];
    list.append(personRow({ nick: h.partner, avatar: h.avatar }, {
      sub: `${h.mode === 'voice' ? '🎙️' : '💬'} ${new Date(h.start).toLocaleString()} · ${last ? last.text.slice(0, 40) : ''}`,
      onClick: () => showTranscript(h),
    }));
  }
}
function showTranscript(h) {
  $('historyList').hidden = true;
  $('transcript').hidden = false;
  const box = $('transcriptMsgs');
  box.innerHTML = '';
  addMsg(box, { who: 'sys', text: `${h.avatar || ''} ${h.partner} · ${new Date(h.start).toLocaleString()}` });
  for (const m of h.msgs) addMsg(box, { who: m.who, text: m.text, ts: m.ts });
}
$('transcriptBack').addEventListener('click', renderHistory);
$('clearHistory').addEventListener('click', () => { history = []; store.set('soa-history', history); renderHistory(); });

// ================= profile =================
function fillProfile() {
  if (!me) return;
  $('pfUsername').value = me.username || '';
  $('pfBio').value = me.bio || '';
  $('avatarPick').textContent = me.avatar || '🙂';
  $('myCode').value = token;
  $('myGender').value = me.gender || '';
  $('myCountry').value = me.country || '';
  if (me.interests && me.interests.length && !prefs.interests.length) { prefs.interests = [...me.interests]; savePrefs(); renderStatic(); }
  $('myNameHint').textContent = me.username ? t('shareName', { name: me.username }) : t('noUsername');
}
function sendProfile(fields) { send({ type: 'profile', fields }); }
$('avatarGrid').innerHTML = '';
for (const a of AVATARS) {
  const b = el('button', null, a); b.type = 'button';
  b.onclick = () => { $('avatarPick').textContent = a; $('avatarGrid').hidden = true; };
  $('avatarGrid').appendChild(b);
}
$('avatarPick').addEventListener('click', () => { $('avatarGrid').hidden = !$('avatarGrid').hidden; });
$('profileForm').addEventListener('submit', (e) => {
  e.preventDefault();
  sendProfile({ username: $('pfUsername').value.trim(), bio: $('pfBio').value.trim(), avatar: $('avatarPick').textContent, interests: prefs.interests });
  toast(t('saved'));
});
$('copyCode').addEventListener('click', async () => { try { await navigator.clipboard.writeText(token); toast(t('copied')); } catch { $('myCode').select(); } });
$('useCodeForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('useCode').value.trim();
  if (code.length < 20) return;
  store.set('soa-token', code);
  toast(t('codeUsed'));
  setTimeout(() => location.reload(), 600);
});

// ================= mic test, rules, shortcuts =================
$('micTestBtn').addEventListener('click', async () => {
  try { await getMic(); } catch { $('micTestMsg').textContent = t('micBlocked'); $('micTestMsg').className = 'mictest-msg bad'; return; }
  const [an, data] = makeAnalyser(localStream);
  let heard = false;
  const t0 = performance.now();
  $('micTestMsg').textContent = t('sayIt'); $('micTestMsg').className = 'mictest-msg';
  const loop = (now) => {
    const lv = levelOf(an, data);
    $('micTestFill').style.transform = `scaleX(${lv})`;
    if (lv > 0.15 && !heard) { heard = true; $('micTestMsg').textContent = t('hearYou'); $('micTestMsg').className = 'mictest-msg ok'; }
    if (now - t0 < 8000) requestAnimationFrame(loop);
    else { $('micTestFill').style.transform = 'scaleX(0)'; if (!heard) $('micTestMsg').textContent = t('noHear'); }
  };
  requestAnimationFrame(loop);
});
$('rulesLink').addEventListener('click', () => $('rulesDlg').showModal());
if (!store.get('soa-rules-seen', false) && !params.has('preview')) setTimeout(() => { $('rulesDlg').showModal(); store.set('soa-rules-seen', true); }, 700);
document.addEventListener('keydown', (e) => {
  if (view !== 'session' || !S.active) return;
  if (e.target.closest('input, textarea, select, dialog')) return;
  const k = e.key.toLowerCase();
  if (k === 'm' && S.mode === 'voice') { e.preventDefault(); setMuted(!muted); }
  else if (k === 'n' && S.kind === 'random') { e.preventDefault(); next(); }
  else if (k === 'escape') { e.preventDefault(); stop(); }
});
// hide the calling bar as soon as a friend session begins
const observer = new MutationObserver(() => { if (S.kind === 'friend' && S.partner && $('callingBar')) $('callingBar').remove(); outgoingCall = S.kind === 'friend' && S.partner ? null : outgoingCall; });
observer.observe($('partnerName'), { childList: true, characterData: true, subtree: true });

// ================= blog =================
function showBlogList() {
  $('postView').hidden = true;
  const grid = $('postGrid');
  grid.hidden = false;
  if (grid.childElementCount) return;
  for (const p of window.BLOG_POSTS || []) {
    const card = el('button', 'post-card glass tilt');
    card.type = 'button';
    const art = el('div', 'post-art depth', p.emoji);
    const meta = el('div', 'post-meta', `${p.tag} · ${new Date(p.date).toLocaleDateString(I18N.lang, { day: 'numeric', month: 'short', year: 'numeric' })}`);
    card.append(art, meta, el('h3', null, p.title), el('p', null, p.summary));
    card.addEventListener('click', () => openPost(p));
    grid.append(card);
  }
  initTilt(grid);
}
function openPost(p) {
  $('postGrid').hidden = true;
  const body = $('postBody');
  body.innerHTML = '';
  body.append(el('div', 'post-meta', `${p.emoji} ${p.tag} · ${new Date(p.date).toLocaleDateString(I18N.lang, { day: 'numeric', month: 'long', year: 'numeric' })}`), el('h2', null, p.title));
  let list = null;
  for (const line of p.body) {
    if (line.startsWith('- ')) { if (!list) { list = el('ul'); body.append(list); } list.append(el('li', null, line.slice(2))); continue; }
    list = null;
    body.append(line.startsWith('## ') ? el('h3', null, line.slice(3)) : el('p', null, line));
  }
  $('postView').hidden = false;
  window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
  $('postBack').focus({ preventScroll: true });
}
$('postBack').addEventListener('click', () => { showBlogList(); $('postGrid').querySelector('button')?.focus(); });

// ================= contact =================
$('contactForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const email = $('cEmail').value.trim(), message = $('cMessage').value.trim();
  $('cEmailErr').textContent = ''; $('cMsgErr').textContent = '';
  let bad = null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { $('cEmailErr').textContent = t('badEmail'); bad = bad || $('cEmail'); }
  if (message.length < 5) { $('cMsgErr').textContent = t('msgTooShort'); bad = bad || $('cMessage'); }
  if (bad) { bad.focus(); return; }
  if (!verified) { toast(t('checking')); return; }
  $('cSend').disabled = true;
  send({ type: 'contact', name: $('cName').value.trim(), email, topic: $('cTopic').value, message });
});
function contactDone(ok) {
  $('cSend').disabled = false;
  if (!ok) return toast(t('slowDown'));
  $('contactForm').reset();
  $('contactDone').hidden = false;
  setTimeout(() => { $('contactDone').hidden = true; }, 6000);
}
// buttons that open the start panel from other pages, and links that jump to a home section
document.querySelectorAll('[data-start-nav]').forEach((b) => b.addEventListener('click', () => $('navStart').click()));
document.querySelectorAll('[data-scroll]').forEach((b) => b.addEventListener('click', () => setTimeout(() => $(b.dataset.scroll).scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' }), 80)));

// ================= start =================
document.body.classList.add('on-home');
I18N.apply();
renderStatic();
initTilt();
connect();
{ const h = location.hash.replace(/^#\/?/, ''); if (DEEP_LINKS.includes(h)) go(h); }
