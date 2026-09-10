import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { GiftOption, GiftOptionsResult } from '@shared/dto';
import { rpc } from '../ipc/client';
import { useLive } from '../state/liveStore';
import './gift-picker.css';

interface Catalog {
  data: GiftOptionsResult;
  loading: boolean;
  error: string;
  refresh: (target?: string) => Promise<void>;
  open: () => void;
}
const Context = createContext<Catalog | null>(null);

/** One catalog/request per Challenge screen, shared by every rule and dialog. */
export function GiftCatalogProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [data, setData] = useState<GiftOptionsResult>({ target: '', rows: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const connectionKey = useLive((s) => s.status.state === 'live' ? `${s.status.hostDisplayId}:${s.status.roomId}` : 'uniqueId' in s.status ? s.status.uniqueId : '');
  const generation = useRef(0);
  const initial = useRef<Promise<GiftOptionsResult> | null>(null);
  const refreshed = useRef(false);
  const inflight = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    generation.current += 1;
    refreshed.current = false;
    setLoading(true);
    initial.current = rpc('q.giftOptions', undefined).then(async (saved) => {
      if (!saved.target) {
        const settings = await rpc('cfg.get', undefined);
        saved = { ...saved, target: settings.hostUniqueId || '' };
      }
      if (!cancelled) { setData(saved); setError(''); }
      return saved;
    });
    void initial.current.catch ((e: Error) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; alive.current = false; };
  }, [connectionKey]);

  const refresh = useCallback(async (target?: string) => {
    if (inflight.current) return;
    inflight.current = true;
    const requestGeneration = generation.current;
    setLoading(true);
    setError('');
    try {
      const result = await rpc('giftOptions.refresh', { target });
      if (alive.current && requestGeneration === generation.current) setData(result);
    } catch (e) {
      if (alive.current && requestGeneration === generation.current) setError(`一覧を更新できませんでした。保存済みのギフトは選択できます。${(e as Error).message}`);
    } finally {
      inflight.current = false;
      if (alive.current) setLoading(false);
    }
  }, []);

  const open = useCallback(() => {
    if (refreshed.current) return;
    refreshed.current = true;
    void initial.current?.then((saved) => {
      if (saved.target && alive.current) void refresh(saved.target);
    }).catch (() => undefined);
  }, [refresh]);
  return <Context.Provider value={{ data, loading, error, refresh, open }}>{children}</Context.Provider>;
}

function useCatalog(): Catalog {
  const value = useContext(Context);
  if (!value) throw new Error('GiftCatalogProvider is required');
  return value;
}

export function GiftIcon({ url, size = 48 }: { url: string | null; size?: number }): React.JSX.Element {
  const [failed, setFailed] = useState<string | null>(null);
  return url && failed !== url ? <img className="gift-icon" src={url} alt="" width={size} height={size}
    loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(url)} /> :
    <span className="gift-icon gift-icon-fallback" role="img" aria-label="画像なし" style={{ width: size, height: size }}>🎁</span>;
}

function GiftPickerDialog({ selected, multiple, onPick, onClose }: {
  selected: string[];
  multiple: boolean;
  onPick: (ids: string[]) => void;
  onClose: () => void;
}): React.JSX.Element {
  const catalog = useCatalog();
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [receivedOnly, setReceivedOnly] = useState(false);
  const [target, setTarget] = useState('');
  const [chosen, setChosen] = useState(selected);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    search.current?.focus();
    return () => { element?.close(); opener?.focus(); };
  }, []);
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return catalog.data.rows.filter((r) => (!receivedOnly || r.received) &&
      (!needle || r.name.toLowerCase().includes(needle) || r.giftId.includes(needle)))
      .sort((a, b) => a.diamonds - b.diamonds || a.name.localeCompare(b.name, 'ja') || a.giftId.localeCompare(b.giftId));
  }, [catalog.data.rows, query, receivedOnly]);
  return createPortal(<dialog ref={dialog} className="gift-picker-dialog" aria-label="ギフトを選ぶ"
    onCancel={(e) => { e.preventDefault(); onClose(); }}>
    <header className="gift-picker-header"><strong>ギフトを選ぶ{multiple ? '（複数選択）' : ''}</strong>
      <button type="button" className="btn" onClick={onClose}>閉じる</button></header>
    <div className="gift-picker-tools">
      <input ref={search} type="search" aria-label="ギフトを検索" placeholder="ギフト名・IDで検索" value={query} onChange={(e) => setQuery(e.target.value)} />
      <label className="row"><input type="checkbox" checked={receivedOnly} onChange={(e) => setReceivedOnly(e.target.checked)} />受信済みのみ</label>
      <button type="button" className="btn" disabled={catalog.loading || (!catalog.data.target && !target.trim())}
        onClick={() => void catalog.refresh(catalog.data.target || target)}>{catalog.loading ? '読み込み中…' : '一覧を更新'}</button>
    </div>
    {!catalog.data.target && <label className="gift-picker-target">取得対象の配信者名
      <input type="text" value={target} placeholder="@ユーザー名" onChange={(e) => setTarget(e.target.value)} />
    </label>}
    <p className="faint gift-picker-status" aria-live="polite">{catalog.data.target ? `取得対象: @${catalog.data.target} · ` : ''}
      {rows.length} 件 · ダイヤ数の少ない順 · 未受信ギフトも選択できます</p>
    {catalog.error && <div className="notice" role="alert">{catalog.error}</div>}
    <div className="gift-picker-grid" aria-label="ギフト一覧" aria-busy={catalog.loading}>
      {rows.map((r) => <button type="button" key={r.giftId} className="gift-picker-card" aria-pressed={chosen.includes(r.giftId)}
        onClick={() => {
          if (!multiple) { onPick([r.giftId]); return; }
          setChosen((ids) => ids.includes(r.giftId) ? ids.filter((id) => id !== r.giftId) : [...ids, r.giftId]);
        }}>
        <GiftIcon url={r.iconUrl} size={72} /><strong>{r.name || '名前不明'}</strong>
        <span>💎 {r.diamonds.toLocaleString()}</span><small>ID: {r.giftId} · {r.received ? '受信済み' : '未受信'}</small>
        {chosen.includes(r.giftId) && <span className="gift-selected-mark">✓ 選択中</span>}
      </button>)}
      {!rows.length && <p className="empty">{catalog.loading ? 'ギフト一覧を読み込んでいます…' : query || receivedOnly ? '条件に合うギフトがありません。' : '一覧を更新すると、取得できるギフトがここに表示されます。'}</p>}
    </div>
    {multiple && <footer className="gift-picker-footer"><span>{chosen.length} 件を選択中</span>
      <button className="btn primary" type="button" onClick={() => onPick(chosen)}>選択を確定</button></footer>}
  </dialog>, document.body);
}

export type GiftTriggerPatch = { giftId: string; giftName: string; canonical: string };

export function GiftField({ value, onChange, children, onGift }: {
  value: { giftId?: string; giftName?: string; canonical?: string };
  onChange: (patch: GiftTriggerPatch) => void;
  onGift?: (gift: GiftOption) => void;
  children?: ReactNode;
}): React.JSX.Element {
  const { data, open } = useCatalog();
  const [show, setShow] = useState(false);
  const gift = data.rows.find((r) => r.giftId === value.giftId);
  const selected = !!(value.giftId || value.giftName || value.canonical);
  return <div className="gift-field">
    <div className="gift-field-selection"><GiftIcon url={gift?.iconUrl ?? null} />
      <div><strong>{gift?.name || value.giftName || value.canonical || (value.giftId ? `ID: ${value.giftId}` : 'ギフト未選択')}</strong>
        {gift && <small>💎 {gift.diamonds.toLocaleString()} · ID: {gift.giftId}</small>}
        {!gift && selected && <small>既存の指定を保持しています</small>}</div></div>
    <div className="row"><button type="button" className="btn small" onClick={() => { open(); setShow(true); }}>{selected ? '変更' : 'ギフトを選ぶ'}</button>
      {selected && <button type="button" className="btn small" onClick={() => onChange({ giftId: '', giftName: '', canonical: '' })}>解除</button>}</div>
    {children && <details className="gift-field-details"><summary>詳細設定</summary>{children}</details>}
    {show && <GiftPickerDialog selected={value.giftId ? [value.giftId] : []} multiple={false} onClose={() => setShow(false)} onPick={(ids) => {
      const picked = data.rows.find((r) => r.giftId === ids[0]);
      if (!picked) return;
      if (onGift) onGift(picked);
      else onChange({ giftId: picked.giftId, giftName: '', canonical: '' });
      setShow(false);
    }} />}
  </div>;
}

export function GiftMultiField({ ids, onChange, children }: { ids: string[]; onChange: (ids: string[]) => void; children?: ReactNode }): React.JSX.Element {
  const { data, open } = useCatalog();
  const [show, setShow] = useState(false);
  return <div className="gift-field"><strong>除外するギフト</strong><div className="gift-chips">
    {ids.map((id) => {
      const gift = data.rows.find((r) => r.giftId === id);
      return <span className="gift-chip" key={id}><GiftIcon url={gift?.iconUrl ?? null} size={32} />{gift?.name || `ID: ${id}`}
        <button type="button" aria-label={`${gift?.name || id}の除外を解除`} onClick={() => onChange(ids.filter((v) => v !== id))}>×</button></span>;
    })}</div>
    <button type="button" className="btn small" onClick={() => { open(); setShow(true); }}>除外ギフトを選ぶ</button>
    {children && <details className="gift-field-details"><summary>詳細設定</summary>{children}</details>}
    {show && <GiftPickerDialog selected={ids} multiple onClose={() => setShow(false)} onPick={(chosen) => { onChange(chosen); setShow(false); }} />}
  </div>;
}
