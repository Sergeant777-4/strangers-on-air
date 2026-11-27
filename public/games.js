// Mini-games played with your chat partner: tic-tac-toe and rock-paper-scissors.
// Moves are relayed through the server as {type:'game', data:{g, a, ...}}.
(function () {
  const t = (k, v) => window.I18N.t(k, v);
  let sendFn = () => {}, notify = () => {}, body = null;
  let current = 'ttt';

  const ttt = { state: 'idle', board: Array(9).fill(''), me: 'X', turn: 'X', result: '' };
  const rps = { state: 'idle', mine: '', theirs: '', score: [0, 0], last: '' };
  const HANDS = { r: '✊', p: '✋', s: '✌️' };
  const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];

  function winner(b) {
    for (const [a, c, d] of LINES) if (b[a] && b[a] === b[c] && b[a] === b[d]) return b[a];
    return b.every(Boolean) ? 'draw' : '';
  }
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const btn = (text, onClick, cls = 'ghost small') => { const b = el('button', cls, text); b.type = 'button'; b.onclick = onClick; return b; };

  function render() {
    if (!body) return;
    body.innerHTML = '';
    if (current === 'ttt') renderTTT(); else renderRPS();
  }

  function renderTTT() {
    const s = ttt;
    if (s.state === 'idle') { body.append(btn(t('invite'), () => { s.state = 'invited-out'; sendFn({ g: 'ttt', a: 'invite' }); render(); }, 'big small-big')); return; }
    if (s.state === 'invited-out') { body.append(el('p', 'game-msg', t('inviteSent'))); return; }
    if (s.state === 'invited-in') {
      body.append(el('p', 'game-msg', t('gameInvite', { game: t('ttt') })), btn(t('play'), () => { startTTT('O'); sendFn({ g: 'ttt', a: 'accept' }); }, 'big small-big'));
      return;
    }
    const info = el('p', 'game-msg', s.result ? (s.result === 'draw' ? t('draw') : s.result === s.me ? t('youWin') : t('youLose')) : s.turn === s.me ? t('yourTurn') : t('theirTurn'));
    const grid = el('div', 'ttt');
    s.board.forEach((v, i) => {
      const cell = el('button', 'cell' + (v ? ' filled ' + v.toLowerCase() : ''), v === 'X' ? '❌' : v === 'O' ? '⭕' : '');
      cell.type = 'button';
      cell.disabled = !!v || !!s.result || s.turn !== s.me;
      cell.onclick = () => { move(i, s.me); sendFn({ g: 'ttt', a: 'move', i }); };
      grid.append(cell);
    });
    body.append(info, grid);
    if (s.result) body.append(btn(t('rematch'), () => { s.state = 'invited-out'; sendFn({ g: 'ttt', a: 'invite' }); render(); }));
  }
  function startTTT(me) { Object.assign(ttt, { state: 'playing', board: Array(9).fill(''), me, turn: 'X', result: '' }); current = 'ttt'; render(); }
  function move(i, who) {
    if (ttt.board[i] || ttt.result || ttt.turn !== who) return;
    ttt.board[i] = who;
    ttt.turn = who === 'X' ? 'O' : 'X';
    ttt.result = winner(ttt.board);
    if (ttt.result === ttt.me) notify('win');
    render();
  }

  function renderRPS() {
    const s = rps;
    if (s.state === 'idle') { body.append(btn(t('invite'), () => { s.state = 'invited-out'; sendFn({ g: 'rps', a: 'invite' }); render(); }, 'big small-big')); return; }
    if (s.state === 'invited-out') { body.append(el('p', 'game-msg', t('inviteSent'))); return; }
    if (s.state === 'invited-in') {
      body.append(el('p', 'game-msg', t('gameInvite', { game: t('rps') })), btn(t('play'), () => { s.state = 'playing'; sendFn({ g: 'rps', a: 'accept' }); render(); }, 'big small-big'));
      return;
    }
    body.append(el('p', 'game-score', `${t('you')} ${s.score[0]} : ${s.score[1]}`));
    if (s.last) body.append(el('p', 'game-msg', s.last));
    if (!s.mine) {
      body.append(el('p', 'game-msg', t('pickOne')));
      const row = el('div', 'rps');
      for (const h of ['r', 'p', 's']) row.append(btn(HANDS[h], () => { s.mine = h; sendFn({ g: 'rps', a: 'pick', h }); resolveRPS(); render(); }, 'hand'));
      body.append(row);
    } else body.append(el('p', 'game-msg', `${HANDS[s.mine]} · ${t('waitingOpp')}`));
  }
  function resolveRPS() {
    const s = rps;
    if (!s.mine || !s.theirs) return;
    const beats = { r: 's', p: 'r', s: 'p' };
    let res;
    if (s.mine === s.theirs) res = t('draw');
    else if (beats[s.mine] === s.theirs) { res = t('youWin'); s.score[0]++; notify('win'); }
    else { res = t('youLose'); s.score[1]++; }
    s.last = `${HANDS[s.mine]} vs ${HANDS[s.theirs]} — ${res}`;
    s.mine = ''; s.theirs = '';
  }

  window.Games = {
    init(opts) { sendFn = opts.send; notify = opts.notify || notify; body = opts.body; render(); },
    select(g) { current = g; render(); },
    get current() { return current; },
    handle(d) {
      if (!d || typeof d !== 'object') return;
      if (d.g === 'ttt') {
        if (d.a === 'invite') { ttt.state = 'invited-in'; current = 'ttt'; notify('invite', 'ttt'); }
        else if (d.a === 'accept' && ttt.state === 'invited-out') startTTT('X');
        else if (d.a === 'move' && Number.isInteger(d.i) && d.i >= 0 && d.i < 9) move(d.i, ttt.me === 'X' ? 'O' : 'X');
      } else if (d.g === 'rps') {
        if (d.a === 'invite') { rps.state = 'invited-in'; current = 'rps'; notify('invite', 'rps'); }
        else if (d.a === 'accept' && rps.state === 'invited-out') rps.state = 'playing';
        else if (d.a === 'pick' && HANDS[d.h] && rps.state === 'playing') { rps.theirs = d.h; resolveRPS(); }
      }
      render();
    },
    reset() {
      Object.assign(ttt, { state: 'idle', board: Array(9).fill(''), me: 'X', turn: 'X', result: '' });
      Object.assign(rps, { state: 'idle', mine: '', theirs: '', score: [0, 0], last: '' });
      render();
    },
    render,
  };
})();
