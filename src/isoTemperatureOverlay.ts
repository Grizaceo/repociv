import type { LocalRoom, RoomClimate } from './types.ts';
import { ISO_TILE_W, ISO_TILE_H, isoProject } from './isoGeometry.ts';
import { monoFont } from './isoRenderStyle.ts';

interface IsoTemperatureOverlayState {
  ctx: CanvasRenderingContext2D;
  tokens: Record<string, string>;
  spawnBreath: (x: number, y: number) => void;
}

interface IsoTemperatureWorld {
  rooms: Pick<LocalRoom, 'id' | 'x' | 'y' | 'width' | 'height'>[];
  roomClimates?: Map<string, RoomClimate>;
}

export function drawIsoTemperatureOverlay(
  state: IsoTemperatureOverlayState,
  world: IsoTemperatureWorld,
  view: { x0: number; y0: number; x1: number; y1: number },
) {
  const { ctx } = state;
  const climates = world.roomClimates;
  if (!climates) return;
  ctx.save();
  ctx.globalAlpha = 0.5;

  function tempToColor(temp: number): string {
    const comfortMin = 16,
      comfortMax = 26;
    if (temp <= comfortMin)
      return `rgb(80, ${Math.round(100 + ((temp + 20) / (comfortMin + 20)) * 155)}, 220)`;
    if (temp >= comfortMax)
      return `rgb(220, ${Math.round(255 * (1 - Math.min(1, (temp - comfortMax) / (50 - comfortMax))))}, 0)`;
    const t = (temp - comfortMin) / (comfortMax - comfortMin);
    return `rgb(${Math.round(200 * (1 - t))}, 255, ${Math.round(200 * (1 - t))}`;
  }

  for (const [roomId, climate] of climates) {
    const room = world.rooms.find((r) => r.id === roomId);
    if (!room) continue;
    const cx = room.x + room.width / 2;
    const cy = room.y + room.height / 2;
    const base = isoProject(cx, cy);
    if (cx < view.x0 || cx > view.x1 || cy < view.y0 || cy > view.y1) continue;

    const color = tempToColor(climate.temperature);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.3;
    ctx.beginPath();
    ctx.arc(base.px, base.py, Math.max(room.width, room.height) * ISO_TILE_W * 0.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.font = `bold 12px ${monoFont(state)}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${climate.temperature.toFixed(1)}°C`, base.px, base.py);

    if (Math.abs(climate.temperature - climate.targetTemperature) > 0.5) {
      ctx.fillStyle = '#FBBF24';
      ctx.font = `9px ${monoFont(state)}`;
      const arrow = climate.temperature < climate.targetTemperature ? '▲' : '▼';
      ctx.fillText(`${arrow} ${climate.targetTemperature.toFixed(1)}°C`, base.px, base.py + 18);
    }

    if (climate.temperature < 10 && Math.random() < 0.02) {
      const rx = room.x + Math.random() * room.width;
      const ry = room.y + Math.random() * room.height;
      const p = isoProject(rx, ry);
      state.spawnBreath(p.px, p.py);
    }
  }

  for (const [roomId, climate] of climates) {
    const room = world.rooms.find((r) => r.id === roomId);
    if (!room) continue;
    for (const heater of climate.heaters) {
      if (
        heater.tileX < view.x0 ||
        heater.tileX > view.x1 ||
        heater.tileY < view.y0 ||
        heater.tileY > view.y1
      )
        continue;
      const base = isoProject(heater.tileX, heater.tileY);
      const now = performance.now();
      ctx.strokeStyle = `rgba(239, 83, 80, ${0.4 + 0.3 * Math.sin(now / 120)})`;
      ctx.lineWidth = 1.5;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(base.px - 6 + i * 6, base.py + ISO_TILE_H / 2);
        ctx.quadraticCurveTo(
          base.px + 4 * Math.sin(now / 100 + i),
          base.py + ISO_TILE_H / 2 - 8,
          base.px - 6 + i * 6,
          base.py + ISO_TILE_H / 2 - 16,
        );
        ctx.stroke();
      }
    }
    for (const cooler of climate.coolers) {
      if (
        cooler.tileX < view.x0 ||
        cooler.tileX > view.x1 ||
        cooler.tileY < view.y0 ||
        cooler.tileY > view.y1
      )
        continue;
      const base = isoProject(cooler.tileX, cooler.tileY);
      const now = performance.now();
      ctx.fillStyle = `rgba(100, 181, 246, ${0.4 + 0.3 * Math.sin(now / 150)})`;
      for (let i = 0; i < 4; i++) {
        const px2 = base.px + (i - 1.5) * 4;
        const py2 = base.py + ISO_TILE_H / 2 - 3 - ((now / 80 + i * 0.5) % 10);
        ctx.beginPath();
        ctx.arc(px2, py2, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    for (const vent of climate.vents) {
      if (!vent.open) continue;
      if (
        vent.tileX < view.x0 ||
        vent.tileX > view.x1 ||
        vent.tileY < view.y0 ||
        vent.tileY > view.y1
      )
        continue;
      const base = isoProject(vent.tileX, vent.tileY);
      ctx.fillStyle = `rgba(144, 164, 174, ${0.6 + 0.3 * Math.sin(performance.now() / 200)})`;
      ctx.font = `${ISO_TILE_W * 0.18}px ${monoFont(state)}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('↔', base.px, base.py);
    }
  }

  ctx.restore();
}
