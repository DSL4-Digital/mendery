// Interactive particle logo: the M is sampled into pixels that flee the
// cursor and spring back home — a literal nod to "your file won't open,
// the words are usually still inside." Vanilla canvas, no dependencies.

const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function initLogoFx() {
  const wrap = document.querySelector('.nav-logo-wrap');
  if (!wrap || reduce) return;
  const img = wrap.querySelector('.nav-logo');
  if (!img) return;

  const start = () => {
    const rect = img.getBoundingClientRect();
    const cssW = Math.round(rect.width);
    const cssH = Math.round(rect.height);
    if (!cssW || !cssH) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = document.createElement('canvas');
    canvas.className = 'nav-logo-canvas';
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    canvas.setAttribute('aria-hidden', 'true');
    wrap.appendChild(canvas);
    wrap.classList.add('fx-on');

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // Sample the mark into particles from an offscreen render.
    const off = document.createElement('canvas');
    off.width = cssW;
    off.height = cssH;
    const octx = off.getContext('2d');
    octx.drawImage(img, 0, 0, cssW, cssH);
    const data = octx.getImageData(0, 0, cssW, cssH).data;

    const STEP = cssH > 90 ? 3 : 2;      // particle grid density
    const SIZE = STEP * 0.86;            // little pixel squares w/ gaps
    const particles = [];
    for (let y = 0; y < cssH; y += STEP) {
      for (let x = 0; x < cssW; x += STEP) {
        const a = data[(y * cssW + x) * 4 + 3];
        if (a < 110) continue;
        const i = (y * cssW + x) * 4;
        particles.push({
          hx: x, hy: y, x, y, vx: 0, vy: 0,
          c: `rgba(${data[i]},${data[i + 1]},${data[i + 2]},${(a / 255).toFixed(2)})`,
        });
      }
    }

    const pointer = { x: -999, y: -999, on: false };
    const R = Math.max(11, cssH * 0.085); // repel radius — small & precise
    const K = 0.045;                      // spring stiffness
    const FR = 0.86;                       // friction

    const move = (e) => {
      const r = canvas.getBoundingClientRect();
      const p = e.touches ? e.touches[0] : e;
      pointer.x = p.clientX - r.left;
      pointer.y = p.clientY - r.top;
      pointer.on = true;
    };
    const leave = () => { pointer.on = false; pointer.x = pointer.y = -999; };
    wrap.addEventListener('pointermove', move);
    wrap.addEventListener('pointerleave', leave);
    wrap.addEventListener('touchmove', move, { passive: true });
    wrap.addEventListener('touchend', leave);

    let raf = null, idle = 0;
    function frame() {
      ctx.clearRect(0, 0, cssW, cssH);
      let moving = false;
      for (const p of particles) {
        // spring home
        p.vx += (p.hx - p.x) * K;
        p.vy += (p.hy - p.y) * K;
        // repel from pointer
        if (pointer.on) {
          const dx = p.x - pointer.x, dy = p.y - pointer.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < R * R) {
            const d = Math.sqrt(d2) || 0.001;
            const f = (1 - d / R) * 5.5;
            p.vx += (dx / d) * f;
            p.vy += (dy / d) * f;
          }
        }
        p.vx *= FR; p.vy *= FR;
        p.x += p.vx; p.y += p.vy;
        if (Math.abs(p.vx) + Math.abs(p.vy) > 0.05) moving = true;
        ctx.fillStyle = p.c;
        ctx.fillRect(p.x - SIZE / 2, p.y - SIZE / 2, SIZE, SIZE);
      }
      // Keep running while active or settling; sleep when fully at rest.
      if (moving || pointer.on) { idle = 0; raf = requestAnimationFrame(frame); }
      else if (idle++ < 20) { raf = requestAnimationFrame(frame); }
      else { raf = null; }
    }
    const wake = () => { if (!raf) { idle = 0; raf = requestAnimationFrame(frame); } };
    wrap.addEventListener('pointerenter', wake);
    wrap.addEventListener('pointermove', wake);
    wrap.addEventListener('touchstart', wake, { passive: true });
    frame();

    // Re-sample if the logo box changes size (responsive breakpoints).
    let rt = null;
    window.addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(() => {
        if (raf) cancelAnimationFrame(raf);
        canvas.remove();
        wrap.classList.remove('fx-on');
        wrap.removeEventListener('pointermove', move);
        wrap.removeEventListener('pointerleave', leave);
        start();
      }, 200);
    }, { once: true });
  };

  if (img.complete && img.naturalWidth) start();
  else img.addEventListener('load', start, { once: true });
}

if (document.readyState !== 'loading') initLogoFx();
else document.addEventListener('DOMContentLoaded', initLogoFx);
