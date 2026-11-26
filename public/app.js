// Strangers on Air — client: matchmaking over WebSocket, voice over WebRTC.
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const FAKE_MIC = params.has('fake'); // ?fake=1 sends a test tone instead of your mic (handy for testing alone)

const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const TOPICS_LOCAL = [
  "What's your comfort food?",
  "What's the last thing that made you laugh out loud?",
  'Morning person or night owl?',
  "What's a place you'd love to visit someday?",
  "What's your go-to karaoke song?",
  "What's the best thing you've watched recently?",
  'What would you do with a free day tomorrow?',
];

let ws, myNick = '';
let interest = 'any';
let localStream = null;
let pc = null;
let pendingIce = [];
let inCall = false;
let timerId = null, secondsLeft = 0, roundTotal = 180;
let muted = false;
let audioCtx = null, meterRaf = null;

// ---------- Cloudflare Turnstile ----------
let verified = false, pendingToken = null, turnstileId = null;
function shield(text, cls) {
  $('shieldStatus').textContent = text;
  $('shieldStatus').className = 'shield-status ' + (cls || '');
}
function updateTalk() { $('talkBtn').disabled = !($('adult').checked && verified); }
window.onTurnstileLoad = async () => {
  const { turnstileSiteKey } = await fetch('/config').then((r) => r.json());
  turnstileId = turnstile.render('#turnstile', {
    sitekey: turnstileSiteKey,
    theme: 'dark',
    callback: (token) => { pendingToken = token; shield('Verifying…'); sendToken(); },
    'expired-callback': () => { turnstile.reset(turnstileId); },
    'error-callback': () => shield('Cloudflare check failed. Reload the page.', 'bad'),
  });
};
function sendToken() {
  if (pendingToken && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'verify', token: pendingToken }));
    pendingToken = null;
  }
}
function needVerifyAgain() {
  verified = false; updateTalk();
  shield("Checking you're human (Cloudflare)…");
  if (window.turnstile && turnstileId !== null) turnstile.reset(turnstileId);
}

// ---------- WebSocket ----------
function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  ws.onopen = sendToken;
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => {
    hangup();
    if (verified) { show('home'); notice(''); needVerifyAgain(); }
    setTimeout(connect, 1500);
  };
}
const sendMsg = (m) => ws && ws.readyState === 1 && ws.send(JSON.stringify(m));

async function handle(m) {
  switch (m.type) {
    case 'hello':
      myNick = m.nick; $('myNick').textContent = myNick; break;
    case 'stats':
      $('online').textContent = m.online; break;
    case 'verified':
      verified = m.ok; updateTalk();
      if (m.ok) shield('✓ Verified by Cloudflare', 'ok');
      else { shield('Check failed — trying again…', 'bad'); setTimeout(needVerifyAgain, 1500); }
      break;
    case 'need-verify':
      hangup(); show('home'); needVerifyAgain(); break;
    case 'slow-down':
      notice('Slow down a little — too many skips in a minute.'); break;
    case 'waiting':
      showSearching(); break;
    case 'matched':
      await startCall(m); break;
    case 'signal':
      await onSignal(m.data); break;
    case 'partner-left':
      hangup();
      sysMsg(m.reason === 'left' ? 'They left.' : 'They skipped.');
      notice('Finding someone new…');
      sendMsg({ type: 'find', interest, lang: $('lang').value });
      break;
    case 'extend-request':
      notice('They want +3 min — tap ⏱️ to agree'); $('extendBtn').classList.add('on'); break;
    case 'extended':
      secondsLeft += m.seconds; roundTotal = secondsLeft;
      $('extendBtn').classList.remove('on'); $('extendBtn').disabled = false;
      notice('+3 minutes added 🎉'); tick(); break;
    case 'friend-request':
      notice('They want to stay in touch — tap 🤝 to agree'); $('friendBtn').classList.add('on'); break;
    case 'friends':
      notice(`You and ${m.partner} are now friends 🤝`); $('friendBtn').disabled = true; break;
    case 'chat':
      addMsg(m.text, 'them'); break;
  }
}

// ---------- audio ----------
async function getMic() {
  if (localStream) return localStream;
  if (FAKE_MIC) {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 220 + Math.random() * 440;
    gain.gain.value = 0.05;
    // pulse the tone so it "talks"
    setInterval(() => { gain.gain.value = gain.gain.value > 0.01 ? 0 : 0.05; }, 600);
    const dest = ctx.createMediaStreamDestination();
    osc.connect(gain).connect(dest); osc.start();
    localStream = dest.stream;
  } else {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  }
  return localStream;
}
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// Make the avatar pulse with the stranger's voice.
function startMeter(stream) {
  stopMeter();
  const ctx = getAudioCtx();
  const src = ctx.createMediaStreamSource(stream);
  const an = ctx.createAnalyser(); an.fftSize = 256;
  src.connect(an);
  const data = new Uint8Array(an.frequencyBinCount);
  const pulse = $('pulse');
  const loop = () => {
    an.getByteFrequencyData(data);
    const level = Math.min(1, data.reduce((a, b) => a + b, 0) / data.length / 60);
    pulse.style.opacity = (level * 0.6).toFixed(2);
    pulse.style.transform = `scale(${1 + level * 0.35})`;
    meterRaf = requestAnimationFrame(loop);
  };
  loop();
}
function stopMeter() {
  if (meterRaf) cancelAnimationFrame(meterRaf);
  meterRaf = null;
  $('pulse').style.opacity = ''; $('pulse').style.transform = '';
}

// ---------- WebRTC ----------
async function startCall(m) {
  hangup();
  inCall = true;
  $('call').classList.remove('searching');
  $('avatarEmoji').textContent = pick(['🦦', '🦊', '🐼', '🦉', '🐬', '🦁', '🐢', '🐙']);
  $('partner').textContent = m.partner;
  setStatus('Connecting…');
  $('topic').textContent = m.topic;
  $('msgs').innerHTML = '';
  sysMsg(`Matched with ${m.partner}${m.interest && m.interest !== 'any' ? ' · ' + m.interest : ''}`);
  ['extendBtn', 'friendBtn', 'reportBtn'].forEach((id) => { $(id).disabled = false; $(id).classList.remove('on'); });
  notice('');

  pc = new RTCPeerConnection(ICE);
  const stream = await getMic();
  stream.getTracks().forEach((t) => { t.enabled = !muted; pc.addTrack(t, stream); });

  pc.onicecandidate = (e) => e.candidate && sendMsg({ type: 'signal', data: { candidate: e.candidate } });
  pc.ontrack = (e) => {
    $('remoteAudio').srcObject = e.streams[0];
    $('remoteAudio').play().catch(() => {});
    startMeter(e.streams[0]);
  };
  pc.onconnectionstatechange = () => {
    if (!pc) return;
    if (pc.connectionState === 'connected') {
      setStatus('Connected · say hi 👋');
      startTimer(m.seconds);
    } else if (pc.connectionState === 'failed') {
      setStatus('Connection failed — try Next');
    }
  };

  if (m.role === 'caller') {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendMsg({ type: 'signal', data: { sdp: pc.localDescription } });
  }
}

async function onSignal(data) {
  if (!pc) return;
  if (data.sdp) {
    await pc.setRemoteDescription(data.sdp);
    for (const c of pendingIce) await pc.addIceCandidate(c).catch(() => {});
    pendingIce = [];
    if (data.sdp.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendMsg({ type: 'signal', data: { sdp: pc.localDescription } });
    }
  } else if (data.candidate) {
    if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
    else pendingIce.push(data.candidate);
  }
}

function hangup() {
  inCall = false;
  stopTimer();
  stopMeter();
  if (pc) { pc.onconnectionstatechange = null; pc.close(); pc = null; }
  pendingIce = [];
  $('remoteAudio').srcObject = null;
}

// ---------- timer ----------
function startTimer(seconds) {
  stopTimer();
  secondsLeft = roundTotal = seconds;
  tick();
  timerId = setInterval(() => {
    secondsLeft--;
    tick();
    if (secondsLeft <= 0) {
      sysMsg('Time is up!');
      next();
    }
  }, 1000);
}
function stopTimer() {
  clearInterval(timerId); timerId = null;
  $('timer').textContent = '3:00';
  $('ringBar').style.strokeDashoffset = 0;
}
function tick() {
  const s = Math.max(0, secondsLeft);
  $('timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  $('ringBar').style.strokeDashoffset = (339.3 * (1 - s / roundTotal)).toFixed(1);
  $('timer').style.color = s <= 20 ? 'var(--danger)' : '';
}

// ---------- UI ----------
const pick = (a) => a[Math.floor(Math.random() * a.length)];
function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
}
function setStatus(t) { $('status').textContent = t; }
function notice(t) { $('notice').textContent = t; }
function addMsg(text, who) {
  const d = document.createElement('div');
  d.className = who; d.textContent = text;
  $('msgs').appendChild(d); $('msgs').scrollTop = 1e6;
}
const sysMsg = (t) => addMsg(t, 'sys');

function showSearching() {
  hangup();
  show('call');
  $('call').classList.add('searching');
  $('partner').textContent = '';
  $('avatarEmoji').textContent = '🎧';
  setStatus('Looking for someone…');
  $('topic').textContent = '—';
  ['extendBtn', 'friendBtn', 'reportBtn'].forEach((id) => { $(id).disabled = true; $(id).classList.remove('on'); });
}

function next() {
  hangup();
  showSearching();
  notice('');
  sendMsg({ type: 'next' });
}

$('interests').addEventListener('click', (e) => {
  const b = e.target.closest('.chip'); if (!b) return;
  document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === b));
  interest = b.dataset.v;
});
$('adult').addEventListener('change', updateTalk);

$('talkBtn').addEventListener('click', async () => {
  try {
    getAudioCtx();
    await getMic();
  } catch (err) {
    alert('Microphone access is needed to talk. Allow the mic and try again.\n\n(' + err.message + ')');
    return;
  }
  showSearching();
  sendMsg({ type: 'find', interest, lang: $('lang').value });
});

$('nextBtn').addEventListener('click', next);
$('stopBtn').addEventListener('click', () => {
  hangup();
  sendMsg({ type: 'stop' });
  notice('');
  show('home');
});
$('muteBtn').addEventListener('click', () => {
  muted = !muted;
  if (localStream) localStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
  $('muteBtn').classList.toggle('on', muted);
  $('muteBtn').innerHTML = muted ? '<span>🔇</span>Unmute' : '<span>🎙️</span>Mute';
});
$('extendBtn').addEventListener('click', () => {
  sendMsg({ type: 'extend' });
  $('extendBtn').disabled = true;
  if (!$('extendBtn').classList.contains('on')) notice('Asked for +3 min… waiting for them');
});
$('friendBtn').addEventListener('click', () => {
  sendMsg({ type: 'friend' });
  $('friendBtn').disabled = true;
  if (!$('friendBtn').classList.contains('on')) notice('Friend request sent');
});
$('shuffle').addEventListener('click', () => { $('topic').textContent = pick(TOPICS_LOCAL); });

$('reportBtn').addEventListener('click', () => $('reportDlg').showModal());
$('reportDlg').addEventListener('close', () => {
  if ($('reportDlg').returnValue !== 'ok') return;
  hangup();
  showSearching();
  sendMsg({ type: 'report', reason: $('reportReason').value });
  notice('Reported. You won\'t be matched with them again.');
});

$('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = $('chatInput').value.trim();
  if (!t || !inCall) return;
  sendMsg({ type: 'chat', text: t });
  addMsg(t, 'me');
  $('chatInput').value = '';
});

connect();
