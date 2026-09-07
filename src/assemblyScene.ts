// ─── RepoCiv — Asamblea ESCENA (Bot Mode room embed, overlay) ────────────────
// Render real de la asamblea como escena estilo "Among Us emergency meeting":
// los bots del roster sentados en mesa circular, cada uno con su identidad real
// (pet spritesheet / face avatar) recortada, y burbujas de texto flotando sobre
// el que habló — leídas en vivo desde GET /api/rooms/{name}/messages.
//
// Es un OVERLAY sobre el canvas del mapa (#main-canvas), no un panel DOM — esto
// arregla por construcción el bug de z-index que tenía el panel anterior.
//
// SECURITY / SEPARATION CONTRACT (enforced, not by faith):
//   - READ-ONLY on the roster (avatarClient.ts → GET /api/roster). Nunca importa
//     agentProfile.ts (CRUD: upsert_profile/delete_profile/saveIdentity).
//   - Enviar mensaje es PARTICIPACIÓN, no reconfiguración: solo POST /api/rooms,
//     que shell-out al CLI hermes bot-chat y NUNCA escribe profile.yaml/memberships.
//   - from_bot SIEMPRE un bot real del roster (nunca vacío) — aísla el bug
//     "user" muerto server-side; el bridge ya 400 en vacío de todas formas.
//   - Burbujas con fillText (texto plano sobre canvas). NUNCA innerHTML para el
//     contenido del bot → candado #1 red-team (XSS-safe). El texto del bot puede
//     ser malicioso; se dibuja como string, no se inyecta al DOM.
//   - Identidad solo desde el roster (avatar_kind pet/face/asset/null). Cero
//     lectura de profile.yaml/config.yaml/leveldb de Windows (candado #3).
import { bridgeUrl, bridgeHeaders } from './bridgeEnv.ts';
import {
  getRosterMap,
  getAvatarImage,
  resolveBotIdentity,
  invalidateRosterCache,
  type RosterEntry,
  type BotIdentity,
} from './avatarClient.ts';

// ─── Estado de la escena ──────────────────────────────────────────────────────
let sceneCanvas: HTMLCanvasElement | null = null;
let sceneCtx: CanvasRenderingContext2D | null = null;
let composerEl: HTMLElement | null = null;
let active = false;
let currentRoom = 'asamblea';
let speakingAs: string | null = null;
let rosterEntries: RosterEntry[] = [];
let identities: BotIdentity[] = [];
let pollTimer: number | null = null;
let resizeObserver: ResizeObserver | null = null;
let dpr = 1;

interface Bubble {
  botName: string;
  text: string;
  born: number;
  ttl: number;
}

// Burbujas activas: clave = botName (una por bot; la más reciente reemplaza).
const bubbles = new Map<string, Bubble>();

// ─── Montaje del overlay ───────────────────────────────────────────────────────
function ensureMounted(): void {
  if (sceneCanvas) return;
  const base = document.getElementById('main-canvas');
  const parent = (base?.parentElement ??
    document.getElementById('app') ??
    document.body) as HTMLElement;

  sceneCanvas = document.createElement('canvas');
  sceneCanvas.id = 'assembly-scene';
  sceneCanvas.className = 'assembly-scene hidden';
  parent.appendChild(sceneCanvas);
  sceneCtx = sceneCanvas.getContext('2d');

  composerEl = document.createElement('div');
  composerEl.id = 'assembly-composer';
  composerEl.className = 'assembly-composer hidden';
  composerEl.innerHTML = `
    <div class="assembly-bar">
      <span class="assembly-title">🏛 Asamblea</span>
      <select id="assembly-room-select" class="assembly-room-select" title="Sala de Bot Mode"></select>
      <select id="assembly-speak-as" class="assembly-speak-as" title="Hablar como"></select>
      <button id="assembly-close" class="assembly-close" title="Cerrar">×</button>
    </div>
    <div class="assembly-composer-row">
      <textarea id="assembly-input" class="assembly-input" placeholder="Mensaje a la sala (participación, no edición de perfiles)…" rows="1"></textarea>
      <button id="assembly-send" class="assembly-send">Enviar</button>
    </div>`;
  parent.appendChild(composerEl);

  // Resize del overlay para coincidir con el canvas base (DPR incluido).
  resizeObserver = new ResizeObserver(() => sizeOverlay());
  if (base) resizeObserver.observe(base);
  window.addEventListener('resize', sizeOverlay);
  sizeOverlay();

  // Eventos del composer.
  composerEl
    .querySelector('#assembly-close')
    ?.addEventListener('click', () => void toggleAssemblyRoom());
  composerEl
    .querySelector('#assembly-send')
    ?.addEventListener('click', () => void sendFromComposer());
  composerEl
    .querySelector<HTMLTextAreaElement>('#assembly-input')
    ?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void sendFromComposer();
      }
    });
  composerEl
    .querySelector<HTMLSelectElement>('#assembly-room-select')
    ?.addEventListener('change', (e) => {
      currentRoom = (e.target as HTMLSelectElement).value || 'asamblea';
      bubbles.clear();
      void pollRoom();
    });
}

function sizeOverlay(): void {
  if (!sceneCanvas) return;
  const base = document.getElementById('main-canvas') as HTMLCanvasElement | null;
  const rect = base?.getBoundingClientRect();
  const w = rect?.width ?? window.innerWidth;
  const h = rect?.height ?? window.innerHeight;
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  sceneCanvas.style.width = `${w}px`;
  sceneCanvas.style.height = `${h}px`;
  sceneCanvas.width = Math.round(w * dpr);
  sceneCanvas.height = Math.round(h * dpr);
  if (sceneCtx) sceneCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// ─── Carga de roster + identidad ───────────────────────────────────────────────
async function loadRoster(): Promise<void> {
  const map = await getRosterMap();
  rosterEntries = Array.from(map.values());
  identities = rosterEntries.map((e) => resolveBotIdentity(e));

  const speakSel = composerEl?.querySelector<HTMLSelectElement>('#assembly-speak-as');
  if (speakSel) {
    speakSel.innerHTML = rosterEntries
      .map(
        (b) =>
          `<option value="${escapeAttr(b.name)}">${escapeHtml(b.name)}${b.is_bot ? '' : ' (humano)'}</option>`,
      )
      .join('');
    const firstBot = rosterEntries.find((b) => b.is_bot) ?? rosterEntries[0];
    speakingAs = firstBot?.name ?? null;
    if (speakingAs) speakSel.value = speakingAs;
  }
  const roomSel = composerEl?.querySelector<HTMLSelectElement>('#assembly-room-select');
  if (roomSel && roomSel.options.length === 0) {
    roomSel.innerHTML = `<option value="asamblea">asamblea</option>`;
  }
}

// ─── Polling de mensajes (burbujas) ────────────────────────────────────────────
async function pollRoom(): Promise<void> {
  try {
    const resp = await fetch(bridgeUrl(`/api/rooms/${encodeURIComponent(currentRoom)}/messages`), {
      headers: bridgeHeaders(),
    });
    if (!resp.ok) return;
    const data = (await resp.json()) as { room?: string; messages?: RoomMessage[] };
    for (const m of data.messages ?? []) {
      const who = m.from || '';
      const text = m.response || m.text || '';
      if (!who || !text) continue;
      bubbles.set(who, { botName: who, text, born: Date.now(), ttl: 12000 });
    }
  } catch {
    /* red silenciosa: la escena sigue viva con las burbujas previas */
  }
}

interface RoomMessage {
  ts: number;
  room: string;
  from: string;
  text: string;
  response: string;
}

// ─── Render de la escena ───────────────────────────────────────────────────────
function drawScene(): void {
  if (!sceneCtx || !sceneCanvas || !active) return;
  const ctx = sceneCtx;
  const W = sceneCanvas.width / dpr;
  const H = sceneCanvas.height / dpr;
  ctx.clearRect(0, 0, W, H);

  // Fondo tenue para distinguir la asamblea del mapa subyacente.
  ctx.fillStyle = 'rgba(8,11,16,0.72)';
  ctx.fillRect(0, 0, W, H);

  const cx = W / 2;
  const cy = H / 2 + 8;

  // Mesa circular.
  const tableRx = Math.min(W, H) * 0.16;
  const tableRy = tableRx * 0.78;
  ctx.beginPath();
  ctx.ellipse(cx, cy, tableRx, tableRy, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#223043';
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#33445a';
  ctx.stroke();

  // Botón EMERGENCY.
  ctx.beginPath();
  ctx.arc(cx, cy, 22, 0, Math.PI * 2);
  ctx.fillStyle = '#c2363f';
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = '700 12px system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('!', cx, cy + 1);

  const n = identities.length || 1;
  const R = Math.min(W, H) * 0.28;
  identities.forEach((ident, i) => {
    const ang = -Math.PI / 2 + (i / n) * Math.PI * 2;
    const px = cx + Math.cos(ang) * R;
    const py = cy + Math.sin(ang) * R * 0.86;
    const r = 36;
    drawBean(ctx, px, py, r, ident);

    // Label (fillText plano, XSS-safe).
    const label = ident.label || rosterEntries[i]?.name || '';
    ctx.fillStyle = '#c9d4e3';
    ctx.font = '700 11px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(label, px, py + r * 0.95 + 6);

    // Burbuja del bot que habló (fillText plano).
    const bub = bubbles.get(rosterEntries[i]?.name ?? '');
    if (bub) {
      const age = Date.now() - bub.born;
      if (age > bub.ttl) {
        bubbles.delete(bub.botName);
      } else {
        drawBubble(ctx, px, py - r, bub.text);
      }
    }
  });

  // Título.
  ctx.fillStyle = '#e7eef7';
  ctx.font = '700 18px system-ui';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('ASAMBLEA · Bot Mode', 18, 16);
}

/** Bean estilo Among Us con el retrato recortado (identidad real). */
function drawBean(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  ident: BotIdentity,
): void {
  const bodyColor = ident.kind === null ? '#8b98a9' : '#5b6b7d';
  // Anillo distintivo para bots con pet real.
  if (ident.kind === 'pet') {
    ctx.beginPath();
    ctx.arc(x, y, r + 4, 0, Math.PI * 2);
    ctx.strokeStyle = '#ffd34d';
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  // Cuerpo bean.
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(x, y + r * 0.15, r * 0.82, r, 0, 0, Math.PI * 2);
  ctx.fillStyle = bodyColor;
  ctx.fill();
  ctx.restore();

  // Visor.
  ctx.beginPath();
  ctx.ellipse(x + r * 0.18, y - r * 0.18, r * 0.42, r * 0.34, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#0d1117';
  ctx.fill();

  // Retrato recortado dentro del visor (pet/face real, o glyph).
  const img = ident.imageUrl ? getAvatarImage(ident.imageUrl) : null;
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(x + r * 0.18, y - r * 0.18, r * 0.42, r * 0.34, 0, 0, Math.PI * 2);
  ctx.clip();
  if (img) {
    ctx.drawImage(img, x + r * 0.18 - r * 0.42, y - r * 0.18 - r * 0.34, r * 0.84, r * 0.68);
  } else {
    // Glyph de respaldo (inicial) — texto plano.
    ctx.fillStyle = '#c9d4e3';
    ctx.font = `700 ${Math.round(r * 0.5)}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((ident.label || '?')[0]?.toUpperCase() ?? '?', x + r * 0.18, y - r * 0.18);
  }
  ctx.restore();
}

/** Burbuja de texto con fillText (texto plano, SIN innerHTML). */
function drawBubble(ctx: CanvasRenderingContext2D, cx: number, cy: number, text: string): void {
  ctx.save();
  ctx.font = "600 13px 'Trebuchet MS', system-ui, sans-serif";
  const maxW = 220;
  const padX = 10;
  const padY = 7;
  const lineH = 17;
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (ctx.measureText(test).width > maxW && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  const bw = Math.min(maxW, Math.max(...lines.map((l) => ctx.measureText(l).width))) + padX * 2;
  const bh = lines.length * lineH + padY * 2;
  let bx = cx - bw / 2;
  let by = cy - bh - 6;
  bx = Math.max(8, Math.min(bx, ctx.canvas.width / (ctx.getTransform().a || 1) - bw - 8));
  by = Math.max(44, by);

  roundRect(ctx, bx, by, bw, bh, 10);
  ctx.fillStyle = 'rgba(20,26,36,0.96)';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#3a4a5e';
  ctx.stroke();

  ctx.fillStyle = '#e7eef7';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  lines.forEach((ln, i) => ctx.fillText(ln, bx + padX, by + padY + i * lineH));
  ctx.restore();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ─── Bucle de animación ──────────────────────────────────────────────────────
function frame(): void {
  if (!active) return;
  drawScene();
  requestAnimationFrame(frame);
}

// ─── Composer (participación) ─────────────────────────────────────────────────
async function sendFromComposer(): Promise<void> {
  const input = composerEl?.querySelector<HTMLTextAreaElement>('#assembly-input');
  const speakSel = composerEl?.querySelector<HTMLSelectElement>('#assembly-speak-as');
  const text = input?.value.trim();
  const fromBot = speakSel?.value || speakingAs;
  if (!text) return;
  if (!fromBot) return;
  if (!/^[A-Za-z0-9_-]+$/.test(fromBot)) return; // defensa en profundidad
  input!.value = '';
  try {
    const resp = await fetch(bridgeUrl(`/api/rooms/${encodeURIComponent(currentRoom)}/message`), {
      method: 'POST',
      headers: { ...bridgeHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, from_bot: fromBot }),
    });
    if (resp.ok) {
      // Reflejo inmediato local; el poll traerá la respuesta real.
      bubbles.set(fromBot, { botName: fromBot, text, born: Date.now(), ttl: 12000 });
      void pollRoom();
    }
  } catch {
    /* silencioso */
  }
}

// ─── Toggle público (mismo nombre que el panel viejo) ──────────────────────────
export async function toggleAssemblyRoom(): Promise<void> {
  ensureMounted();
  active = !active;
  sceneCanvas?.classList.toggle('hidden', !active);
  composerEl?.classList.toggle('hidden', !active);
  if (active) {
    await loadRoster();
    invalidateRosterCache();
    await loadRoster();
    await pollRoom();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = window.setInterval(() => void pollRoom(), 4000);
    requestAnimationFrame(frame);
  } else if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ─── escapes (texto plano; sin innerHTML para datos del bot) ──────────────────
function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
  );
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}
