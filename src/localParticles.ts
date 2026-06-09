export interface LocalParticle {
  active: boolean;
  type: 'spark' | 'zzz';
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  size: number;
  life: number;
  maxLife: number;
  char?: string;
  baseX: number;
}

export function createParticlePool(maxParticles: number): LocalParticle[] {
  const particles: LocalParticle[] = [];
  for (let i = 0; i < maxParticles; i++) {
    particles.push({
      active: false,
      type: 'spark',
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      color: '#000',
      size: 0,
      life: 0,
      maxLife: 0,
      baseX: 0,
    });
  }
  return particles;
}

export function spawnSpark(particles: LocalParticle[], x: number, y: number, color: string): void {
  const p = particles.find((part) => !part.active);
  if (!p) return;

  p.active = true;
  p.type = 'spark';
  p.x = x;
  p.y = y;
  p.baseX = x;
  p.vx = (Math.random() - 0.5) * 12;
  p.vy = -15 - Math.random() * 20;
  p.color = color;
  p.size = 1.5 + Math.random() * 2;
  p.life = 0;
  p.maxLife = 0.6 + Math.random() * 0.4;
}

export function spawnZzz(particles: LocalParticle[], x: number, y: number, color: string): void {
  const p = particles.find((part) => !part.active);
  if (!p) return;

  p.active = true;
  p.type = 'zzz';
  p.x = x;
  p.y = y;
  p.baseX = x;
  p.vx = 8 + Math.random() * 8;
  p.vy = -10 - Math.random() * 10;
  p.color = color;
  p.size = 7 + Math.random() * 4;
  p.life = 0;
  p.maxLife = 1.2 + Math.random() * 0.8;
  p.char = Math.random() > 0.5 ? 'z' : 'Z';
}

export function spawnBreath(particles: LocalParticle[], x: number, y: number): void {
  const p = particles.find((part) => !part.active);
  if (!p) return;

  p.active = true;
  p.type = 'zzz';
  p.x = x;
  p.y = y;
  p.baseX = x;
  p.vx = (Math.random() - 0.5) * 10;
  p.vy = -8 - Math.random() * 8;
  p.color = 'rgba(200, 230, 255, 0.7)';
  p.size = 6 + Math.random() * 4;
  p.life = 0;
  p.maxLife = 1.5 + Math.random() * 1.0;
  p.char = '∼';
}

export function updateAndDrawParticles(
  ctx: CanvasRenderingContext2D,
  particles: LocalParticle[],
  dt: number,
  fontMono: string,
): void {
  for (const p of particles) {
    if (!p.active) continue;

    p.life += dt;
    if (p.life >= p.maxLife) {
      p.active = false;
      continue;
    }

    p.baseX += p.vx * dt;
    p.y += p.vy * dt;

    if (p.type === 'spark') {
      p.x = p.baseX + Math.sin(p.life * 10) * 4;

      const alpha = Math.max(0, 1 - p.life / p.maxLife);
      ctx.save();
      ctx.fillStyle = p.color;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else {
      p.x = p.baseX + Math.sin(p.life * 4) * 5;

      const alpha = Math.max(0, (1 - p.life / p.maxLife) * 0.6);
      ctx.save();
      ctx.fillStyle = p.color;
      ctx.globalAlpha = alpha;
      ctx.font = `${p.size}px ${fontMono}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.char || 'Z', p.x, p.y);
      ctx.restore();
    }
  }
}
