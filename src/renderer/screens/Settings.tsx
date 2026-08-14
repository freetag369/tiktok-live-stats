import { useEffect, useState } from 'react';
import type { AppSettings, ScoringConfig } from '@shared/dto';
import { bytes, num } from '@shared/format';
import { formatDateJa } from '@shared/time';
import { DEFAULT_SCORING } from '@shared/scoring';
import { rpc, rpcFire, useQuery } from '../ipc/client';
import { go, setSettings, toast, useUi } from '../state/uiStore';

export function Settings(): React.JSX.Element {
  const settings = useUi((s) => s.settings);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: diag, reload: reloadDiag } = useQuery('q.diagnostics', undefined, []);
  // 診断ログ(main の有界リング)。fetch-once — ここを polling にすると、
  // 「worker がどれだけ忙しいか」を測るために worker を忙しくすることになる。
  const { data: diagLog, reload: reloadDiagLog } = useQuery('diag.recent', undefined, []);

  useEffect(() => {
    if (settings && !draft) setDraft(settings);
  }, [settings]);

  if (!draft) return <div className="screen">読み込み中…</div>;

  const patch = (p: Partial<AppSettings>): void => setDraft({ ...draft, ...p });
  const patchScoring = (p: Partial<ScoringConfig>): void => setDraft({ ...draft, scoring: { ...draft.scoring, ...p } });

  async function save(): Promise<void> {
    if (!draft) return;
    setBusy(true);
    try {
      // challenge はチャレンジ画面が編集する。ここから送るとあちらの保存を
      // 古い draft で上書きしてしまうため除外する(cfg.set は main 側で浅いマージ)。
      const { challenge: _omit, ...rest } = draft;
      const r = await rpc('cfg.set', rest);
      setSettings(await rpc('cfg.get', undefined));
      toast({
        level: 'info',
        msgJa: r.workerRestarted ? '保存しました（記録エンジンを再起動しました）。' : '保存しました。',
      });
      reloadDiag();
    } catch (e) {
      toast({ level: 'error', msgJa: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function recompute(): Promise<void> {
    setBusy(true);
    try {
      const r = await rpc('m.recomputeScores', { full: true });
      toast({ level: 'info', msgJa: `${num(r.updated)}人のVIP段階を更新しました。` });
    } catch (e) {
      toast({ level: 'error', msgJa: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function purgeAll(): Promise<void> {
    if (!window.confirm('すべての記録を削除します。元に戻せません。本当によろしいですか？')) return;
    if (!window.confirm('確認：リスナー・コメント・ギフト・配信履歴がすべて消えます。')) return;
    try {
      await rpc('m.purge', { scope: 'all' });
      toast({ level: 'warn', msgJa: 'すべての記録を削除しました。' });
    } catch (e) {
      toast({ level: 'error', msgJa: `削除に失敗しました: ${(e as Error).message}` });
    }
    reloadDiag();
  }

  return (
    <div className="screen">
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>設定</h2>
        <div className="spacer" />
        <button className="btn primary" onClick={() => void save()} disabled={busy}>
          保存
        </button>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', alignItems: 'start' }}>
        <div className="card">
          <h3>接続</h3>
          <label className="field">
            Euler Stream APIキー
            <input
              type="password"
              value={draft.eulerApiKey}
              placeholder="未設定（1日100回まで）"
              onChange={(e) => patch({ eulerApiKey: e.target.value })}
            />
          </label>
          <div className="notice" style={{ marginTop: 8 }}>
            <b>APIキーの取り方（無料・カード不要）</b>
            <ol style={{ margin: '6px 0 0 16px', padding: 0 }}>
              <li>ブラウザで eulerstream.com を開く</li>
              <li>無料の Community アカウントを作成する</li>
              <li>ダッシュボードで APIキーをコピーし、上の欄に貼り付ける</li>
            </ol>
            <div style={{ marginTop: 6 }}>
              設定すると 1日 2,500 回まで接続できます。キーを変更すると記録エンジンが再起動します。
            </div>
            <div style={{ marginTop: 6, color: 'var(--gold)' }}>
              このアプリを他の人に渡す場合、キーは各自で取得してもらってください。共有すると枠を食い合います。
            </div>
          </div>
          <label className="row" style={{ marginTop: 10, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={draft.waitUntilLive}
              onChange={(e) => patch({ waitUntilLive: e.target.checked })}
            />
            <span>配信開始まで自動で待機する</span>
          </label>
        </div>

        <div className="card">
          <h3>表示</h3>
          <label className="field">
            ダイヤ1個あたりの円換算（目安表示用）
            <input
              type="number"
              step="0.1"
              min="0"
              value={draft.diamondToJpy}
              onChange={(e) => patch({ diamondToJpy: Number(e.target.value) })}
            />
          </label>
          <label className="row" style={{ marginTop: 10, cursor: 'pointer' }}>
            <input type="checkbox" checked={draft.loadAvatars} onChange={(e) => patch({ loadAvatars: e.target.checked })} />
            <span>アバター画像を読み込む</span>
          </label>
          <div className="faint" style={{ fontSize: 11, marginLeft: 22 }}>
            オフにすると TikTok のサーバーへ一切通信しません（完全オフライン表示）。
          </div>
          <label className="field" style={{ marginTop: 10 }}>
            入室アラートを出す対象
            <select value={draft.alertMinTier} onChange={(e) => patch({ alertMinTier: Number(e.target.value) })}>
              <option value={0}>全員（にぎやかです）</option>
              <option value={1}>常連さん以上＋初見さん</option>
              <option value={2}>VIP以上＋初見さん</option>
            </select>
          </label>
          <label className="field" style={{ marginTop: 10 }}>
            ギフトアラートを出すダイヤ数
            <input
              type="number"
              min="1"
              step="10"
              value={draft.giftAlertDiamonds}
              onChange={(e) => patch({ giftAlertDiamonds: Number(e.target.value) })}
            />
          </label>
          <div className="faint" style={{ fontSize: 11 }}>
            これ以上のギフトは、流れるコメント欄ではなく右側に大きく表示されます。お礼を言い逃さないためです。
          </div>
        </div>

        <div className="card">
          <h3>貢献度スコア</h3>
          <div className="faint" style={{ fontSize: 11, marginBottom: 8 }}>
            重みを変えたら「再計算」を押すと、過去の配信までさかのぼって計算し直します。
          </div>
          <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <W label="来店1回" v={draft.scoring.weights.visit} on={(n) => patchScoring({ weights: { ...draft.scoring.weights, visit: n } })} />
            <W label="ダイヤ1個" v={draft.scoring.weights.diamond} on={(n) => patchScoring({ weights: { ...draft.scoring.weights, diamond: n } })} />
            <W label="コメント1件" v={draft.scoring.weights.comment} on={(n) => patchScoring({ weights: { ...draft.scoring.weights, comment: n } })} />
            <W label="いいね100" v={draft.scoring.weights.like} on={(n) => patchScoring({ weights: { ...draft.scoring.weights, like: n } })} />
            <W label="フォロー" v={draft.scoring.weights.follow} on={(n) => patchScoring({ weights: { ...draft.scoring.weights, follow: n } })} />
            <W label="サブスク" v={draft.scoring.weights.subscribe} on={(n) => patchScoring({ weights: { ...draft.scoring.weights, subscribe: n } })} />
            <W label="ハートミー1個" v={draft.scoring.weights.heartMe} on={(n) => patchScoring({ weights: { ...draft.scoring.weights, heartMe: n } })} />
            <label className="field">
              スコアの半減期（日）
              <select
                value={draft.scoring.halfLifeDays}
                onChange={(e) => patchScoring({ halfLifeDays: Number(e.target.value) })}
              >
                {[30, 60, 90, 180, 365].map((d) => (
                  <option key={d} value={d}>
                    {d}日
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>
            ハートミーは1ダイヤなので既定は 0 です（ダイヤと二重計上になるため）。気持ちの面で重く見たい場合だけ上げてください。
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn small" onClick={() => void recompute()} disabled={busy}>
              スコアを再計算
            </button>
            <button className="btn small" onClick={() => patchScoring(DEFAULT_SCORING)}>
              既定に戻す
            </button>
          </div>
        </div>

        <div className="card">
          <h3>カウントダウンチャレンジ</h3>
          <div className="faint" style={{ fontSize: 11, marginBottom: 8 }}>
            設定は専用画面に移動しました。演出のテスト再生(モニターでの実演)もそちらから行えます。
          </div>
          <button className="btn small" onClick={() => go('challenge')}>
            チャレンジ設定を開く
          </button>
        </div>

        <div className="card">
          <h3>報酬ミッション</h3>
          <div className="faint" style={{ fontSize: 11, marginBottom: 8 }}>
            TikTok は報酬条件を改定します。しきい値はファイルで編集できます。
          </div>
          <div className="row wrap">
            <button className="btn small" onClick={() => rpcFire('file.openMissions', undefined, 'ミッション設定を開く')}>
              ミッション設定を開く
            </button>
            <button
              className="btn small"
              onClick={() =>
                void rpc('m.reloadMissions', undefined)
                  .then((r) =>
                    toast({ level: r.ok ? 'info' : 'error', msgJa: r.ok ? '再読み込みしました。' : (r.error ?? '失敗しました') })
                  )
                  .catch((e: Error) => toast({ level: 'error', msgJa: e.message }))
              }
            >
              再読み込み
            </button>
          </div>
        </div>

        <div className="card">
          <h3>データ</h3>
          <div className="faint" style={{ fontSize: 11, wordBreak: 'break-all', marginBottom: 8 }}>
            {diag?.capabilities.dbPath}
          </div>
          <div className="row wrap">
            <button className="btn small" onClick={() => rpcFire('file.openDataDir', undefined, 'フォルダを開く')}>
              フォルダを開く
            </button>
            <button
              className="btn small"
              title="別の場所に貯めた記録に切り替えます（ポータブル版とインストール版で保存先が違う場合など）"
              onClick={() =>
                void rpc('file.pickDataDir', undefined)
                  .then((r) => {
                    if (!r) return;
                    toast({ level: 'info', msgJa: `記録を切り替えました（リスナー ${num(r.viewers)}人）。` });
                    reloadDiag();
                  })
                  .catch((e: Error) => toast({ level: 'error', msgJa: e.message }))
              }
            >
              別の記録に切り替える
            </button>
            <button
              className="btn small"
              onClick={() =>
                void rpc('file.backup', undefined)
                  .then((r) => r && toast({ level: 'info', msgJa: `バックアップを保存しました。` }))
                  .catch((e: Error) => toast({ level: 'error', msgJa: e.message }))
              }
            >
              バックアップを書き出す
            </button>
            <button
              className="btn small"
              onClick={() =>
                void rpc('file.exportCsv', { kind: 'viewers' })
                  .then((r) => r && toast({ level: 'info', msgJa: `${num(r.rows)}件を書き出しました。` }))
                  .catch((e: Error) => toast({ level: 'error', msgJa: e.message }))
              }
            >
              リスナー一覧を CSV 出力
            </button>
          </div>
          <label className="row" style={{ marginTop: 10, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={draft.captureDebug}
              onChange={(e) => patch({ captureDebug: e.target.checked })}
            />
            <span>デバッグ記録（不具合の再現用にイベントを保存）</span>
          </label>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn small danger" onClick={() => void purgeAll()}>
              すべての記録を削除
            </button>
          </div>
        </div>

        <div className="card">
          <h3>状態</h3>
          {diag ? (
            <table className="data">
              <tbody>
                <tr>
                  <td>計測開始日</td>
                  <td className="n">
                    {diag.capabilities.measuringSinceMs ? formatDateJa(diag.capabilities.measuringSinceMs) : '—'}
                  </td>
                </tr>
                <tr>
                  <td>データベース</td>
                  <td className="n">{bytes(diag.dbSizeBytes)}</td>
                </tr>
                <tr>
                  <td>リスナー / 配信</td>
                  <td className="n">
                    {num(diag.rowCounts.viewer ?? 0)} / {num(diag.rowCounts.stream_session ?? 0)}
                  </td>
                </tr>
                <tr>
                  <td>コメント / ギフト</td>
                  <td className="n">
                    {num(diag.rowCounts.comment ?? 0)} / {num(diag.rowCounts.gift_event ?? 0)}
                  </td>
                </tr>
                <tr>
                  <td>コメント全文検索</td>
                  <td className="n">{diag.capabilities.fts5 ? '有効' : '簡易検索'}</td>
                </tr>
                <tr>
                  <td>未対応イベント</td>
                  <td className="n">
                    {diag.unknownEventCounts.length === 0
                      ? 'なし'
                      : `${diag.unknownEventCounts.length}種 / ${num(
                          diag.unknownEventCounts.reduce((a, b) => a + b.count, 0)
                        )}件`}
                  </td>
                </tr>
                <tr>
                  <td>バージョン</td>
                  <td className="n">
                    {diag.appVersion} ({diag.gitSha.slice(0, 8)})
                  </td>
                </tr>
              </tbody>
            </table>
          ) : null}
          {diag && diag.unknownEventCounts.length > 0 ? (
            <div className="notice" style={{ marginTop: 8 }}>
              TikTok 側に、このアプリがまだ対応していない種類のイベントがあります。記録自体は続いていますが、
              数字が合わない場合はアプリの更新をご検討ください。
            </div>
          ) : null}
          <button className="btn small" style={{ marginTop: 10 }} onClick={() => go('licenses')}>
            ライセンス・ソースコード
          </button>
        </div>

        <div className="card">
          <h3>診断ログ</h3>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            演出のスキップ・レンダラの例外・ワーカーの遅延警告など。配信中は DevTools を開けないので、
            あとから原因を追えるようにここに残しています。同じ内容は件数だけが増えます。
          </div>
          {diagLog && diagLog.length > 0 ? (
            <div style={{ maxHeight: 260, overflow: 'auto' }}>
              <table className="data">
                <tbody>
                  {diagLog.slice(0, 40).map((e, i) => (
                    <tr key={String(e.atMs) + '-' + String(i)}>
                      <td style={{ whiteSpace: 'nowrap', verticalAlign: 'top', opacity: 0.7 }}>
                        {new Date(e.atMs).toLocaleTimeString('ja-JP')}
                      </td>
                      <td style={{ whiteSpace: 'nowrap', verticalAlign: 'top', opacity: 0.7 }}>{e.scope}</td>
                      <td style={{ fontSize: 12, wordBreak: 'break-word' }}>
                        {e.message}
                        {e.count > 1 ? <b style={{ marginLeft: 6 }}>×{num(e.count)}</b> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="muted" style={{ fontSize: 12 }}>まだ記録はありません。</div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="btn small" onClick={reloadDiagLog}>
              更新
            </button>
            <button className="btn small" onClick={() => rpcFire('diag.openLogDir', undefined, 'ログフォルダを開く')}>
              ログフォルダを開く
            </button>
          </div>
        </div>

        <div className="card">
          <h3>このアプリについて</h3>
          <div className="notice">
            これは <b>非公式ツール</b> です。TikTok / ByteDance とは一切関係がありません。
            TikTok の公開データを読み取って動作しており、利用規約に抵触する可能性があります。自己責任でご利用ください。
          </div>
          <ul className="muted" style={{ fontSize: 12, marginTop: 10, paddingLeft: 18 }}>
            <li>記録はこの PC の中だけに保存され、外部には一切送信されません。</li>
            <li>ログイン情報は使いません。コメントの送信機能もありません。</li>
            <li>
              来店回数・いいね数は<b>観測値</b>です。TikTok は視聴者が多い配信でイベントを間引くため、
              実際より少なくなることがあります。
            </li>
            <li>導入した日からの記録のみです。過去にさかのぼることはできません。</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

function W({ label, v, on }: { label: string; v: number; on: (n: number) => void }) {
  return (
    <label className="field">
      {label}
      <input type="number" step="0.5" min="0" value={v} onChange={(e) => on(Number(e.target.value))} />
    </label>
  );
}

