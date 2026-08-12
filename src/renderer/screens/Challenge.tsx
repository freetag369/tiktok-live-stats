import { useEffect, useRef, useState } from 'react';
import type {
  ChallengeConfig,
  ChallengeGiftClip,
  ChallengeGiftRule,
  ChallengeRouletteConfig,
  ChallengeRouletteSegment,
  ChallengeSeSlot,
  ChallengeTestEffectSpec,
  GiftBandFxConfig,
  GiftFxBand,
} from '@shared/dto';
import {
  CHALLENGE_MINI_IDS,
  CHALLENGE_SE_SLOTS,
  DEFAULT_CHALLENGE,
  DEFAULT_GIFT_BAND_FX,
  DEFAULT_GIFT_CLIPS,
  DEFAULT_MINI_FX,
  DEFAULT_ROULETTE,
  DEFAULT_SE_VOLUMES,
  ROULETTE_SEGMENTS_MAX,
  effectiveSeVolume,
} from '@shared/challenge';
import { rpc, useQuery } from '../ipc/client';
import { setSettings, toast } from '../state/uiStore';
import { playSe, SE_SOUNDS } from '../lib/se';
import { BAND_BGM, playBandBgm, type BgmHandle } from '../lib/bgm';
import { FX_CLIPS } from '../lib/fx';

/** 効果音スロットの表示名(設定画面の行ラベル)。 */
const SE_SLOT_LABELS: Record<(typeof CHALLENGE_SE_SLOTS)[number], string> = {
  press: 'ボタン押下',
  follow: 'フォロー妨害',
  like: 'いいね妨害',
  'gauge-full': 'いいねゲージ満タン(着弾)',
  'stock-full': 'いいねストック満杯(着弾)',
  'gift-t1': 'ギフト(小)',
  'gift-t2': 'ギフト(中)',
  'gift-t3': 'ギフト(大)',
  'gift-t4': 'ギフト(特大)',
  roulette: 'ルーレット回転',
  'roulette-hit': 'ルーレット確定',
  achieved: '達成',
};

/** キー入力を Electron accelerator 文字列へ。Esc でクリア、修飾キー単独は無視。 */
function hotkeyFromEvent(e: React.KeyboardEvent): string | null {
  const k = e.key;
  if (k === 'Escape') return '';
  if (k === 'Control' || k === 'Alt' || k === 'Shift' || k === 'Meta') return null;
  // 'CommandOrControl' は mac で Cmd、それ以外で Ctrl に解決される。mac で ctrlKey を
  // 見ると (1) Control を押したのに Cmd が登録される (2) Cmd 押下が「修飾なし」と判定され、
  // 単独キーを OS 全域で奪うアクセラレータが保存される — の2つの事故になる。
  const isMac = window.api.platform === 'darwin';
  const mods = [
    (isMac ? e.metaKey : e.ctrlKey) ? 'CommandOrControl' : '',
    isMac && e.ctrlKey ? 'Control' : '',
    e.altKey ? 'Alt' : '',
    e.shiftKey ? 'Shift' : '',
  ].filter(Boolean);
  let key = k;
  if (k === ' ') key = 'Space';
  else if (k.startsWith('Arrow')) key = k.slice(5); // ArrowUp -> Up
  else if (k.length === 1) key = k.toUpperCase();
  return [...mods, key].join('+');
}

let ruleSeq = 0;
let clipSeq = 0;

/** 簡易演出の表示名。id は shared/challenge.ts の CHALLENGE_MINI_IDS と一致させる。 */
const MINI_LABELS: Record<string, string> = {
  hammer: 'ピコピコハンマー(叩く)',
  stamp: 'ハンコ(+N がドン)',
  shock: '集中線(最軽量)',
};

/**
 * 同梱の演出クリップが用意されているギフトの表示名。ここに無い canonical も
 * 自由に追加できる(入力欄に直接書く)ので、あくまで既定行のラベル用。
 */
const GIFT_CANONICAL_LABELS: Record<string, string> = {
  universe: 'TikTok Universe',
  universe_plus: 'TikTok Universe+',
  tiktok_stars: 'TikTok Stars',
  white_pegasus: 'ホワイトペガサス',
  pegasus: 'ペガサス',
  fire_phoenix: 'ファイアフェニックス',
  thunder_falcon: 'サンダーファルコン',
  dragon: 'ドラゴン',
  lion: 'ライオン',
  lion_charge: '獅子奮迅',
  leon_lion: 'レオンとライオン',
  palace: '宮殿',
  whale_mirage: '鯨と蜃気楼',
  whale_sam: 'クジラのサム',
  seal_whale: 'アザラシとクジラ',
  adams_dream: "Adam's Dream",
};

/** テスト再生ハンドラ。null = このスロットは実演再生に非対応。 */
type OnTest = (spec: ChallengeTestEffectSpec) => void;

/**
 * 演出スロット → テスト再生 spec。gauge-full だけは null — 着弾演出がゲージの
 * fills 差分駆動(effect ではない)のため、状態を汚さずに再現できない。
 * ダイヤ数は tier 境界(shared/challenge.ts の tierForDiamonds)の代表値。
 */
function specForSlot(slot: ChallengeSeSlot): ChallengeTestEffectSpec | null {
  switch (slot) {
    case 'press':
      return { kind: 'press' };
    case 'follow':
      return { kind: 'follow' };
    case 'like':
      return { kind: 'like' };
    case 'gauge-full':
      return null;
    case 'stock-full':
      return { kind: 'stock-full' };
    case 'gift-t1':
      return { kind: 'gift', diamonds: 1 };
    case 'gift-t2':
      return { kind: 'gift', diamonds: 100 };
    case 'gift-t3':
      return { kind: 'gift', diamonds: 1000 };
    case 'gift-t4':
      return { kind: 'gift', diamonds: 5000 };
    case 'roulette':
    case 'roulette-hit':
      // 1回のスピンで回転開始音と確定音の両方が確認できる。
      return { kind: 'roulette' };
    case 'achieved':
      return { kind: 'achieved' };
  }
}

/** 「▶ モニター」ボタン。モニターウィンドウ上で演出を実演再生する。 */
function MonitorTestBtn({
  spec,
  onTest,
  busy,
  label,
  title,
  style,
}: {
  spec: ChallengeTestEffectSpec | null;
  onTest: OnTest;
  busy: boolean;
  label?: string;
  title?: string;
  style?: React.CSSProperties;
}): React.JSX.Element {
  return (
    <button
      className="btn small"
      disabled={spec === null || busy}
      title={
        spec === null
          ? (title ?? 'いいねゲージ連動のため実演再生はできません(♪で試聴できます)')
          : (title ?? 'モニターウィンドウでこの演出を実演再生(未保存の変更は先に保存されます)')
      }
      style={style}
      onClick={() => spec && onTest(spec)}
    >
      {label ?? '▶'}
    </button>
  );
}

type Tab = 'basic' | 'se' | 'fx' | 'roulette' | 'gifts';

const TABS: Array<[Tab, string]> = [
  ['basic', '基本設定'],
  ['se', '効果音'],
  ['fx', '演出'],
  ['roulette', 'ルーレット'],
  ['gifts', 'ギフト増減'],
];

/**
 * カウントダウンチャレンジの専用画面。設定(旧: 設定画面の1カード)をタブで
 * 整理し、各演出に「▶ モニター」= モニターウィンドウでの実演再生を付ける。
 *
 * 保存は challenge だけを部分送信する(cfg.set は main 側で浅いマージ)—
 * 設定画面と同じ settings.json を編集しても互いにクロバーしない。
 */
export function Challenge(): React.JSX.Element {
  const [draft, setDraft] = useState<ChallengeConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [tab, setTab] = useState<Tab>('basic');
  const [monitorOpen, setMonitorOpen] = useState(false);

  useEffect(() => {
    // マウント時に必ず最新を取り直す — 設定画面での変更後でも古い draft を種にしない。
    void rpc('cfg.get', undefined).then((s) => {
      setSettings(s);
      setDraft(s.challenge);
    });
    void rpc('monitor.status', undefined).then((r) => setMonitorOpen(r.open));
    return window.api.onMonitorState((s) => setMonitorOpen(s.open));
  }, []);

  if (!draft) return <div className="screen">読み込み中…</div>;

  const patch = (p: Partial<ChallengeConfig>): void => {
    setDraft((d) => (d ? { ...d, ...p } : d));
    setDirty(true);
  };

  async function save(): Promise<boolean> {
    if (!draft) return false;
    setBusy(true);
    try {
      // challenge だけを送る — 他の設定(APIキー等)は main が保持している値のまま。
      await rpc('cfg.set', { challenge: draft });
      const s = await rpc('cfg.get', undefined);
      setSettings(s);
      // 検証(clamp)後の値を draft に反映する — 保存されなかった値を画面に残さない。
      setDraft(s.challenge);
      setDirty(false);
      toast({ level: 'info', msgJa: '保存しました。' });
      return true;
    } catch (e) {
      toast({ level: 'error', msgJa: (e as Error).message });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function testFx(spec: ChallengeTestEffectSpec): Promise<void> {
    if (testBusy) return;
    setTestBusy(true);
    try {
      // 未保存の編集内容で実演する — 保存前の割り当てが再生される混乱を避ける。
      if (dirty && !(await save())) return;
      if (!monitorOpen) {
        await rpc('monitor.open', undefined);
        // モニターの演出 watermark はマウント時に「それ以前は再生済み」で確立
        // される。開いた直後に push すると捨てられるため、マウント完了を待つ。
        await new Promise((r) => setTimeout(r, 1500));
      }
      await rpc('challenge.testEffect', spec);
    } catch (e) {
      toast({ level: 'error', msgJa: (e as Error).message });
    } finally {
      setTestBusy(false);
    }
  }

  const onTest: OnTest = (spec) => void testFx(spec);

  return (
    <div className="screen">
      <div className="row" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>カウントダウンチャレンジ</h2>
        <div className="spacer" />
        <button
          className="btn small"
          onClick={() => void rpc(monitorOpen ? 'monitor.close' : 'monitor.open', undefined)}
        >
          {monitorOpen ? 'モニターを閉じる' : 'モニターを開く'}
        </button>
        <button className="btn primary" onClick={() => void save()} disabled={busy || !dirty}>
          {dirty ? '保存' : '保存済み'}
        </button>
      </div>

      <label className="row" style={{ cursor: 'pointer' }}>
        <input type="checkbox" checked={draft.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
        <span>有効にする(ライブ画面に操作カードが出ます)</span>
      </label>
      <div className="faint" style={{ fontSize: 11, marginLeft: 22, marginBottom: 8 }}>
        「0まで寝ない」型の企画: ボタンで数字が減り、フォロー・いいねで増え(妨害)、ギフトで増減します。
        各演出の「▶」を押すと、モニターウィンドウ(視聴者に見せる画面)でその演出を実演再生できます。
      </div>

      <div className="tabs">
        {TABS.map(([k, label]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>

      <div className="card" style={{ maxWidth: 860 }}>
        {tab === 'basic' ? <BasicSection cfg={draft} onPatch={patch} onTest={onTest} testBusy={testBusy} /> : null}
        {tab === 'se' ? <SoundSection cfg={draft} onPatch={patch} onTest={onTest} testBusy={testBusy} /> : null}
        {tab === 'fx' ? (
          <>
            <MiniFxSection cfg={draft} onPatch={patch} onTest={onTest} testBusy={testBusy} />
            <GiftClipsSection cfg={draft} onPatch={patch} onTest={onTest} testBusy={testBusy} />
            <GiftBandFxSection cfg={draft} onPatch={patch} onTest={onTest} testBusy={testBusy} />
          </>
        ) : null}
        {tab === 'roulette' ? <RouletteSection cfg={draft} onPatch={patch} onTest={onTest} testBusy={testBusy} /> : null}
        {tab === 'gifts' ? <GiftRulesSection cfg={draft} onPatch={patch} /> : null}
      </div>
    </div>
  );
}

interface SectionProps {
  cfg: ChallengeConfig;
  onPatch: (p: Partial<ChallengeConfig>) => void;
  onTest: OnTest;
  testBusy: boolean;
}

/** 基本設定: 数値・ホットキー・モニター表示先。 */
function BasicSection({ cfg, onPatch, onTest, testBusy }: SectionProps): React.JSX.Element {
  const { data: displays } = useQuery('monitor.displays', undefined, []);
  return (
    <>
      <h3>基本設定</h3>
      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <label className="field">
          企画タイトル
          <input type="text" value={cfg.title} onChange={(e) => onPatch({ title: e.target.value })} />
        </label>
        <label className="field">
          初期値
          <input
            type="number"
            min="1"
            value={cfg.initialValue}
            onChange={(e) => onPatch({ initialValue: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          ボタン1回の減算
          <input
            type="number"
            min="1"
            value={cfg.pressStep}
            onChange={(e) => onPatch({ pressStep: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          フォロー1件の加算(妨害)
          <input
            type="number"
            min="0"
            value={cfg.followStep}
            onChange={(e) => onPatch({ followStep: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          いいね◯件ごとに加算(妨害・0で無効)
          <input
            type="number"
            min="0"
            value={cfg.likeEvery}
            onChange={(e) => onPatch({ likeEvery: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          いいね妨害の加算量
          <input
            type="number"
            min="0"
            value={cfg.likeStep}
            onChange={(e) => onPatch({ likeStep: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          ストック満杯に必要な満タン回数(0で無効)
          <input
            type="number"
            min="0"
            value={cfg.likeStockCount}
            onChange={(e) => onPatch({ likeStockCount: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          ストック満杯の加算量(妨害)
          <input
            type="number"
            min="0"
            value={cfg.likeStockStep}
            onChange={(e) => onPatch({ likeStockStep: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          点滅を始める残数
          <input
            type="number"
            min="0"
            value={cfg.lowThreshold}
            onChange={(e) => onPatch({ lowThreshold: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          照明フラッシュのダイヤ閾値
          <input
            type="number"
            min="1"
            value={cfg.flashMinDiamonds ?? ''}
            placeholder="無効"
            onChange={(e) =>
              onPatch({ flashMinDiamonds: e.target.value === '' ? null : Number(e.target.value) })
            }
          />
        </label>
        <label className="field">
          ボタンのホットキー(物理USBボタン用)
          <input
            type="text"
            readOnly
            value={cfg.hotkey}
            placeholder="ここでキーを押す(Escで解除)"
            onKeyDown={(e) => {
              // Tab は捕獲しない — フォーカス移動を守り、保存すると OS 全域で
              // Tab を奪うグローバルショートカットになる事故も防ぐ。
              if (e.key === 'Tab') return;
              e.preventDefault();
              const acc = hotkeyFromEvent(e);
              if (acc !== null) onPatch({ hotkey: acc });
            }}
          />
        </label>
        <label className="field">
          モニターを出すディスプレイ
          <select
            value={cfg.monitorDisplayId ?? ''}
            onChange={(e) =>
              onPatch({ monitorDisplayId: e.target.value === '' ? null : Number(e.target.value) })
            }
          >
            <option value="">自動(最後のサブディスプレイ)</option>
            {(displays ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
                {d.primary ? '(メイン)' : ''} {d.width}×{d.height}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="row" style={{ marginTop: 8, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={cfg.monitorWindowed}
          onChange={(e) => onPatch({ monitorWindowed: e.target.checked })}
        />
        <span>モニターをウィンドウ表示にする(全画面にしない)</span>
      </label>
      <div className="faint" style={{ fontSize: 11, marginLeft: 22 }}>
        枠付きの普通のウィンドウで開き、移動やサイズ変更ができます。OBSで一部だけ映したいときや、同じ画面で作業しながら使うときに。
      </div>
      <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
        市販の「USB押しボタン」はキーボードとして認識されます。ボタンが送るキーを上の欄で押して登録してください。
        アプリにフォーカスが無くても反応します。
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <MonitorTestBtn
          spec={{ kind: 'achieved' }}
          onTest={onTest}
          busy={testBusy}
          label="▶ 達成演出をテスト"
          title="モニターで達成(CLEAR)の演出を実演再生します。リザルト画面は本番の達成時のみ表示されます。"
        />
        <MonitorTestBtn spec={{ kind: 'press' }} onTest={onTest} busy={testBusy} label="▶ 押下演出をテスト" />
      </div>
    </>
  );
}

/** 効果音: 全体音量とスロットごとの割り当て・個別音量・試聴・実演。 */
function SoundSection({ cfg, onPatch, onTest, testBusy }: SectionProps): React.JSX.Element {
  return (
    <>
      <h3>効果音</h3>
      <label className="row" style={{ cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={cfg.seEnabled}
          onChange={(e) => onPatch({ seEnabled: e.target.checked })}
        />
        <span>演出の効果音を鳴らす</span>
      </label>
      <div className="row" style={{ marginLeft: 22, gap: 8, alignItems: 'center' }}>
        <input
          type="range"
          min={0}
          max={100}
          value={cfg.seVolume}
          disabled={!cfg.seEnabled}
          onChange={(e) => onPatch({ seVolume: Number(e.target.value) })}
        />
        <span className="faint" style={{ fontSize: 11, minWidth: 48 }}>
          全体 {cfg.seVolume}
        </span>
      </div>
      {cfg.seEnabled ? (
        <>
          <div className="grid" style={{ gridTemplateColumns: '1fr', marginLeft: 22, marginTop: 6 }}>
            {CHALLENGE_SE_SLOTS.map((slot) => {
              const off = cfg.seSounds[slot] === 'off';
              return (
                <div key={slot} className="row" style={{ gap: 6, alignItems: 'center' }}>
                  <span className="faint" style={{ fontSize: 11, minWidth: 76 }}>
                    {SE_SLOT_LABELS[slot]}
                  </span>
                  <select
                    style={{ flex: 1, minWidth: 0 }}
                    value={cfg.seSounds[slot]}
                    onChange={(e) =>
                      onPatch({ seSounds: { ...cfg.seSounds, [slot]: e.target.value } })
                    }
                  >
                    <option value="off">鳴らさない</option>
                    {SE_SOUNDS.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    style={{ width: 84 }}
                    value={cfg.seVolumes[slot]}
                    disabled={off}
                    title="この音だけの音量(全体音量に対する割合)"
                    onChange={(e) =>
                      onPatch({ seVolumes: { ...cfg.seVolumes, [slot]: Number(e.target.value) } })
                    }
                  />
                  <span
                    className="faint"
                    style={{ fontSize: 11, minWidth: 32, textAlign: 'right' }}
                  >
                    {cfg.seVolumes[slot]}%
                  </span>
                  <button
                    className="btn small"
                    disabled={off}
                    title="この音を試聴(全体×個別の実際の音量で鳴ります)"
                    onClick={() =>
                      playSe(cfg.seSounds[slot], effectiveSeVolume(cfg.seVolume, cfg.seVolumes[slot]))
                    }
                  >
                    ♪
                  </button>
                  <MonitorTestBtn spec={specForSlot(slot)} onTest={onTest} busy={testBusy} />
                </div>
              );
            })}
          </div>
          <div className="row" style={{ marginTop: 8, marginLeft: 22 }}>
            <button
              className="btn small"
              onClick={() => onPatch({ seVolumes: { ...DEFAULT_SE_VOLUMES } })}
            >
              個別音量を既定(100%)に戻す
            </button>
          </div>
          <div className="faint" style={{ fontSize: 11, marginLeft: 22, marginTop: 4 }}>
            各行のスライダーは音ごとの個別音量で、上の全体音量に対する割合です。連打される
            「ボタン押下」を下げ、「達成」を上げる、といった調整に使えます。
            ♪ = この場で試聴、▶ = モニターで演出ごと実演再生。
          </div>
        </>
      ) : null}
      <div className="faint" style={{ fontSize: 11, marginLeft: 22, marginTop: 4 }}>
        モニターを開いているときはモニター側で、閉じているときはライブ画面側で鳴ります。
      </div>
    </>
  );
}

/** 簡易演出(SVG+CSS の軽量アニメ)。 */
function MiniFxSection({ cfg, onPatch, onTest, testBusy }: SectionProps): React.JSX.Element {
  return (
    <>
      <h3>簡易演出(軽量アニメ)</h3>
      <label className="row" style={{ cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={cfg.miniFxEnabled}
          onChange={(e) => onPatch({ miniFxEnabled: e.target.checked })}
        />
        <span>7セグの上に軽いアニメを重ねる</span>
      </label>
      <div className="faint" style={{ fontSize: 11, marginLeft: 22, marginBottom: 8 }}>
        映像クリップ(4秒)と違い一瞬で終わるので、ハートミーやいいねのような連発されるものに向いています。
        映像とは独立に動くので、両方出すことも片方だけにすることもできます。
      </div>
      {cfg.miniFxEnabled ? (
        <>
          <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', marginLeft: 22 }}>
            {CHALLENGE_SE_SLOTS.map((slot) => (
              <div key={slot} className="row" style={{ gap: 6, alignItems: 'center' }}>
                <span className="faint" style={{ fontSize: 11, minWidth: 88 }}>
                  {SE_SLOT_LABELS[slot]}
                </span>
                <select
                  style={{ flex: 1 }}
                  value={cfg.miniFx[slot]}
                  onChange={(e) => onPatch({ miniFx: { ...cfg.miniFx, [slot]: e.target.value } })}
                >
                  <option value="off">出さない</option>
                  {CHALLENGE_MINI_IDS.map((m) => (
                    <option key={m} value={m}>
                      {MINI_LABELS[m] ?? m}
                    </option>
                  ))}
                </select>
                <MonitorTestBtn spec={specForSlot(slot)} onTest={onTest} busy={testBusy} />
              </div>
            ))}
          </div>
          <div className="row" style={{ marginTop: 8, marginLeft: 22 }}>
            <button className="btn small" onClick={() => onPatch({ miniFx: { ...DEFAULT_MINI_FX } })}>
              簡易演出を既定に戻す
            </button>
          </div>
          <div className="faint" style={{ fontSize: 11, marginLeft: 22, marginTop: 4 }}>
            ギフトは下の「ギフトごとの演出クリップ」で個別に上書きできます(ハートミーは既定でハンマー)。
            ここのギフト(小)〜(特大)は、個別指定の無いギフトに効きます。
          </div>
        </>
      ) : null}
    </>
  );
}

/**
 * ギフトごとの演出クリップ割り当て。上から順に canonical 一致を探し、
 * どれにも当たらないギフトはダイヤ数の tier クリップ(汎用: 小〜特大)になる。
 */
function GiftClipsSection({ cfg, onPatch, onTest, testBusy }: SectionProps): React.JSX.Element {
  // プレビューはモニターと同じ黒地 + screen 合成で見せる(素材はアルファ無し)。
  const [preview, setPreview] = useState<{ key: number; url: string } | null>(null);

  const patchClip = (i: number, p: Partial<ChallengeGiftClip>): void => {
    onPatch({ giftClips: cfg.giftClips.map((c, j) => (j === i ? { ...c, ...p } : c)) });
  };

  return (
    <>
      <h3 style={{ marginTop: 14 }}>ギフトごとの演出クリップ</h3>
      <label className="row" style={{ cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={cfg.fxClipsEnabled}
          onChange={(e) => onPatch({ fxClipsEnabled: e.target.checked })}
        />
        <span>ギフト・達成でモニターに映像を重ねる</span>
      </label>
      <div className="faint" style={{ fontSize: 11, marginLeft: 22, marginBottom: 8 }}>
        上から順にギフト名(canonical)の一致を探し、最初に当たった1件のクリップを再生します。
        どれにも当たらないギフトはダイヤ数に応じた「汎用」クリップになります。
        ▶ = この場で試写、▶ モニター = モニターで実演再生。
      </div>

      {cfg.fxClipsEnabled ? (
        <>
          {cfg.giftClips.map((c, i) => (
            <div className="challenge-rule" key={c.id}>
              <label className="field">
                ギフト名(canonical)
                <input
                  type="text"
                  placeholder="例: dragon"
                  value={c.canonical}
                  title={GIFT_CANONICAL_LABELS[c.canonical] ?? ''}
                  onChange={(e) => patchClip(i, { canonical: e.target.value.trim().toLowerCase() })}
                />
              </label>
              <div className="row" style={{ gap: 6, flex: 1 }}>
                <label className="field" style={{ flex: 1 }}>
                  {GIFT_CANONICAL_LABELS[c.canonical] ?? '流す映像'}
                  <select value={c.clip} onChange={(e) => patchClip(i, { clip: e.target.value })}>
                    <option value="off">出さない</option>
                    {FX_CLIPS.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="btn small"
                  disabled={c.clip === 'off'}
                  title="このクリップを試写"
                  style={{ alignSelf: 'flex-end' }}
                  onClick={() => {
                    const url = FX_CLIPS.find((f) => f.id === c.clip)?.url;
                    if (url) setPreview({ key: clipSeq++, url });
                  }}
                >
                  ▶
                </button>
                <label className="field" style={{ width: 168 }}>
                  簡易演出
                  <select value={c.mini} onChange={(e) => patchClip(i, { mini: e.target.value })}>
                    <option value="off">出さない</option>
                    {CHALLENGE_MINI_IDS.map((m) => (
                      <option key={m} value={m}>
                        {MINI_LABELS[m] ?? m}
                      </option>
                    ))}
                  </select>
                </label>
                <MonitorTestBtn
                  spec={c.canonical !== '' ? { kind: 'gift', canonical: c.canonical, diamonds: 100 } : null}
                  onTest={onTest}
                  busy={testBusy}
                  label="▶ モニター"
                  title={
                    c.canonical !== ''
                      ? 'このギフトが届いた体でモニターに実演再生(クリップ+簡易演出+効果音)'
                      : 'ギフト名(canonical)を入力すると実演再生できます'
                  }
                  style={{ alignSelf: 'flex-end' }}
                />
              </div>
              <button
                className="btn small danger"
                onClick={() => onPatch({ giftClips: cfg.giftClips.filter((_, j) => j !== i) })}
              >
                削除
              </button>
            </div>
          ))}
          <div className="row" style={{ marginTop: 8 }}>
            <button
              className="btn small"
              onClick={() =>
                onPatch({
                  giftClips: [
                    ...cfg.giftClips,
                    { id: `clip-${Date.now().toString(36)}-${clipSeq++}`, canonical: '', clip: 'off', mini: 'off' },
                  ],
                })
              }
            >
              割り当てを追加
            </button>
            <button
              className="btn small"
              onClick={() => onPatch({ giftClips: DEFAULT_GIFT_CLIPS.map((c) => ({ ...c })) })}
            >
              割り当てを既定に戻す
            </button>
          </div>

          {preview ? (
            <div className="fx-preview">
              <video
                key={preview.key}
                src={preview.url}
                autoPlay
                muted
                playsInline
                onEnded={() => setPreview(null)}
                onError={() => setPreview(null)}
              />
              <button className="btn small" onClick={() => setPreview(null)}>
                閉じる
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}

/**
 * ダイヤ帯域カットイン(バンド演出)。ダイヤ数の帯域で全画面カットインを再生し、
 * 再生中は worker がカウンタを凍結する。一致時は「ギフトごとの演出クリップ」より
 * 優先される。除外(既定: ハートミー 7934)は giftId ベース — ライブ経路では
 * canonical が乗らないため。
 */
function GiftBandFxSection({ cfg, onPatch, onTest, testBusy }: SectionProps): React.JSX.Element {
  const bf = cfg.giftBandFx;
  const [preview, setPreview] = useState<{ key: number; url: string } | null>(null);
  // BGM試聴。playSe と違い長尺・ループなのでハンドルを持って止められるようにする。
  // ハンドルは ref(再レンダーで作り直さない)、ボタン表示用の id だけ state。
  const auditionRef = useRef<BgmHandle | null>(null);
  const [auditionId, setAuditionId] = useState<string | null>(null);
  useEffect(
    () => () => {
      auditionRef.current?.stop(0); // 画面遷移で鳴りっぱなしにしない
    },
    []
  );
  const toggleAudition = (id: string): void => {
    const playing = auditionId;
    auditionRef.current?.stop(0);
    auditionRef.current = null;
    setAuditionId(null);
    if (playing === id) return; // 同じ曲をもう一度 → 停止だけ
    auditionRef.current = playBandBgm(id, bf.bgmVolume);
    if (auditionRef.current) setAuditionId(id);
  };

  const patchBf = (p: Partial<GiftBandFxConfig>): void => {
    onPatch({ giftBandFx: { ...bf, ...p } });
  };
  const patchBand = (i: number, p: Partial<GiftFxBand>): void => {
    patchBf({ bands: bf.bands.map((b, j) => (j === i ? { ...b, ...p } : b)) });
  };

  return (
    <>
      <h3 style={{ marginTop: 14 }}>ダイヤ数のカットイン演出(カウント一時停止)</h3>
      <label className="row" style={{ cursor: 'pointer' }}>
        <input type="checkbox" checked={bf.enabled} onChange={(e) => patchBf({ enabled: e.target.checked })} />
        <span>ダイヤ数の帯域で全画面カットインを再生する</span>
      </label>
      <div className="faint" style={{ fontSize: 11, marginLeft: 22, marginBottom: 8 }}>
        帯域に一致したギフトで画面全体にカットイン動画を再生し、<b>再生中はカウントを一時停止</b>します
        (その間のギフト・いいね・フォローは捨てられず、演出後に順番に反映されます)。
        一致した帯域は「ギフトごとの演出クリップ」より優先。ハートミー等の除外は下の giftId 欄で指定します。
      </div>

      {bf.enabled ? (
        <>
          {bf.bands.map((b, i) => (
            <div className="challenge-rule" key={b.id}>
              <label className="field" style={{ width: 92 }}>
                💎下限
                <input
                  type="number"
                  min="1"
                  value={b.min}
                  onChange={(e) => patchBand(i, { min: Number(e.target.value) })}
                />
              </label>
              <label className="field" style={{ width: 92 }}>
                💎上限
                <input
                  type="number"
                  min="1"
                  value={b.max}
                  onChange={(e) => patchBand(i, { max: Number(e.target.value) })}
                />
              </label>
              <div className="row" style={{ gap: 6, flex: 1 }}>
                <label className="field" style={{ flex: 1 }}>
                  カットイン動画
                  <select value={b.clip} onChange={(e) => patchBand(i, { clip: e.target.value })}>
                    <option value="off">出さない</option>
                    {FX_CLIPS.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="btn small"
                  disabled={b.clip === 'off'}
                  title="このクリップを試写"
                  style={{ alignSelf: 'flex-end' }}
                  onClick={() => {
                    const url = FX_CLIPS.find((f) => f.id === b.clip)?.url;
                    if (url) setPreview({ key: clipSeq++, url });
                  }}
                >
                  ▶
                </button>
                <label className="field" style={{ width: 84 }}>
                  秒数
                  <input
                    type="number"
                    min="1"
                    max="30"
                    value={b.durationSec}
                    onChange={(e) => patchBand(i, { durationSec: Number(e.target.value) })}
                  />
                </label>
                <label className="field" style={{ width: 190 }}>
                  BGM
                  <select value={b.bgm} onChange={(e) => patchBand(i, { bgm: e.target.value })}>
                    <option value="off">鳴らさない</option>
                    {BAND_BGM.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="btn small"
                  disabled={b.bgm === 'off'}
                  title={auditionId === b.bgm ? '試聴を停止' : 'このBGMを試聴'}
                  style={{ alignSelf: 'flex-end' }}
                  onClick={() => toggleAudition(b.bgm)}
                >
                  {auditionId === b.bgm ? '■' : '♪'}
                </button>
                <MonitorTestBtn
                  spec={b.clip !== 'off' ? { kind: 'gift', bandId: b.id, diamonds: b.min } : null}
                  onTest={onTest}
                  busy={testBusy}
                  label="▶ モニター"
                  title={
                    b.clip !== 'off'
                      ? 'この帯域のカットイン(動画+BGM)をモニターで実演再生。テスト中はカウントを止めません。'
                      : 'カットイン動画を選ぶと実演再生できます'
                  }
                  style={{ alignSelf: 'flex-end' }}
                />
                <label className="row" style={{ cursor: 'pointer', alignSelf: 'flex-end', paddingBottom: 6 }}>
                  <input
                    type="checkbox"
                    checked={b.enabled}
                    onChange={(e) => patchBand(i, { enabled: e.target.checked })}
                  />
                  <span className="faint" style={{ fontSize: 11 }}>
                    有効
                  </span>
                </label>
              </div>
            </div>
          ))}
          <div className="row" style={{ gap: 10, marginTop: 8, alignItems: 'center' }}>
            <label className="row" style={{ cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={bf.bgmEnabled}
                onChange={(e) => patchBf({ bgmEnabled: e.target.checked })}
              />
              <span>カットイン中にBGMを鳴らす</span>
            </label>
            <input
              type="range"
              min="0"
              max="100"
              value={bf.bgmVolume}
              disabled={!bf.bgmEnabled}
              onChange={(e) => patchBf({ bgmVolume: Number(e.target.value) })}
            />
            <span className="faint" style={{ fontSize: 11, minWidth: 56 }}>
              音量 {bf.bgmVolume}
            </span>
          </div>
          <div className="faint" style={{ fontSize: 11, marginLeft: 22, marginTop: 2 }}>
            BGM中はそのギフトの効果音(ジングル)は鳴りません。音量は効果音の設定とは独立です。
          </div>
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <label className="field" style={{ flex: 1 }}>
              最上位の上限を超えたギフト
              <select
                value={bf.overflow}
                onChange={(e) => patchBf({ overflow: e.target.value === 'off' ? 'off' : 'top' })}
              >
                <option value="top">最上位のカットインを再生する</option>
                <option value="off">カットインなし(従来の演出クリップ)</option>
              </select>
            </label>
            <label className="field" style={{ flex: 1 }}>
              除外する giftId(カンマ区切り)
              <input
                type="text"
                defaultValue={bf.excludeGiftIds.join(', ')}
                placeholder="例: 7934"
                onBlur={(e) =>
                  patchBf({
                    excludeGiftIds: e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
          </div>
          <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
            既定の除外はハートミー(giftId 7934)。1ダイヤの高頻度ギフトにカットインを出すと画面が埋まります。
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <button
              className="btn small"
              onClick={() => onPatch({ giftBandFx: structuredClone(DEFAULT_GIFT_BAND_FX) })}
            >
              カットイン設定を既定に戻す
            </button>
          </div>

          {preview ? (
            <div className="fx-preview">
              <video
                key={preview.key}
                src={preview.url}
                autoPlay
                muted
                playsInline
                onEnded={() => setPreview(null)}
                onError={() => setPreview(null)}
              />
              <button className="btn small" onClick={() => setPreview(null)}>
                閉じる
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}

/**
 * ギフトルーレットの設定セクション。
 * トリガーに一致したギフトは「ギフト増減」規則を通らない(ルーレットが
 * 増減を置き換える)— worker/challenge.ts の handleEvent と同じ規約。
 */
function RouletteSection({ cfg, onPatch, onTest, testBusy }: SectionProps): React.JSX.Element {
  const rl = cfg.roulette;
  const patchRoulette = (p: Partial<ChallengeRouletteConfig>): void =>
    onPatch({ roulette: { ...rl, ...p } });
  const patchSeg = (i: number, p: Partial<ChallengeRouletteSegment>): void =>
    patchRoulette({ segments: rl.segments.map((s, j) => (j === i ? { ...s, ...p } : s)) });
  const totalWeight = rl.segments.reduce((s, x) => s + Math.max(0, x.weight), 0);

  return (
    <>
      <div className="row">
        <h3 style={{ margin: 0 }}>ギフトルーレット</h3>
        <div className="spacer" />
        <MonitorTestBtn
          spec={{ kind: 'roulette' }}
          onTest={onTest}
          busy={testBusy}
          label="▶ モニターで回す"
          title="いまの盤面で抽選してモニターのルーレットを実演再生します(カウントは変わりません)"
        />
      </div>
      <label className="row" style={{ cursor: 'pointer', marginTop: 8 }}>
        <input
          type="checkbox"
          checked={rl.enabled}
          onChange={(e) => patchRoulette({ enabled: e.target.checked })}
        />
        <span>特定ギフトでルーレットを回す</span>
      </label>
      <div className="faint" style={{ fontSize: 11, marginLeft: 22, marginBottom: 8 }}>
        トリガーギフト(既定: ハートミー)が届くとモニターでルーレットが回り、出目が数字に
        {rl.direction === 'sub' ? '減算' : '加算'}されます。トリガーに一致したギフトは「ギフト増減」規則を通りません。
      </div>
      {rl.enabled ? (
        <>
          <div className="row" style={{ gap: 8, marginLeft: 22 }}>
            <label className="field" style={{ width: 130 }}>
              トリガー giftId
              <input
                type="text"
                placeholder="例: 7934(ハートミー)"
                value={rl.giftId}
                onChange={(e) => patchRoulette({ giftId: e.target.value.trim() })}
              />
            </label>
            <label className="field" style={{ flex: 1 }}>
              ギフト名(部分一致・IDが変わった時の保険)
              <input
                type="text"
                placeholder="例: heart me"
                value={rl.giftName}
                onChange={(e) => patchRoulette({ giftName: e.target.value.toLowerCase() })}
              />
            </label>
            <label className="field" style={{ width: 150 }}>
              出目の方向
              <select
                value={rl.direction}
                onChange={(e) => patchRoulette({ direction: e.target.value as 'add' | 'sub' })}
              >
                <option value="add">増やす(妨害)</option>
                <option value="sub">減らす(応援)</option>
              </select>
            </label>
          </div>
          {rl.segments.map((s, i) => (
            <div className="row" key={i} style={{ gap: 8, marginLeft: 22, alignItems: 'center' }}>
              <label className="field" style={{ width: 110 }}>
                {i === 0 ? '出目' : ''}
                <input
                  type="number"
                  min="1"
                  value={s.amount}
                  onChange={(e) => patchSeg(i, { amount: Number(e.target.value) })}
                />
              </label>
              <label className="field" style={{ width: 110 }}>
                {i === 0 ? '重み' : ''}
                <input
                  type="number"
                  min="0"
                  value={s.weight}
                  onChange={(e) => patchSeg(i, { weight: Number(e.target.value) })}
                />
              </label>
              <span className="faint" style={{ fontSize: 11, minWidth: 54, textAlign: 'right' }}>
                {totalWeight > 0 ? `${((Math.max(0, s.weight) / totalWeight) * 100).toFixed(1)}%` : '—'}
              </span>
              <button
                className="btn small danger"
                disabled={rl.segments.length <= 1}
                onClick={() => patchRoulette({ segments: rl.segments.filter((_, j) => j !== i) })}
              >
                削除
              </button>
            </div>
          ))}
          <div className="row" style={{ marginTop: 8, marginLeft: 22 }}>
            <button
              className="btn small"
              disabled={rl.segments.length >= ROULETTE_SEGMENTS_MAX}
              onClick={() => patchRoulette({ segments: [...rl.segments, { amount: 5, weight: 10 }] })}
            >
              出目を追加
            </button>
            <button className="btn small" onClick={() => onPatch({ roulette: structuredClone(DEFAULT_ROULETTE) })}>
              ルーレットを既定に戻す
            </button>
          </div>
          <div className="faint" style={{ fontSize: 11, marginLeft: 22, marginTop: 4 }}>
            確率 = 重み ÷ 重みの合計。既定は +5(30%) +10(25%) +20(20%) +30(15%) +100(9%) +1000(1%)。
            重み 0 の出目は出ません。
          </div>
        </>
      ) : null}
    </>
  );
}

/** ギフト → カウント増減の規則。上から順に評価し、最初に一致した1件だけ適用。 */
function GiftRulesSection({
  cfg,
  onPatch,
}: {
  cfg: ChallengeConfig;
  onPatch: (p: Partial<ChallengeConfig>) => void;
}): React.JSX.Element {
  const gd = cfg.giftDefault;

  const patchRule = (i: number, p: Partial<ChallengeGiftRule>): void => {
    const rules = cfg.giftRules.map((r, j) => (j === i ? { ...r, ...p } : r));
    onPatch({ giftRules: rules });
  };

  return (
    <>
      <h3>ギフトの増減</h3>
      <div className="row" style={{ gap: 8 }}>
        <label className="field" style={{ flex: 1 }}>
          既定の動作(規則に一致しないギフト)
          <select
            value={gd === null ? 'ignore' : gd.mode}
            onChange={(e) => {
              const v = e.target.value;
              onPatch({
                giftDefault:
                  v === 'ignore' ? null : { mode: v as 'fixed' | 'perDiamond', amount: gd?.amount ?? 1 },
              });
            }}
          >
            <option value="perDiamond">ダイヤ数 × 量</option>
            <option value="fixed">固定量</option>
            <option value="ignore">無視する</option>
          </select>
        </label>
        {gd !== null ? (
          <label className="field" style={{ width: 110 }}>
            量(正=増える)
            <input
              type="number"
              value={gd.amount}
              onChange={(e) => onPatch({ giftDefault: { ...gd, amount: Number(e.target.value) } })}
            />
          </label>
        ) : null}
      </div>
      <div className="faint" style={{ fontSize: 11, marginBottom: 8 }}>
        正の値=数字が<b>増える</b>(妨害)、負の値=数字が<b>減る</b>(応援)。既定は「1ダイヤにつき +1」です。
      </div>

      {cfg.giftRules.map((r, i) => (
        <div className="challenge-rule" key={r.id}>
          <label className="field">
            ギフト名(canonical)または最低ダイヤ
            <input
              type="text"
              placeholder="例: rose / 500"
              value={r.canonical ?? (r.minDiamonds != null ? String(r.minDiamonds) : '')}
              onChange={(e) => {
                const v = e.target.value.trim();
                if (v === '') patchRule(i, { canonical: undefined, minDiamonds: undefined });
                else if (/^\d+$/.test(v)) patchRule(i, { canonical: undefined, minDiamonds: Number(v) });
                else patchRule(i, { canonical: v.toLowerCase(), minDiamonds: undefined });
              }}
            />
          </label>
          <div className="row" style={{ gap: 6 }}>
            <label className="field" style={{ width: 96 }}>
              方式
              <select value={r.mode} onChange={(e) => patchRule(i, { mode: e.target.value as 'fixed' | 'perDiamond' })}>
                <option value="fixed">固定量</option>
                <option value="perDiamond">ダイヤ比例</option>
              </select>
            </label>
            <label className="field" style={{ width: 80 }}>
              量
              <input type="number" value={r.amount} onChange={(e) => patchRule(i, { amount: Number(e.target.value) })} />
            </label>
            <label className="row faint" style={{ fontSize: 11, cursor: 'pointer', gap: 3, whiteSpace: 'nowrap' }}>
              <input
                type="checkbox"
                checked={r.flash === true}
                onChange={(e) => patchRule(i, { flash: e.target.checked || undefined })}
              />
              照明
            </label>
          </div>
          <button
            className="btn small danger"
            onClick={() => onPatch({ giftRules: cfg.giftRules.filter((_, j) => j !== i) })}
          >
            削除
          </button>
        </div>
      ))}
      <div className="row" style={{ marginTop: 8 }}>
        <button
          className="btn small"
          onClick={() =>
            onPatch({
              giftRules: [
                ...cfg.giftRules,
                { id: `rule-${Date.now().toString(36)}-${ruleSeq++}`, mode: 'fixed', amount: -100 },
              ],
            })
          }
        >
          ギフト規則を追加
        </button>
        <button className="btn small" onClick={() => onPatch(structuredClone(DEFAULT_CHALLENGE))}>
          チャレンジ設定をすべて既定に戻す
        </button>
      </div>
    </>
  );
}
