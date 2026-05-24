// ─── RepoCiv — Gaceta Widget (multi-mode: widget top-left OR panel) ──────────
import type { CDailyArticle } from '../types.ts';
import { getLatestNews, markNewsAsRead, scanNews } from '../bridge.ts';

const REFRESH_MS = 300_000;
const TEASER_ROTATE_MS = 30_000;
const STORAGE_EXPANDED = 'repociv-gaceta-expanded';
const HOTKEY = 'KeyN';

let _articles: CDailyArticle[] = [];
let _teaserIdx = 0;
let _refreshTimer: ReturnType<typeof setInterval> | null = null;
let _teaserTimer: ReturnType<typeof setInterval> | null = null;
let _lastUnreadCount = 0;
let _selectedCategory = 'all';
let _scanning = false;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

interface MountOpts {
  target?: string;    // DOM id to mount into (default 'gaceta-widget')
  mode?: 'widget' | 'panel';  // widget = top-left teaser + badge; panel = full list no teaser
}

export function mountGacetaWidget(opts: MountOpts = {}): void {
  const { target = 'gaceta-widget', mode = 'widget' } = opts;
  const widget = document.getElementById(target);
  if (!widget) {
    console.warn(`Gaceta mount target #${target} not found`);
    return;
  }

  if (mode === 'widget') {
    widget.classList.add('gaceta-mode-widget');
    const savedExpanded = localStorage.getItem(STORAGE_EXPANDED) === '1';
    _setExpanded(savedExpanded);
  } else {
    widget.classList.add('gaceta-mode-panel');
    _setExpanded(true);
  }

  // Build header if not already built (panel mode may bring its own shell)
  if (!widget.querySelector('.gaceta-header')) {
    widget.innerHTML = _buildHTML(mode);
  }

  const header = widget.querySelector('.gaceta-header') as HTMLElement;
  if (mode === 'widget') {
    header.addEventListener('click', _toggle);
    header.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        _toggle();
      }
    });
  } else {
    // panel mode: scan button visible, no toggle header click
  }

  if (mode === 'widget') {
    window.addEventListener('keydown', (e) => {
      if (e.code !== HOTKEY) return;
      const tgt = e.target as HTMLElement | null;
      if (tgt && /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName)) return;
      if (tgt && tgt.isContentEditable) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      _toggle();
    });
  }

  const linkFull = widget.querySelector('.gaceta-link-full') as HTMLAnchorElement | null;
  if (linkFull) {
    linkFull.addEventListener('click', (e) => {
      e.preventDefault();
      window.dispatchEvent(
        new CustomEvent('repociv:open-city', { detail: { repo: 'cdaily' } }),
      );
    });
  }

  const scanBtn = widget.querySelector('.gaceta-scan-btn') as HTMLElement | null;
  if (scanBtn) {
    scanBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      _doScan();
    });
  }

  _refresh();
  _refreshTimer = setInterval(_refresh, REFRESH_MS);
  if (mode === 'widget') _teaserTimer = setInterval(_rotateTeaser, TEASER_ROTATE_MS);
}

export function unmountGacetaWidget(): void {
  if (_refreshTimer) clearInterval(_refreshTimer);
  if (_teaserTimer) clearInterval(_teaserTimer);
  _refreshTimer = null;
  _teaserTimer = null;
}

function _buildHTML(mode: 'widget' | 'panel'): string {
  const isWidget = mode === 'widget';
  return `
    <div class="gaceta-header" role="button" tabindex="0" aria-expanded="false">
      <span class="gaceta-icon">📰</span>
      <span class="gaceta-label">Gaceta</span>
      ${isWidget ? '<span class="gaceta-badge" hidden>0</span>' : ''}
      <span class="gaceta-teaser">Cargando...</span>
      <span class="gaceta-scan-btn" title="Escanear blogs">🔄</span>
      <span class="gaceta-chevron">▼</span>
    </div>
    <div class="gaceta-body" hidden>
      <div class="gaceta-categories"></div>
      <ul class="gaceta-list"></ul>
      ${isWidget ? '<a href="#" class="gaceta-link-full">Ver todo en CDaily →</a>' : ''}
    </div>
  `;
}

async function _doScan(): Promise<void> {
  if (_scanning) return;
  _scanning = true;
  const widget = document.querySelector('.gaceta-header .gaceta-scan-btn');
  widget?.classList.add('spinning');
  const res = await scanNews();
  widget?.classList.remove('spinning');
  _scanning = false;
  if (res.ok) {
    await _refresh();
  } else {
    console.warn('[gaceta] scan failed:', res.error);
  }
}

async function _refresh(): Promise<void> {
  const fresh = await getLatestNews();
  const prevCount = _lastUnreadCount;
  _articles = fresh;
  _lastUnreadCount = fresh.length;
  _teaserIdx = 0;
  _selectedCategory = 'all';
  _render();
  if (fresh.length > prevCount && prevCount > 0) _pulseBadge();
}

function _rotateTeaser(): void {
  if (_articles.length <= 1) return;
  _teaserIdx = (_teaserIdx + 1) % _articles.length;
  _renderTeaser();
}

function _render(): void {
  _renderTeaser();
  _renderBadge();
  _renderCategories();
  _renderList();
}

function _renderTeaser(): void {
  const teaser = document.querySelector('.gaceta-header .gaceta-teaser');
  if (!teaser) return;
  if (_articles.length === 0) {
    teaser.textContent = 'Sin novedades imperiales';
    return;
  }
  const a = _articles[_teaserIdx]!;
  teaser.innerHTML = `[${esc(a.blogName)}] ${esc(a.title)}`;
}

function _renderBadge(): void {
  const badge = document.querySelector('.gaceta-header .gaceta-badge') as HTMLElement | null;
  if (!badge) return;
  if (_articles.length === 0) {
    badge.hidden = true;
  } else {
    badge.hidden = false;
    badge.textContent = String(_articles.length);
  }
}

function _pulseBadge(): void {
  const badge = document.querySelector('.gaceta-header .gaceta-badge') as HTMLElement | null;
  if (!badge) return;
  badge.classList.remove('pulse');
  void badge.offsetWidth;
  badge.classList.add('pulse');
}

function _getCategories(): { name: string; emoji: string }[] {
  const set = new Map<string, string>();
  for (const a of _articles) {
    if (a.category) set.set(a.category, a.emoji ?? '📰');
  }
  return Array.from(set.entries()).map(([name, emoji]) => ({ name, emoji }));
}

function _renderCategories(): void {
  const bar = document.querySelector('.gaceta-categories') as HTMLElement | null;
  if (!bar) return;
  const cats = _getCategories();
  if (cats.length === 0) { bar.innerHTML = ''; return; }
  const chips = [
    `<span class="gaceta-chip ${_selectedCategory === 'all' ? 'active' : ''}" data-cat="all">[Todo]</span>`,
    ...cats.map((c) =>
      `<span class="gaceta-chip ${_selectedCategory === c.name ? 'active' : ''}" data-cat="${esc(c.name)}">[${esc(c.emoji)} ${esc(c.name)}]</span>`
    ),
  ].join('');
  bar.innerHTML = chips;
  bar.querySelectorAll('.gaceta-chip').forEach((chip) => {
    chip.addEventListener('click', (e) => {
      const cat = (e.currentTarget as HTMLElement).dataset['cat'] ?? 'all';
      _selectedCategory = cat;
      _renderCategories();
      _renderList(false);
    });
  });
}

function _renderList(refreshCats = true): void {
  const list = document.querySelector('.gaceta-list') as HTMLElement | null;
  if (!list) return;
  let filtered = _articles;
  if (_selectedCategory !== 'all') {
    filtered = _articles.filter((a) => a.category === _selectedCategory);
  }
  if (filtered.length === 0) {
    list.innerHTML = `<li style="color:var(--text-dim);text-align:center;padding:12px;">Sin novedades</li>`;
    return;
  }
  const isPanel = list.closest('.gaceta-mode-panel') !== null;
  const slice = isPanel ? filtered : filtered.slice(0, 5);
  list.innerHTML = slice
    .map(
      (a) => `
    <li>
      <span class="gaceta-item-meta">${a.emoji ? esc(a.emoji) + ' ' : ''}${esc(a.blogName)} · ${new Date(a.publishedDate).toLocaleDateString()}</span>
      <a class="gaceta-item-title" href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a>
      <div class="gaceta-item-row">
        <button class="gaceta-mark-read" data-id="${a.id}">✓ Leído</button>
      </div>
    </li>
  `,
    )
    .join('');

  list.querySelectorAll<HTMLButtonElement>('.gaceta-mark-read').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = parseInt(btn.dataset.id ?? '0', 10);
      if (id && (await markNewsAsRead(id))) _refresh();
    });
  });
  if (refreshCats) _renderCategories();
}

function _toggle(): void {
  const widget = document.getElementById('gaceta-widget');
  if (!widget) return;
  const expanded = widget.classList.contains('gaceta-expanded');
  _setExpanded(!expanded);
}

function _setExpanded(expanded: boolean): void {
  const widget = document.getElementById('gaceta-widget');
  if (!widget) return;
  widget.classList.toggle('gaceta-expanded', expanded);
  widget.classList.toggle('gaceta-collapsed', !expanded);
  const header = widget.querySelector('.gaceta-header');
  header?.setAttribute('aria-expanded', String(expanded));
  const body = widget.querySelector('.gaceta-body') as HTMLElement | null;
  if (body) body.hidden = !expanded;
  localStorage.setItem(STORAGE_EXPANDED, expanded ? '1' : '0');
}
