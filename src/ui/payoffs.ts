// ─── RepoCiv — Imperia Payoffs (Visual Storyteller + Whimsy) ──────────────────
// Canvas-based procedural celebrations. Zero assets required.

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
  rotation: number;
  rotSpeed: number;
}

/** Flash dorado sobre el canvas (screen-wide) */
export function flashGlory(canvas: HTMLCanvasElement, intensity = 0.35) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  let alpha = intensity;
  function frame() {
    if (!ctx) return;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = `rgba(245, 213, 128, ${alpha})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    alpha -= 0.012;
    if (alpha > 0) requestAnimationFrame(frame);
  }
  frame();
}

/** Explosión dorada de partículas (confeti imperial) */
export function confettiBurst(canvas: HTMLCanvasElement, cx: number, cy: number) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const colors = [
    'oklch(0.85 0.18 85)',
    'oklch(0.72 0.14 78)',
    'oklch(0.88 0.18 98)',
    '#fff',
    'oklch(0.72 0.19 140)',
    'oklch(0.58 0.22 250)',
  ];
  const particles: Particle[] = Array.from({ length: 60 }).map(() => ({
    x: cx,
    y: cy,
    vx: (Math.random() - 0.5) * 10,
    vy: (Math.random() - 0.5) * 10 - 3,
    life: 1,
    maxLife: 60 + Math.random() * 40,
    color: colors[Math.floor(Math.random() * colors.length)]!,
    size: 2 + Math.random() * 3,
    rotation: Math.random() * Math.PI * 2,
    rotSpeed: (Math.random() - 0.5) * 0.2,
  }));

  function frame() {
    if (!ctx) return;
    // No clear — additive effect to canvas
    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.15; // gravity
      p.vx *= 0.96; // drag
      p.life -= 1 / p.maxLife;
      p.rotation += p.rotSpeed;
    }
    for (const p of particles) {
      if (p.life <= 0) continue;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.globalAlpha = p.life;
      ctx.fillStyle = p.color;
      // Hexagon mini shape
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const angle = (i * 60 * Math.PI) / 180;
        const px = Math.cos(angle) * p.size;
        const py = Math.sin(angle) * p.size;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    const alive = particles.some((p) => p.life > 0);
    if (alive) requestAnimationFrame(frame);
  }
  frame();
}

/** Sonido procedural (fanfarria imperial) */
export function hornSound() {
  try {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const now = ctx.currentTime;
    // chord
    [392.0, 493.88, 587.33, 783.99].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = i === 0 ? 'sawtooth' : i === 1 ? 'square' : 'sine';
      osc.frequency.setValueAtTime(freq, now);
      gain.gain.setValueAtTime(0.04, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.2 + i * 0.15);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 2);
    });
  } catch {
    /* audio blocked */
  }
}

/** Pan de cámara suave hacia una coordenada hex (renderer hook) */
export function panCameraTo(
  renderer: { panTo: (x: number, y: number) => void } | null,
  worldX: number,
  worldY: number,
) {
  if (!renderer) return;
  renderer.panTo(worldX, worldY);
}

/** Complete mission celebration pipeline */
export function celebrateMission(
  canvas: HTMLCanvasElement,
  renderer: { panTo: (x: number, y: number) => void } | null,
  worldPos: { x: number; y: number },
) {
  flashGlory(canvas, 0.35);
  confettiBurst(canvas, canvas.width / 2, canvas.height / 2);
  hornSound();
  panCameraTo(renderer, worldPos.x, worldPos.y);
}

/** City discovered celebration */
export function celebrateDiscovery(canvas: HTMLCanvasElement, screenX: number, screenY: number) {
  flashGlory(canvas, 0.2);
  confettiBurst(canvas, screenX, screenY);
  hornSound();
}
