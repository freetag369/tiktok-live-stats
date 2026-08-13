import { useEffect, useState } from 'react';
import { compact, num } from '@shared/format';
import { formatDateJa, formatDurationJa } from '@shared/time';
import { rpc, useQuery } from '../ipc/client';
import { useLive } from '../state/liveStore';
import { go, openSession, setSettings, toast, useUi } from '../state/uiStore';
import { StatusChip } from '../components/common';

export function Connect(): React.JSX.Element {
  const status = useLive((s) => s.status);
  const quota = useLive((s) => s.quota);
  const sessionId = useLive((s) => s.sessionId);
  const settings = useUi((s) => s.settings);
  const [name, setName] = useState('');
  const [wait, setWait] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (settings) {
      setName((n) => n || settings.hostUniqueId);
      setWait(settings.waitUntilLive);
    }
  }, [settings]);

  const { data: sessions, reload } = useQuery('q.sessions', { limit: 12 }, [sessionId, status.state]);
  const live = status.state === 'live';

  async function start(): Promise<void> {
    const clean = name.trim();
    if (!clean) return;
    setBusy(true);
    try {
      await rpc('cfg.set', { hostUniqueId: clean, waitUntilLive: wait });
      setSettings(await rpc('cfg.get', undefined));
      await rpc('conn.start', { uniqueId: clean, waitUntilLive: wait });
      go('live');
    } catch (e) {
      toast({ level: 'error', msgJa: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function stop(): Promise<void> {
    setBusy(true);
    try {
      await rpc('conn.stop', undefined);
      reload();
    } catch (e) {
      toast({ level: 'error', msgJa: `停止に失敗しました: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  }

  const day = quota?.day;
  const hasKey = quota?.hasApiKey ?? Boolean(settings?.eulerApiKey);

  return (
    <div className="screen">
      <div className="grid" style={{ gridTemplateColumns: 'minmax(380px, 1fr) minmax(360px, 1.2fr)', maxWidth: 1200 }}>
        <div className="card">
          <h3>配信を記録する</h3>
          <label className="field">
            TikTok のユーザー名
            <input
              type="text"
              placeholder="例: your_account（@ や URL でも可）"
              value={name}
              disabled={live}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !live) void start();
              }}
            />
          </label>

          <label className="row" style={{ marginTop: 10, cursor: 'pointer' }}>
            <input type="checkbox" checked={wait} disabled={live} onChange={(e) => setWait(e.target.checked)} />
            <span>配信が始まるまで待機する</span>
          </label>
          <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
            {hasKey
              ? '待機中は3分ごとに確認します。確認1回ごとに接続回数を1つ消費します。'
              : 'APIキーなしのときは10分ごとに確認します（1日100回の枠を使い切らないため）。'}
          </div>

          <div className="row" style={{ marginTop: 14 }}>
            {live ? (
              <button className="btn danger" onClick={() => void stop()} disabled={busy}>
                記録を終了する
              </button>
            ) : (
              <button className="btn primary" onClick={() => void start()} disabled={busy || !name.trim()}>
                配信を記録
              </button>
            )}
            <StatusChip status={status} />
          </div>

          <hr style={{ border: 0, borderTop: '1px solid var(--line)', margin: '16px 0' }} />

          <h3>接続の残り回数</h3>
          {hasKey ? (
            <div className="row wrap">
              <span className="chip">APIキー 設定済み</span>
              {day ? (
                <span className="num">
                  本日 {num(day.remaining)} / {num(day.max)} 回
                </span>
              ) : (
                <span className="faint">取得中…</span>
              )}
            </div>
          ) : (
            <div>
              <div className="row wrap">
                <span className={`chip ${day && day.remaining <= day.max * 0.2 ? 'err' : 'warn'}`}>
                  <i className="dot" />
                  APIキー 未設定
                </span>
                {/* The actual figure, not just the cap — "1日100回まで" tells you
                    nothing about whether tonight's stream is at risk. */}
                {day ? (
                  <span className="num">
                    本日 残り {num(day.remaining)} / {num(day.max)} 回
                  </span>
                ) : (
                  <span className="faint">1日100回まで</span>
                )}
                {quota?.hour ? (
                  <span className="faint num">
                    （1時間 {num(quota.hour.remaining)}/{num(quota.hour.max)}・1分 {num(quota.minute?.remaining ?? 0)}/
                    {num(quota.minute?.max ?? 0)}）
                  </span>
                ) : null}
              </div>
              <div className="notice" style={{ marginTop: 8 }}>
                キーなしでも記録できます。消費するのは<b>接続の瞬間だけ</b>で、つながってしまえば
                配信中いくら長くても追加では消費しません。
                <br />
                ただし上限は <b>1日100回・1時間30回・1分5回</b>（この回線ごと）。回線が不安定で再接続を
                繰り返す日や、「配信開始まで待機」を長時間つけっぱなしにすると枯れます。
                <br />
                無料アカウントを作って APIキーを設定すると <b>1日2,500回</b> になります（カード不要）。
              </div>
              <button className="btn small" style={{ marginTop: 8 }} onClick={() => go('settings')}>
                設定を開く
              </button>
            </div>
          )}
        </div>

        <div className="card">
          <h3>最近の配信</h3>
          {sessions && sessions.rows.length > 0 ? (
            <div style={{ maxHeight: 460, overflow: 'auto' }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>開始</th>
                    <th className="n">時間</th>
                    <th className="n">ピーク</th>
                    <th className="n">視聴者</th>
                    <th className="n">💎</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.rows.map((s) => (
                    <tr
                      key={s.sessionId}
                      style={{ cursor: 'pointer' }}
                      onClick={() => {
                        openSession(s.sessionId);
                        go('sessions');
                      }}
                    >
                      <td>{formatDateJa(s.startedMs)}</td>
                      <td className="n">{formatDurationJa(s.durationMs)}</td>
                      <td className="n">{num(s.peakViewers)}</td>
                      <td className="n">{num(s.uniqueViewers)}</td>
                      <td className="n">{compact(s.diamonds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty">
              まだ配信の記録がありません。
              <br />
              <span className="faint">
                このアプリは導入した日からデータを蓄積します。TikTok 側に過去のリスナー履歴は残っていないため、
                さかのぼることはできません。
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
