// ─── RepoCiv — Gaceta Widget (top-left, expandible) ──────────────────────────
import type { CDailyArticle } from '../types.ts';
import { getLatestNews, markNewsAsRead } from '../bridge.ts';

const REFRESH_MS = 300_000;
const TEASER_ROTATE_MS = 30_000;
const STORAGE_KEY = 'repociv-gaceta-expanded';
const HOTKEY = 'KeyN';

let _articles: CDailyArticle[] = [];
let _teaserIdx = 0;
let _refreshTimer: ReturnType<typeof setInterval> | null = null;
let _teaserTimer: ReturnType<typeof setInterval> | null = null;
let _lastUnreadCount = 0;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function mountGacetaWidget(): void {
  const widget = document.getElementById('gaceta-widget');
  if (!widget) {
    console.warn('Gaceta widget element not found in DOM');
    return;
  }

  const savedExpanded = localStorage.getItem(STORAGE_KEY) === '1';
  _setExpanded(savedExpanded);

  const header = widget.querySelector('.gaceta-header') as HTMLElement;
  header.addEventListener('click', _toggle);
  header.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      _toggle();
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.code !== HOTKEY) return;
    const tgt = e.target as HTMLElement | null;
    if (tgt && /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName)) return;
    if (tgt && tgt.isContentEditable) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    _toggle();
  });

  const linkFull = widget.querySelector('.gaceta-link-full') as HTMLAnchorElement;
  linkFull.addEventListener('click', (e) => {
    e.preventDefault();
    window.dispatchEvent(
      new CustomEvent('repociv:open-city', { detail: { repo: 'cdaily' } }),
    );
  });

  _refresh();
  _refreshTimer = setInterval(_refresh, REFRESH_MS);
  _teaserTimer = setInterval(_rotateTeaser, TEASER_ROTATE_MS);
}

export function unmountGacetaWidget(): void {
  if (_refreshTimer) clearInterval(_refreshTimer);
  if (_teaserTimer) clearInterval(_teaserTimer);
  _refreshTimer = null;
  _teaserTimer = null;
}

async function _refresh(): Promise<void> {
  const fresh = await getLatestNews();
  const prevCount = _lastUnreadCount;
  _articles = fresh;
  _lastUnreadCount = fresh.length;
  _teaserIdx = 0;
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
  _renderList();
}

function _renderTeaser(): void {
  const teaser = document.querySelector('#gaceta-widget .gaceta-teaser');
  if (!teaser) return;
  if (_articles.length === 0) {
    teaser.textContent = 'Sin novedades imperiales';
    return;
  }
  const a = _articles[_teaserIdx]!;
  teaser.innerHTML = `[${esc(a.blogName)}] ${esc(a.title)}`;
}

function _renderBadge(): void {
  const badge = document.querySelector('#gaceta-widget .gaceta-badge') as HTMLElement | null;
  if (!badge) return;
  if (_articles.length === 0) {
    badge.hidden = true;
  } else {
    badge.hidden = false;
    badge.textContent = String(_articles.length);
  }
}

function _pulseBadge(): void {
  const badge = document.querySelector('#gaceta-widget .gaceta-badge') as HTMLElement | null;
  if (!badge) return;
  badge.classList.remove('pulse');
  void badge.offsetWidth;
  badge.classList.add('pulse');
}

function _renderList(): void {
  const list = document.querySelector('#gaceta-widget .gaceta-list');
  if (!list) return;
  if (_articles.length === 0) {
    list.innerHTML = `<li style="color:var(--text-dim);text-align:center;padding:12px;">Sin novedades</li>`;
    return;
  }
  list.innerHTML = _articles
    .slice(0, 5)
    .map(
      (a) => `
    <li>
      <span class="gaceta-item-meta">📰 ${esc(a.blogName)} · ${new Date(a.publishedDate).toLocaleDateString()}</span>
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
  localStorage.setItem(STORAGE_KEY, expanded ? '1' : '0');
}
