import { create } from 'zustand';
import type { AppSettings, ViewerFilter, ViewerSortKey } from '@shared/dto';
import type { ToastMsg } from '@shared/ipc';
import type { UserId } from '@shared/events';

export type Route = 'connect' | 'live' | 'sessions' | 'analytics' | 'settings' | 'licenses';

interface UiState {
  route: Route;
  selectedViewer: UserId | null;
  selectedSession: number | null;
  sort: ViewerSortKey;
  desc: boolean;
  filter: ViewerFilter;
  search: string;
  /**
   * Off by default: on a busy room the join notices outnumber comments several to
   * one and bury the thing the lane exists to show. Meaningful arrivals are
   * already covered by the 入室アラート panel.
   */
  showJoins: boolean;
  /** Show each speaker's 来店回数 / 前回来店 / 累計💎 inline under their comment. */
  showRecord: boolean;
  toasts: Array<ToastMsg & { id: number }>;
  settings: AppSettings | null;
  /** Bumped when a memo is saved, so open lists refetch instead of showing the old note. */
  memoNonce: number;
}

export const useUi = create<UiState>(() => ({
  route: 'connect',
  selectedViewer: null,
  selectedSession: null,
  sort: 'lastSeen',
  desc: true,
  filter: 'all',
  search: '',
  showJoins: false,
  showRecord: true,
  toasts: [],
  settings: null,
  memoNonce: 0,
}));

export const go = (route: Route): void => useUi.setState({ route });
export const openViewer = (userId: UserId | null): void => useUi.setState({ selectedViewer: userId });
export const openSession = (sessionId: number | null): void =>
  useUi.setState({ selectedSession: sessionId, route: sessionId == null ? 'sessions' : useUi.getState().route });

export function setSort(sort: ViewerSortKey): void {
  useUi.setState((s) => (s.sort === sort ? { desc: !s.desc } : { sort, desc: true }));
}

let toastId = 0;
export function toast(t: ToastMsg): void {
  const id = ++toastId;
  useUi.setState((s) => ({ toasts: [...s.toasts, { ...t, id }] }));
  setTimeout(() => useUi.setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), t.level === 'error' ? 9000 : 4500);
}

export function setSettings(s: AppSettings): void {
  useUi.setState({ settings: s });
}
