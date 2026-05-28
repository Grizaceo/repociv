// ─── RepoCiv — Gaceta Widget (multi-mode: widget top-left OR panel) ──────────
import type { CDailyArticle } from '../types.ts';
import { getLatestNews, markNewsAsRead, scanNews } from '../bridge.ts';
import { openForeignRelationsPanel } from './foreignRelationsPanel.ts';

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
let _selectedBlog = 'all';
let _scanning = false;
let _selectedArticleIds = new Set<number>();
let _selectedCityId: string | null = null;
let _selectedRepoPath: string | null = null;

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

interface MountOpts {
  target?: string;
  mode?: 'widget' | 'panel';
}

export function mountGacetaWidget(opts: MountOpts = {}): void {
  const { target = 'gaceta-widget', mode = 'widget' } = opts;
  const widget = document.getElementById(target);
  if (!widget) return;

  if (mode === 'widget') {
    widget.classList.add('gaceta-mode-widget');
    const savedExpanded = localStorage.getItem(STORAGE_EXPANDED) === '1';
    _setExpanded(savedExpanded);
  } else {
    widget.classList.add('gaceta-mode-panel');
    _setExpanded(true);
  }

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
      window.dispatchEvent(new CustomEvent('repociv:open-city', { detail: { repo: 'cdaily' } }));
    });
  }

  const scanBtn = widget.querySelector('.gaceta-scan-btn') as HTMLElement | null;
  if (scanBtn) {
    scanBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      _doScan();
    });
  }

  window.addEventListener('repociv:city-selected', ((e: CustomEvent) => {
    const detail = e.detail as { cityId: string; repoPath?: string };
    _selectedCityId = detail.cityId;
    _selectedRepoPath = detail.repoPath ?? null;
    _renderToolbar();
  }) as EventListener);

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
      <div class="gaceta-blogs"></div>
      <div class="gaceta-toolbar">
        <button class="gaceta-fr-btn" id="gaceta-fr-btn" disabled title="Selecciona una noticia primero">🌍 Informe RR.EE.</button>
      </div>
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
  if (res.ok) await _refresh();
}

async function _refresh(): Promise<void> {
  const fresh = await getLatestNews();
  const prevCount = _lastUnreadCount;
  _articles = fresh;
  _lastUnreadCount = fresh.length;
  _teaserIdx = 0;
  _selectedCategory = 'all';
  _selectedBlog = 'all';
  _selectedArticleIds = new Set<number>();
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
  _renderBlogs();
  _renderToolbar();
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

function _getBlogs(): string[] {
  return Array.from(new Set(_articles.map((a) => a.blogName).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  );
}

function _renderCategories(): void {
  const bar = document.querySelector('.gaceta-categories') as HTMLElement | null;
  if (!bar) return;
  const cats = _getCategories();
  if (cats.length === 0) {
    bar.innerHTML = '';
    return;
  }
  bar.innerHTML = [
    `<span class="gaceta-chip ${_selectedCategory === 'all' ? 'active' : ''}" data-cat="all">[Todo]</span>`,
    ...cats.map(
      (c) =>
        `<span class="gaceta-chip ${_selectedCategory === c.name ? 'active' : ''}" data-cat="${esc(c.name)}">[${esc(c.emoji)} ${esc(c.name)}]</span>`,
    ),
  ].join('');
  bar.querySelectorAll('.gaceta-chip').forEach((chip) => {
    chip.addEventListener('click', (e) => {
      const cat = (e.currentTarget as HTMLElement).dataset['cat'] ?? 'all';
      _selectedCategory = cat;
      _renderCategories();
      _renderList(false);
      _renderToolbar();
    });
  });
}

function _renderBlogs(): void {
  const bar = document.querySelector('.gaceta-blogs') as HTMLElement | null;
  if (!bar) return;
  const blogs = _getBlogs();
  if (blogs.length === 0) {
    bar.innerHTML = '';
    return;
  }
  bar.innerHTML = [
    `<span class="gaceta-chip ${_selectedBlog === 'all' ? 'active' : ''}" data-blog="all">[Todos los blogs]</span>`,
    ...blogs.map(
      (blog) =>
        `<span class="gaceta-chip ${_selectedBlog === blog ? 'active' : ''}" data-blog="${esc(blog)}">[${esc(blog)}]</span>`,
    ),
  ].join('');
  bar.querySelectorAll('.gaceta-chip').forEach((chip) => {
    chip.addEventListener('click', (e) => {
      const blog = (e.currentTarget as HTMLElement).dataset['blog'] ?? 'all';
      _selectedBlog = blog;
      _renderBlogs();
      _renderList(false);
      _renderToolbar();
    });
  });
}

function _renderToolbar(): void {
  const toolbar = document.querySelector('.gaceta-toolbar') as HTMLElement | null;
  if (!toolbar) return;
  const frBtn = toolbar.querySelector('#gaceta-fr-btn') as HTMLButtonElement | null;
  if (!frBtn) return;
  const count = _selectedArticleIds.size;
  frBtn.disabled = count === 0;
  frBtn.title =
    count > 0
      ? `Generar Informe de Relaciones Exteriores para ${count} noticia(s)${_selectedCityId ? ` · ${_selectedCityId}` : ''}`
      : 'Selecciona una o más noticias primero';
}

function _renderList(refreshFilters = true): void {
  const list = document.querySelector('.gaceta-list') as HTMLElement | null;
  if (!list) return;

  let filtered = _articles;
  if (_selectedCategory !== 'all')
    filtered = filtered.filter((a) => a.category === _selectedCategory);
  if (_selectedBlog !== 'all') filtered = filtered.filter((a) => a.blogName === _selectedBlog);

  if (filtered.length === 0) {
    list.innerHTML = `<li style="color:var(--text-dim);text-align:center;padding:12px;">Sin novedades</li>`;
    return;
  }

  const isPanel = list.closest('.gaceta-mode-panel') !== null;
  const slice = isPanel ? filtered : filtered.slice(0, 5);
  list.innerHTML = slice
    .map(
      (a) => `
    <li class="gaceta-item ${_selectedArticleIds.has(a.id) ? 'gaceta-item-selected' : ''}" data-article-id="${a.id}">
      <span class="gaceta-item-meta">${a.emoji ? esc(a.emoji) + ' ' : ''}${esc(a.blogName)} · ${new Date(a.publishedDate).toLocaleDateString()}${a.category ? ` · ${esc(a.category)}` : ''}</span>
      <a class="gaceta-item-title" href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a>
      <div class="gaceta-item-row">
        <button class="gaceta-mark-read" data-id="${a.id}">✓ Leído</button>
        <span class="gaceta-select-hint">↻ click para ${_selectedArticleIds.has(a.id) ? 'deseleccionar' : 'seleccionar'}</span>
      </div>
    </li>
  `,
    )
    .join('');

  list.querySelectorAll<HTMLElement>('.gaceta-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.gaceta-mark-read')) return;
      const id = parseInt((item as HTMLElement).dataset['articleId'] ?? '0', 10);
      if (!id) return;
      if (_selectedArticleIds.has(id)) _selectedArticleIds.delete(id);
      else _selectedArticleIds.add(id);
      _renderList(false);
      _renderToolbar();
    });
  });

  list.querySelectorAll<HTMLButtonElement>('.gaceta-mark-read').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.id ?? '0', 10);
      if (id && (await markNewsAsRead(id))) await _refresh();
    });
  });

  const frBtn = document.getElementById('gaceta-fr-btn') as HTMLButtonElement | null;
  if (frBtn) {
    const newBtn = frBtn.cloneNode(true) as HTMLButtonElement;
    frBtn.parentNode?.replaceChild(newBtn, frBtn);
    newBtn.addEventListener('click', _openForeignReport);
    newBtn.disabled = _selectedArticleIds.size === 0;
    newBtn.title =
      _selectedArticleIds.size > 0
        ? `Generar Informe de Relaciones Exteriores para ${_selectedArticleIds.size} noticia(s)${_selectedCityId ? ` · ${_selectedCityId}` : ''}`
        : 'Selecciona una o más noticias primero';
  }

  if (refreshFilters) {
    _renderCategories();
    _renderBlogs();
  }
}

function _openForeignReport(): void {
  if (_selectedArticleIds.size === 0) return;
  const articles = _articles.filter((a) => _selectedArticleIds.has(a.id));
  if (articles.length === 0) return;

  let panelContainer = document.getElementById('foreign-relations-container');
  if (!panelContainer) {
    panelContainer = document.createElement('div');
    panelContainer.id = 'foreign-relations-container';
    panelContainer.className = 'foreign-relations-container';
    document.body.appendChild(panelContainer);
  }

  openForeignRelationsPanel(
    panelContainer,
    articles,
    _selectedCityId ?? undefined,
    _selectedRepoPath ?? undefined,
  );
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
