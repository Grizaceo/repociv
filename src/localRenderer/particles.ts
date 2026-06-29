// ─── Particles — breath, spark, zzz effects ────────────────────────────────
import {
  createParticlePool,
  spawnBreath as spawnBreathParticle,
  spawnSpark as spawnSparkParticle,
  spawnZzz as spawnZzzParticle,
  updateAndDrawParticles as updateAndDrawLocalParticles,
  type LocalParticle,
} from '../localParticles.ts';

export { createParticlePool, type LocalParticle };

export function initParticlePool(_pool: LocalParticle[], max: number): LocalParticle[] {
  return createParticlePool(max);
}

export function spawnSpark(particles: LocalParticle[], x: number, y: number, color: string): void {
  spawnSparkParticle(particles, x, y, color);
}

export function spawnZzz(particles: LocalParticle[], x: number, y: number, color: string): void {
  spawnZzzParticle(particles, x, y, color);
}

export function spawnBreath(particles: LocalParticle[], x: number, y: number): void {
  spawnBreathParticle(particles, x, y);
}

export function updateAndDrawParticles(
  ctx: CanvasRenderingContext2D,
  particles: LocalParticle[],
  dt: number,
  fontMono: string,
): void {
  updateAndDrawLocalParticles(ctx, particles, dt, fontMono);
}
