import type { LocalWorld, ZoneType } from './types.ts';

export interface LocalOverlayState {
  ctx: CanvasRenderingContext2D;
  tokens: Record<string, string>;
  tileSize: number;
  zonePaintMode: ZoneType | null;
  zonePaintStart: { x: number; y: number } | null;
  zonePaintCurrent: { x: number; y: number } | null;
  spawnBreath: (x: number, y: number) => void;
}

export function drawWindowLightRays(
  state: LocalOverlayState,
  world: LocalWorld,
  view: { x0: number; y0: number; x1: number; y1: number },
) {
  const { ctx, tileSize } = state;
  const now = performance.now();
  const shimmer = 0.85 + 0.15 * Math.sin(now / 3000); // P3: slow 3s shimmer
  for (let y = view.y0; y <= view.y1; y++) {
    for (let x = view.x0; x <= view.x1; x++) {
      const tile = world.grid[y]?.[x];
      if (!tile || tile.type !== 'window') continue;

      const dirs = [
        { dx: 0, dy: 1 },
        { dx: 0, dy: -1 },
        { dx: 1, dy: 0 },
        { dx: -1, dy: 0 },
      ];
      for (const { dx, dy } of dirs) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < view.x0 || nx > view.x1 || ny < view.y0 || ny > view.y1) continue;
        const neighbor = world.grid[ny]?.[nx];
        if (!neighbor) continue;
        if (neighbor.type === 'floor' || neighbor.type === 'path') {
          const px = nx * tileSize;
          const py = ny * tileSize;
          // P3: softer gradient with warm tint and shimmer
          const grad = ctx.createLinearGradient(
            px + tileSize / 2 - dx * tileSize * 0.25,
            py + tileSize / 2 - dy * tileSize * 0.25,
            px + tileSize / 2,
            py + tileSize / 2,
          );
          grad.addColorStop(0, `rgba(255, 250, 235, ${0.22 * shimmer})`);
          grad.addColorStop(0.5, `rgba(255, 245, 230, ${0.08 * shimmer})`);
          grad.addColorStop(1, 'rgba(255, 245, 230, 0)');
          ctx.fillStyle = grad;
          ctx.fillRect(px, py, tileSize, tileSize);
        }
      }
    }
  }
}

export function drawPowerOverlay(
  state: LocalOverlayState,
  world: LocalWorld,
  view: { x0: number; y0: number; x1: number; y1: number },
) {
  const { ctx, tileSize } = state;
  const pg = world.powerGrid;
  if (!pg) return;

  ctx.save();
  ctx.globalAlpha = 0.6;

  for (const key of pg.conduits) {
    const parts = key.split(',');
    if (parts.length < 2) continue;
    const sx = Number(parts[0]);
    const sy = Number(parts[1]);
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue;
    if (sx < view.x0 || sx > view.x1 || sy < view.y0 || sy > view.y1) continue;

    const px = sx * tileSize;
    const py = sy * tileSize;
    const s = tileSize;

    ctx.strokeStyle = 'rgba(245, 158, 11, 0.8)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px + s / 2, py);
    ctx.lineTo(px + s / 2, py + s);
    ctx.moveTo(px, py + s / 2);
    ctx.lineTo(px + s, py + s / 2);
    ctx.stroke();

    ctx.fillStyle = 'rgba(245, 158, 11, 0.9)';
    ctx.beginPath();
    ctx.arc(px + s / 2, py + s / 2, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const src of pg.sources) {
    if (src.tileX < view.x0 || src.tileX > view.x1 || src.tileY < view.y0 || src.tileY > view.y1) continue;

    const px = src.tileX * tileSize;
    const py = src.tileY * tileSize;
    const s = tileSize;
    const centerX = px + s / 2;
    const centerY = py + s / 2;

    const now = performance.now();
    const pulse = 0.5 + 0.5 * Math.sin(now / 500);
    const glowR = s * 0.6 + 10 * pulse;

    const grad = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, glowR);
    grad.addColorStop(0, `rgba(245, 158, 11, ${0.4 * pulse})`);
    grad.addColorStop(1, 'rgba(245, 158, 11, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(px - glowR, py - glowR, s + 2 * glowR, s + 2 * glowR);

    ctx.fillStyle = state.tokens.amber500 || '#F59E0B';
    ctx.font = `bold 9px ${state.tokens.fontMono}`;
    ctx.textAlign = 'center';
    ctx.fillText(`${src.outputWatts}W`, centerX, py - 4);
  }

  for (const cons of pg.consumers) {
    if (cons.tileX < view.x0 || cons.tileX > view.x1 || cons.tileY < view.y0 || cons.tileY > view.y1) continue;

    const px = cons.tileX * tileSize;
    const py = cons.tileY * tileSize;
    const s = tileSize;

    const barW = s * 0.8;
    const barH = 3;
    const bx = px + (s - barW) / 2;
    const by = py + s + 2;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(bx, by, barW, barH);

    const loadPct = Math.min(1, cons.watts / 200);
    ctx.fillStyle = loadPct > 0.8 ? '#EF4444' : loadPct > 0.5 ? '#F59E0B' : '#22C55E';
    ctx.fillRect(bx, by, barW * loadPct, barH);
  }

  if (pg.generatedWatts > 0 || pg.consumedWatts > 0) {
    const statsX = view.x0 * tileSize + 10;
    const statsY = view.y0 * tileSize + 20;
    ctx.fillStyle = 'rgba(13, 13, 20, 0.9)';
    ctx.fillRect(statsX - 5, statsY - 5, 160, 50);
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.5)';
    ctx.strokeRect(statsX - 5, statsY - 5, 160, 50);

    ctx.fillStyle = '#22C55E';
    ctx.font = `11px ${state.tokens.fontMono}`;
    ctx.textAlign = 'left';
    ctx.fillText(`⚡ Gen: ${pg.generatedWatts}W`, statsX, statsY + 12);
    ctx.fillStyle = '#EF4444';
    ctx.fillText(`🔌 Con: ${pg.consumedWatts}W`, statsX, statsY + 28);
    ctx.fillStyle = pg.storedWatts > 0 ? '#3B82F6' : '#6B7280';
    ctx.fillText(`🔋 Bat: ${pg.storedWatts}W`, statsX, statsY + 44);
  }

  ctx.restore();
}

export function drawTemperatureOverlay(
  state: LocalOverlayState,
  world: LocalWorld,
  view: { x0: number; y0: number; x1: number; y1: number },
) {
  const { ctx, tileSize } = state;
  const climates = world.roomClimates;
  if (!climates) return;

  ctx.save();
  ctx.globalAlpha = 0.5;

  function tempToColor(temp: number): string {
    const comfortMin = 16, comfortMax = 26;
    if (temp <= comfortMin) {
      const t = Math.max(0, (temp + 20) / (comfortMin + 20));
      const r = Math.round(0 + t * 0);
      const g = Math.round(100 + t * 155);
      const b = 255;
      return `rgb(${r},${g},${b})`;
    } else if (temp >= comfortMax) {
      const t = Math.min(1, (temp - comfortMax) / (50 - comfortMax));
      const r = 255;
      const g = Math.round(255 * (1 - t));
      const b = 0;
      return `rgb(${r},${g},${b})`;
    } else {
      const t = (temp - comfortMin) / (comfortMax - comfortMin);
      const r = Math.round(200 * (1 - t));
      const g = 255;
      const b = Math.round(200 * (1 - t));
      return `rgb(${r},${g},${b})`;
    }
  }

  for (const [roomId, climate] of climates) {
    const room = world.rooms.find(r => r.id === roomId);
    if (!room) continue;

    const roomCenterX = (room.x + room.width / 2) * tileSize;
    const roomCenterY = (room.y + room.height / 2) * tileSize;

    if (roomCenterX < view.x0 * tileSize || roomCenterX > view.x1 * tileSize ||
        roomCenterY < view.y0 * tileSize || roomCenterY > view.y1 * tileSize) continue;

    const color = tempToColor(climate.temperature);
    
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.3;
    ctx.beginPath();
    ctx.arc(roomCenterX, roomCenterY, Math.max(room.width, room.height) * tileSize * 0.35, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.font = `bold 12px ${state.tokens.fontMono}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${climate.temperature.toFixed(1)}°C`, roomCenterX, roomCenterY);
    
    if (Math.abs(climate.temperature - climate.targetTemperature) > 0.5) {
      ctx.fillStyle = '#FBBF24';
      ctx.font = `9px ${state.tokens.fontMono}`;
      const arrow = climate.temperature < climate.targetTemperature ? '▲' : '▼';
      ctx.fillText(`${arrow} ${climate.targetTemperature.toFixed(1)}°C`, roomCenterX, roomCenterY + 18);
    }

    if (climate.temperature < 10 && Math.random() < 0.02) {
      const px = room.x * tileSize + Math.random() * room.width * tileSize;
      const py = room.y * tileSize + Math.random() * room.height * tileSize;
      state.spawnBreath(px, py);
    }
  }

  for (const [roomId, climate] of climates) {
    const room = world.rooms.find(r => r.id === roomId);
    if (!room) continue;

    for (const heater of climate.heaters) {
      if (heater.tileX < view.x0 || heater.tileX > view.x1 || heater.tileY < view.y0 || heater.tileY > view.y1) continue;
      const px = heater.tileX * tileSize;
      const py = heater.tileY * tileSize;
      const s = tileSize;
      const centerX = px + s / 2;

      const now = performance.now();
      ctx.strokeStyle = `rgba(239, 83, 80, ${0.4 + 0.3 * Math.sin(now / 120)})`;
      ctx.lineWidth = 1.5;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(centerX - 6 + i * 6, py + s);
        ctx.quadraticCurveTo(centerX + 4 * Math.sin(now / 100 + i), py + s - 8, centerX - 6 + i * 6, py + s - 16);
        ctx.stroke();
      }
    }

    for (const cooler of climate.coolers) {
      if (cooler.tileX < view.x0 || cooler.tileX > view.x1 || cooler.tileY < view.y0 || cooler.tileY > view.y1) continue;
      const px = cooler.tileX * tileSize;
      const py = cooler.tileY * tileSize;
      const s = tileSize;
      const centerX = px + s / 2;

      const now = performance.now();
      ctx.fillStyle = `rgba(100, 181, 246, ${0.4 + 0.3 * Math.sin(now / 150)})`;
      for (let i = 0; i < 4; i++) {
        const px2 = centerX + (i - 1.5) * 4;
        const py2 = py + s - 3 - (now / 80 + i * 0.5) % 10;
        ctx.beginPath();
        ctx.arc(px2, py2, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    for (const vent of climate.vents) {
      if (!vent.open) continue;
      if (vent.tileX < view.x0 || vent.tileX > view.x1 || vent.tileY < view.y0 || vent.tileY > view.y1) continue;
      const px = vent.tileX * tileSize;
      const py = vent.tileY * tileSize;
      const s = tileSize;
      const centerX = px + s / 2;
      const centerY = py + s / 2;

      ctx.fillStyle = `rgba(144, 164, 174, ${0.6 + 0.3 * Math.sin(performance.now() / 200)})`;
      ctx.font = `${s * 0.3}px ${state.tokens.fontMono}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('↔', centerX, centerY);
    }
  }

  ctx.restore();
}

export function drawZones(
  state: LocalOverlayState,
  world: LocalWorld,
  view: { x0: number; y0: number; x1: number; y1: number },
) {
  const { ctx, tileSize } = state;
  if (!world.zones) return;

  const zoneColors: Record<string, string> = {
    stockpile: '#8B5A2B',
    growing: '#4A7C2E',
    recreation: '#D4A537',
    bedroom: '#6B4F8A',
    dining: '#C46B3B',
    hospital: '#C0392B',
  };

  for (const zone of world.zones) {
    const color = zoneColors[zone.type] || '#888';
    const alpha = 0.15;

    ctx.fillStyle = `${color}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`;
    for (const tile of zone.tiles) {
      if (tile.x < view.x0 || tile.x > view.x1 || tile.y < view.y0 || tile.y > view.y1) continue;
      const px = tile.x * tileSize;
      const py = tile.y * tileSize;
      ctx.fillRect(px, py, tileSize, tileSize);
    }

    if (zone.tiles.length > 0) {
      const xs = zone.tiles.map((t: { x: number; y: number }) => t.x);
      const ys = zone.tiles.map((t: { x: number; y: number }) => t.y);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);

      const px = minX * tileSize;
      const py = minY * tileSize;
      const pw = (maxX - minX + 1) * tileSize;
      const ph = (maxY - minY + 1) * tileSize;

      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.strokeRect(px + 1, py + 1, pw - 2, ph - 2);
      ctx.setLineDash([]);

      ctx.fillStyle = color;
      ctx.font = `bold 9px ${state.tokens.fontMono}`;
      ctx.textAlign = 'left';
      ctx.fillText(zone.type.toUpperCase(), px + 3, py + 12);
    }
  }
}

export function drawZonePaintPreview(
  state: LocalOverlayState,
  view: { x0: number; y0: number; x1: number; y1: number },
) {
  const { ctx, tileSize } = state;
  if (!state.zonePaintStart || !state.zonePaintCurrent) return;

  const x0 = Math.min(state.zonePaintStart.x, state.zonePaintCurrent.x);
  const y0 = Math.min(state.zonePaintStart.y, state.zonePaintCurrent.y);
  const x1 = Math.max(state.zonePaintStart.x, state.zonePaintCurrent.x);
  const y1 = Math.max(state.zonePaintStart.y, state.zonePaintCurrent.y);

  const zoneColors: Record<string, string> = {
    stockpile: '#8B5A2B',
    growing: '#4A7C2E',
    recreation: '#D4A537',
    bedroom: '#6B4F8A',
    dining: '#C46B3B',
    hospital: '#C0392B',
  };
  const color = zoneColors[state.zonePaintMode || 'stockpile'] || '#888';

  ctx.fillStyle = `${color}33`;
  for (let y = y0; y <= y1; y++) {
    if (y < view.y0 || y > view.y1) continue;
    for (let x = x0; x <= x1; x++) {
      if (x < view.x0 || x > view.x1) continue;
      const px = x * tileSize;
      const py = y * tileSize;
      ctx.fillRect(px, py, tileSize, tileSize);
    }
  }

  const px = x0 * tileSize;
  const py = y0 * tileSize;
  const pw = (x1 - x0 + 1) * tileSize;
  const ph = (y1 - y0 + 1) * tileSize;

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 4]);
  ctx.strokeRect(px, py, pw, ph);
  ctx.setLineDash([]);

  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  ctx.fillStyle = color;
  ctx.font = `bold 10px ${state.tokens.fontMono}`;
  ctx.textAlign = 'center';
  ctx.fillText(`${w}×${h} (${w * h} tiles)`, px + pw / 2, py - 5);
}
