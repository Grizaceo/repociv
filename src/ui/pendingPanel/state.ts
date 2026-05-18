// ─── Pending tracker state ──────────────────────────────────────────────────
export interface PendingItem {
  id: string;
  title: string;
  priority: string;
  state: string;
  stateText: string;
  detail: string;
}

export const POLL_MS = 5_000;

export const STATE_OPTIONS = [
  { value: '🔵', label: '🔵 registrada' },
  { value: '🟡', label: '🟡 en progreso' },
  { value: '🟢', label: '🟢 operativo' },
  { value: '🔴', label: '🔴 descartada' },
];

// ─── Module-level mutable state ─────────────────────────────────────────────
// ESM no permite reasignar imports, asi que se accede via getter/setter.
// Las colecciones mutables (no hay aqui) se exportarian directamente.

let _panel: HTMLElement | null = null;
export const getPanel = (): HTMLElement | null => _panel;
export const setPanel = (v: HTMLElement | null): void => {
  _panel = v;
};

let _timer = 0;
export const getTimer = (): number => _timer;
export const setTimer = (v: number): void => {
  _timer = v;
};

let _visible = false;
export const getVisible = (): boolean => _visible;
export const setVisible = (v: boolean): void => {
  _visible = v;
};

let _items: PendingItem[] = [];
export const getItems = (): PendingItem[] => _items;
export const setItems = (v: PendingItem[]): void => {
  _items = v;
};

let _offline = false;
export const getOffline = (): boolean => _offline;
export const setOffline = (v: boolean): void => {
  _offline = v;
};

let _expandedId: string | null = null;
export const getExpandedId = (): string | null => _expandedId;
export const setExpandedId = (v: string | null): void => {
  _expandedId = v;
};

let _editingId: string | null = null;
export const getEditingId = (): string | null => _editingId;
export const setEditingId = (v: string | null): void => {
  _editingId = v;
};
