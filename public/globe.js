// 3D globes drawn on canvas (no libraries).
// - Background globe (#globe): faint dotted sphere; Globe.setMode('idle'|'search'|'call') changes speed/arcs.
// - Hero globe (#heroGlobe): lit sphere with atmosphere, tilted orbit rings, people orbiting in 3D
//   (they pass behind the planet), and glowing connection arcs between them.
(function () {
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const css = (name, fb) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;
  const hexToRgb = (h) => {
    const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(h || '');
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [139, 67, 255];
  };

  function fibSphere(n) {
    const pts = [], golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
      const y = 1 - (i / (n - 1)) * 2, r = Math.sqrt(1 - y * y), t = golden * i;
      pts.push({ x: Math.cos(t) * r, y, z: Math.sin(t) * r, live: Math.random() < 0.06, phase: Math.random() * 6.28 });
    }
    return pts;
  }

  function createGlobe(canvas, opts) {
    const o = Object.assign({ fit: 'viewport', dots: 520, hero: false }, opts);
    const ctx = canvas.getContext('2d');
    const pts = fibSphere(o.dots);
    const live = pts.map((p, i) => (p.live ? i : -1)).filter((i) => i >= 0);
    const PEOPLE = ['🦊', '🐼', '🦉', '🐬', '🦁', '🐙'];
    const people = PEOPLE.map((e, i) => ({ e, a: (i / PEOPLE.length) * Math.PI * 2, ring: i % 2 }));
    let W = 0, H = 0, R = 0, cx = 0, cy = 0, angle = 0, speed = 0.0022, target = 0.0022, mode = 'idle';
    let arcs = [], mouseX = 0, mouseY = 0, tiltX = 0.35, tiltY = 0, visible = true, colors = {}, frameN = 0;

    function readColors() {
      colors = { purple: hexToRgb(css('--accent', '#8b43ff')), cyan: hexToRgb(css('--teal', '#13c9ed')), ink: hexToRgb(css('--ink', '#f7f7ff')), dark: document.documentElement.dataset.theme !== 'light' };
    }
    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (o.fit === 'parent') { const r = canvas.parentElement.getBoundingClientRect(); W = r.width; H = r.height; }
      else { W = window.innerWidth; H = window.innerHeight; }
      canvas.width = W * dpr; canvas.height = H * dpr;
      canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (o.hero) { R = Math.min(W, H) * 0.26; cx = W / 2; cy = H * 0.46; }
      else { R = Math.min(W, H) * (W < 700 ? 0.55 : 0.42); cx = W < 700 ? W * 0.5 : W * 0.8; cy = W < 700 ? H * 0.95 : H * 0.6; }
    }
    function rot(p, extraY = 0) {
      const ca = Math.cos(angle + tiltY + extraY), sa = Math.sin(angle + tiltY + extraY);
      let x = p.x * ca - p.z * sa, z = p.x * sa + p.z * ca;
      const ct = Math.cos(tiltX), st = Math.sin(tiltX);
      const y = p.y * ct - z * st; z = p.y * st + z * ct;
      return { x, y, z };
    }
    function proj(v) { const f = 2.8 / (2.8 + v.z); return { x: cx + v.x * R * f, y: cy + v.y * R * f, z: v.z, f }; }
    const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

    function newArc() {
      const a = live[Math.floor(Math.random() * live.length)];
      let b = a; while (b === a) b = live[Math.floor(Math.random() * live.length)];
      return { a, b, t: 0, speed: 0.006 + Math.random() * 0.006 };
    }
    function arcPoint(A, B, k) {
      let x = A.x + (B.x - A.x) * k, y = A.y + (B.y - A.y) * k, z = A.z + (B.z - A.z) * k;
      const len = Math.hypot(x, y, z) || 1, lift = 1 + 0.32 * Math.sin(Math.PI * k);
      return proj(rot({ x: (x / len) * lift, y: (y / len) * lift, z: (z / len) * lift }));
    }
    function drawArc(arc) {
      const A = pts[arc.a], B = pts[arc.b], head = Math.min(arc.t, 1), tail = Math.max(0, arc.t - 0.55);
      let prev = null;
      ctx.lineWidth = o.hero ? 2.2 : 1.8; ctx.lineCap = 'round';
      for (let s = Math.floor(tail * 40); s <= head * 40; s++) {
        const k = s / 40, q = arcPoint(A, B, k);
        if (prev) {
          const mix = k; const c = [0, 1, 2].map((i) => Math.round(colors.purple[i] * (1 - mix) + colors.cyan[i] * mix));
          ctx.strokeStyle = rgba(c, (0.25 + 0.7 * (k - tail) / Math.max(0.01, head - tail)) * (q.z < 0.2 ? 1 : 0.35));
          ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(q.x, q.y); ctx.stroke();
        }
        prev = q;
      }
      if (prev && arc.t <= 1) {
        ctx.fillStyle = rgba(colors.cyan, 1); ctx.shadowColor = rgba(colors.cyan, 1); ctx.shadowBlur = 12;
        ctx.beginPath(); ctx.arc(prev.x, prev.y, o.hero ? 3.6 : 3, 0, 6.283); ctx.fill(); ctx.shadowBlur = 0;
      }
    }
    // tilted orbit ring points (3D circle around the sphere)
    function ringPoint(ring, a) {
      const r = ring ? 1.5 : 1.32, inc = ring ? -0.45 : 0.4;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const y = z * Math.sin(inc), z2 = z * Math.cos(inc);
      const ct = Math.cos(tiltX * 0.6), st = Math.sin(tiltX * 0.6);
      return proj({ x, y: y * ct - z2 * st, z: y * st + z2 * ct });
    }
    function drawRing(ring, front) {
      ctx.lineWidth = 1.2; ctx.setLineDash([4, 6]);
      ctx.strokeStyle = rgba(ring ? colors.cyan : colors.purple, front ? 0.55 : 0.18);
      ctx.beginPath();
      let started = false;
      for (let s = 0; s <= 120; s++) {
        const p = ringPoint(ring, (s / 120) * Math.PI * 2);
        if ((p.z < 0) === front) { if (!started) { ctx.moveTo(p.x, p.y); started = true; } else ctx.lineTo(p.x, p.y); }
        else started = false;
      }
      ctx.stroke(); ctx.setLineDash([]);
    }
    function drawPerson(p, pos) {
      const s = (o.hero ? 30 : 20) * pos.f;
      const g = ctx.createLinearGradient(pos.x - s, pos.y - s, pos.x + s, pos.y + s);
      g.addColorStop(0, rgba(colors.purple, 0.95)); g.addColorStop(1, rgba(colors.cyan, 0.95));
      ctx.globalAlpha = pos.z < 0 ? 1 : 0.45;
      ctx.shadowColor = rgba(colors.purple, 0.8); ctx.shadowBlur = 18 * pos.f;
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(pos.x, pos.y, s, 0, 6.283); ctx.fill(); ctx.shadowBlur = 0;
      ctx.fillStyle = colors.dark ? '#0d1028' : '#ffffff';
      ctx.beginPath(); ctx.arc(pos.x, pos.y, s - 3, 0, 6.283); ctx.fill();
      ctx.font = `${Math.round(s * 1.15)}px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(p.e, pos.x, pos.y + s * 0.06);
      ctx.fillStyle = '#25dc8a'; ctx.beginPath(); ctx.arc(pos.x + s * 0.7, pos.y + s * 0.7, s * 0.22, 0, 6.283); ctx.fill();
      ctx.globalAlpha = 1;
    }

    function frame(time) {
      requestAnimationFrame(frame);
      if (!visible || document.hidden) return;
      if (frameN++ % 90 === 0) readColors();
      speed += (target - speed) * 0.04;
      if (!reduceMotion) angle += speed;
      tiltY += (mouseX * 0.3 - tiltY) * 0.03;
      tiltX += (0.35 + mouseY * 0.18 - tiltX) * 0.03;
      ctx.clearRect(0, 0, W, H);

      // atmosphere glow
      const halo = ctx.createRadialGradient(cx, cy, R * 0.85, cx, cy, R * (o.hero ? 1.55 : 1.3));
      halo.addColorStop(0, rgba(colors.cyan, o.hero ? 0.35 : 0.12)); halo.addColorStop(0.45, rgba(colors.purple, o.hero ? 0.16 : 0.06)); halo.addColorStop(1, rgba(colors.purple, 0));
      ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(cx, cy, R * 1.6, 0, 6.283); ctx.fill();

      if (o.hero) {
        drawRing(0, false); drawRing(1, false);
        for (const p of people) { const pos = ringPoint(p.ring, p.a); if (pos.z >= 0) drawPerson(p, pos); }
        // lit planet body
        const body = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.1, cx, cy, R);
        body.addColorStop(0, colors.dark ? '#5fd8ff' : '#9fe8ff'); body.addColorStop(0.35, colors.dark ? '#1d6fe0' : '#5b8cff');
        body.addColorStop(0.75, colors.dark ? '#1a1060' : '#5a3fd6'); body.addColorStop(1, colors.dark ? '#070a2a' : '#2b1b7a');
        ctx.shadowColor = rgba(colors.cyan, 0.8); ctx.shadowBlur = 40;
        ctx.fillStyle = body; ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.283); ctx.fill(); ctx.shadowBlur = 0;
        ctx.strokeStyle = rgba(colors.cyan, 0.75); ctx.lineWidth = 1.5; ctx.stroke();
      }

      // dots
      const P = pts.map((p) => proj(rot(p)));
      for (let i = 0; i < P.length; i++) {
        const p = P[i], front = (1 - p.z) / 2;
        if (o.hero && p.z > 0.05) continue; // hidden behind the lit body
        if (pts[i].live) {
          const blink = 0.55 + 0.45 * Math.sin(time / 380 + pts[i].phase);
          ctx.fillStyle = rgba(colors.cyan, (0.3 + 0.7 * front) * blink);
          ctx.beginPath(); ctx.arc(p.x, p.y, (o.hero ? 2.8 : 2.4) * p.f + 0.5, 0, 6.283); ctx.fill();
        } else {
          ctx.fillStyle = o.hero ? `rgba(200,240,255,${0.15 + 0.5 * front})` : rgba(colors.ink, 0.04 + 0.22 * front);
          ctx.beginPath(); ctx.arc(p.x, p.y, (o.hero ? 1.3 : 1.15) * p.f, 0, 6.283); ctx.fill();
        }
      }

      // arcs
      const wantArcs = o.hero ? 3 : mode === 'idle' ? 0 : 1;
      while (arcs.length < wantArcs) arcs.push(newArc());
      arcs = arcs.slice(0, wantArcs);
      arcs.forEach((a, i) => { a.t += mode === 'search' ? a.speed * 2 : a.speed; if (a.t > 1.6) arcs[i] = newArc(); drawArc(a); });

      if (o.hero) {
        // highlight sheen for a 3D look
        const sheen = ctx.createRadialGradient(cx - R * 0.45, cy - R * 0.5, 0, cx - R * 0.45, cy - R * 0.5, R * 0.9);
        sheen.addColorStop(0, 'rgba(255,255,255,.28)'); sheen.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = sheen; ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.283); ctx.fill();
        drawRing(0, true); drawRing(1, true);
        for (const p of people) {
          if (!reduceMotion) p.a += p.ring ? -0.0035 : 0.0045;
          const pos = ringPoint(p.ring, p.a); if (pos.z < 0) drawPerson(p, pos);
        }
      }
    }

    window.addEventListener('resize', resize);
    window.addEventListener('pointermove', (e) => { mouseX = (e.clientX / window.innerWidth - 0.5) * 2; mouseY = (e.clientY / window.innerHeight - 0.5) * 2; });
    if ('IntersectionObserver' in window) new IntersectionObserver((es) => { visible = es[0].isIntersecting; }).observe(canvas);
    readColors(); resize(); requestAnimationFrame(frame);
    if (o.fit === 'parent' && 'ResizeObserver' in window) new ResizeObserver(resize).observe(canvas.parentElement);

    return {
      setMode(m) { mode = m; target = m === 'search' ? 0.012 : m === 'call' ? 0.003 : 0.0022; arcs = []; },
      refresh: readColors,
    };
  }

  const bg = document.getElementById('globe');
  if (bg) window.Globe = createGlobe(bg, { fit: 'viewport' });
  const hero = document.getElementById('heroGlobe');
  if (hero) window.HeroGlobe = createGlobe(hero, { fit: 'parent', hero: true, dots: 700 });
})();
