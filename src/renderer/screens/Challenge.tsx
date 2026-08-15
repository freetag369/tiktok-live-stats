import { useEffect, useRef, useState } from 'react';
import type {
  ChallengeCommentRule,
  ChallengeConfig,
  ChallengeGiftClip,
  ChallengeGiftRule,
  ChallengeRouletteConfig,
  RouletteSoundConfig,
  ChallengeRouletteSegment,
  ChallengeSeSlot,
  ChallengeTestEffectSpec,
  FanStampConfig,
  TapBoostConfig,
  TapBoostRule,
  GiftBandFxConfig,
  GiftFullCutConfig,
  GiftFullCutRule,
  GiftFxBand,
  GiftRepeatFxConfig,
  JoinRouletteConfig,
  RoulettePattern,
} from '@shared/dto';
import { ROULETTE_PATTERNS } from '@shared/dto';
import {
  CHALLENGE_MINI_IDS,
  CHALLENGE_SE_SLOTS,
  COMMENT_RULES_MAX,
  DEFAULT_FAN_STAMP,
  DEFAULT_TAP_BOOST,
  DEFAULT_TAP_BOOST_RULE,
  DEFAULT_GIFT_BAND_FX,
  DEFAULT_GIFT_FULL_CUT,
  DEFAULT_GIFT_REPEAT_FX,
  GIFT_FX_FREEZE_MAX_TOTAL_MS,
  GIFT_FX_REPEAT_MAX,
  GIFT_FX_REPEAT_MAX_MS,
  GIFT_FX_REPEAT_MIN_MS,
  DEFAULT_GIFT_CLIPS,
  DEFAULT_MINI_FX,
  DEFAULT_JOIN_ROULETTE,
  DEFAULT_ROULETTE,
  DEFAULT_SE_VOLUMES,
  ROULETTE_LABEL_MAX,
  ROULETTE_REELS_MAX,
  ROULETTE_SEGMENTS_MAX,
  ROULETTES_MAX,
  TAP_BOOST_COUNT_CLIPS,
  TAP_BOOST_COUNT_MS,
  TAP_BOOST_DURATION_MAX_SEC,
  TAP_BOOST_DURATION_MIN_SEC,
  TAP_BOOST_INTRO_CLIPS,
  TAP_BOOST_INTRO_MS,
  TAP_BOOST_LOOP_CLIPS,
  TAP_BOOST_MULT_MAX,
  TAP_BOOST_RULES_MAX,
  TAP_BOOST_MULT_MIN,
  TAP_BOOST_RESULT_CLIPS,
  effectiveSeVolume,
} from '@shared/challenge';
import { TAP_BOOST_RESULT_MS } from '@shared/boost-settle';
import { rpc, rpcFire, useQuery } from '../ipc/client';
import { useConfirm } from '../components/ConfirmDialog';
import { setSettings, toast } from '../state/uiStore';
import { useLive } from '../state/liveStore';
import { playSe, SE_SOUNDS } from '../lib/se';
import { BAND_BGM, playBandBgm, ROULETTE_BGM, ROULETTE_SPIN_SE, type BgmHandle } from '../lib/bgm';
import { FX_CLIPS, FX_CLIP_GROUPS, isFullCutClip } from '../lib/fx';

/**
 * クリップ選択の <option> 群。**3箇所(ギフトごとの演出クリップ / 全面カット /
 * ダイヤ数帯)で共有**する — 素材が42本増えて全66件になったので、素で並べると
 * 選べない。optgroup で「全面カット / 帯域 / ギフト専用 / 汎用」に束ねる。
 * 区切りと並び順の出所は lib/fx.ts の FX_CLIP_GROUPS。
 */
function FxClipOptions(): React.JSX.Element {
  return (
    <>
      {FX_CLIP_GROUPS.map((g) => {
        const items = FX_CLIPS.filter((f) => f.group === g.key);
        // 素材が未投入のグループ(0件)は optgroup ごと出さない。
        if (items.length === 0) return null;
        return (
          <optgroup key={g.key} label={g.label}>
            {items.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </optgroup>
        );
      })}
    </>
  );
}

/** 効果音スロットの表示名(設定画面の行ラベル)。 */
const SE_SLOT_LABELS: Record<(typeof CHALLENGE_SE_SLOTS)[number], string> = {
  press: 'ボタン押下',
  follow: 'フォロー妨害',
  like: 'いいね妨害',
  'gauge-full': 'いいねゲージ満タン(着弾)',
  'stock-full': 'いいねストック満杯(着弾)',
  comment: 'コメント妨害(指定コメント)',
  'gift-t1': 'ギフト(小)',
  'gift-t2': 'ギフト(中)',
  'gift-t3': 'ギフト(大)',
  'gift-t4': 'ギフト(特大)',
  helper: 'お助け(ファンスタンプ)',
  roulette: 'ルーレット回転',
  'roulette-near': 'ルーレット 止まりそう(あと1個の溜め)',
  'roulette-kick': 'ルーレット キック(衝撃系パターンの一撃)',
  'roulette-hit': 'ルーレット確定',
  'boost-start': 'ブースト タップ開始',
  'boost-end': 'ブースト着弾(一括減算)',
  achieved: '達成',
};

/**
 * 各スロットが「どの瞬間に鳴るか」の1行説明(設定画面でラベルの下に出る)。
 * 演出の名前だけでは着弾チェーンのどこで鳴るのかが読み取れず、目的の行を
 * 探せないという報告があったので、鳴る瞬間を行そのものに書いてある。
 *
 * 「(モニター表示中のみ)」の5つは useChallengeSe の slotFor が null を返すか
 * 対応する effect kind がそもそも無く、MonitorView の着弾/停止タイマーからしか
 * 鳴らないもの — ライブ画面だけで使っていると無音になる。
 */
const SE_SLOT_HINTS: Record<(typeof CHALLENGE_SE_SLOTS)[number], string> = {
  press: 'ボタンを押した瞬間',
  follow: 'フォロー妨害で数字が増えた瞬間',
  like: 'いいね妨害の +N が流れる瞬間',
  'gauge-full': 'ゲージが満タンになり、弾が7セグに着弾して数字が増える瞬間(モニター表示中のみ)',
  'stock-full':
    'ドットが全部埋まったあと、カットイン(約5秒)が終わって7セグに +N が乗る瞬間(モニター表示中のみ)。カットイン動画そのものの音量は「演出」タブ',
  comment: 'コメント応援で数字が減った瞬間',
  'gift-t1': 'ダイヤ 1〜99 のギフトを受け取った瞬間',
  'gift-t2': 'ダイヤ 100〜999 のギフトを受け取った瞬間',
  'gift-t3': 'ダイヤ 1000〜4999 のギフトを受け取った瞬間',
  'gift-t4': 'ダイヤ 5000〜 のギフトを受け取った瞬間',
  helper: 'お助けギフト(ファンスタンプ)を受け取った瞬間。「お助け」タブでも同じ設定を変えられます',
  roulette: 'リールが回り始める瞬間',
  'roulette-near': '当たりの1つ手前に着いて溜めに入る瞬間(モニター表示中のみ)',
  'roulette-kick': 'フェイク停止から蹴り出される瞬間。この演出が出たときだけ(モニター表示中のみ)',
  'roulette-hit': 'リールが止まって出目が確定する瞬間(モニター表示中のみ)',
  'boost-start':
    'ブーストの 3・2・1 カウントダウンが明けてタップウィンドウに入る瞬間(モニター表示中のみ)',
  'boost-end': '溜めたタップ数が7セグに着弾して一括減算される瞬間(モニター表示中のみ)',
  achieved: '目標を達成して CLEAR が出る瞬間',
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
let rlSeq = 0;
let crSeq = 0;

/** 簡易演出の表示名。id は shared/challenge.ts の CHALLENGE_MINI_IDS と一致させる。 */
const MINI_LABELS: Record<string, string> = {
  hammer: 'ピコピコハンマー(叩く)',
  stamp: 'ハンコ(+N がドン)',
  shock: '集中線(最軽量)',
  panic: '絶望カットイン(写真)',
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
 * 演出スロット → テスト再生 spec。
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
      // 実演専用の kind。モニターが現在値のまま着弾チェーン(弾→7セグ)を試写する。
      return { kind: 'gauge-full' };
    case 'stock-full':
      return { kind: 'stock-full' };
    case 'comment':
      return { kind: 'comment' };
    case 'gift-t1':
      return { kind: 'gift', diamonds: 1 };
    case 'gift-t2':
      return { kind: 'gift', diamonds: 100 };
    case 'gift-t3':
      return { kind: 'gift', diamonds: 1000 };
    case 'gift-t4':
      return { kind: 'gift', diamonds: 5000 };
    case 'helper':
      // お助けは giftId 未設定でも確認できる専用の実演 kind(HelperSection と同じ)。
      return { kind: 'fanStamp' };
    case 'roulette':
    case 'roulette-near':
    case 'roulette-hit':
      // 1回のスピンで回転開始音・止まりそう・確定音がまとめて確認できる。
      return { kind: 'roulette' };
    case 'roulette-kick':
      // キック音は衝撃系パターン(キック・巻き戻し等)でしか鳴らないので、
      // 代表して「キック」を狙い撃ちで再生する。
      return { kind: 'roulette', pattern: 'kick' };
    case 'boost-start':
    case 'boost-end':
      // 1回の実演で起動カットイン → タップ開始 → 着弾までまとめて確認できる。
      return { kind: 'tapBoost' };
    case 'achieved':
      return { kind: 'achieved' };
  }
}

/** 「▶ モニター」ボタン。モニターウィンドウ上で演出を実演再生する。 */
function MonitorTestBtn({
  spec,
  onTest,
  busy,
  disabled,
  label,
  title,
  style,
}: {
  spec: ChallengeTestEffectSpec | null;
  onTest: OnTest;
  busy: boolean;
  /** 追加の無効化条件(例: 簡易演出スロットが「出さない」)。title で理由を添えること。 */
  disabled?: boolean;
  label?: string;
  title?: string;
  style?: React.CSSProperties;
}): React.JSX.Element {
  return (
    <button
      className="btn small"
      disabled={spec === null || busy || disabled}
      title={
        spec === null
          ? (title ?? 'この演出は実演再生に対応していません(♪で試聴できます)')
          : (title ?? 'モニターウィンドウでこの演出を実演再生(未保存の変更は先に保存されます)')
      }
      style={style}
      onClick={() => spec && onTest(spec)}
    >
      {label ?? '▶'}
    </button>
  );
}

type Tab = 'basic' | 'se' | 'fx' | 'roulette' | 'gifts' | 'comment' | 'helper' | 'boost';

const TABS: Array<[Tab, string]> = [
  ['basic', '基本設定'],
  ['se', '効果音'],
  ['fx', '演出'],
  ['roulette', 'ルーレット'],
  ['gifts', 'ギフト増減'],
  ['comment', 'コメント'],
  ['helper', 'お助け'],
  ['boost', 'ブースト'],
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
  const [confirmNode, confirm] = useConfirm();

  useEffect(() => {
    // マウント時に必ず最新を取り直す — 設定画面での変更後でも古い draft を種にしない。
    // 失敗すると draft が null のまま「読み込み中…」で固着するため、必ず知らせる。
    void rpc('cfg.get', undefined)
      .then((s) => {
        setSettings(s);
        setDraft(s.challenge);
      })
      .catch((e: Error) => toast({ level: 'error', msgJa: `設定の読み込みに失敗しました: ${e.message}` }));
    void rpc('monitor.status', undefined)
      .then((r) => setMonitorOpen(r.open))
      .catch(() => undefined); // onMonitorState 購読で回復する
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
      // wakeTime だけは直前に取り直す — この画面ではなくライブ画面が持つ値なので、
      // 設定画面を開いたまま配信中に起床時刻を入れられると mount 時の draft で潰れる。
      const cur = await rpc('cfg.get', undefined);
      await rpc('cfg.set', { challenge: { ...draft, wakeTime: cur.challenge.wakeTime } });
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

  /**
   * デフォ保存 — 現在の内容を「既定値」として challenge-default.json へ書き出す。
   * 未保存の編集があれば先に通常保存する(画面の内容がそのままデフォになる約束)。
   * 書き出すのは cfg.get で取り直した保存(clamp)後の値 — save() 直後の draft は
   * setDraft の反映前で古いことがある。
   */
  async function saveDefault(): Promise<void> {
    if (!draft) return;
    if (dirty && !(await save())) return;
    setBusy(true);
    try {
      const s = await rpc('cfg.get', undefined);
      const r = await rpc('challengeDefault.save', s.challenge);
      toast({
        level: 'info',
        msgJa: `デフォ保存しました。このファイルを他のPCの同じ場所にコピーすると、そのPCでも既定になります: ${r.path}`,
      });
    } catch (e) {
      toast({ level: 'error', msgJa: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  /**
   * 同梱デフォで更新 — 自分のデフォ保存(config/challenge-default.json)を削除し、
   * アプリ同梱の公開デフォを実効既定へ戻して画面にも反映する。自分のファイルが
   * 常に同梱より優先されるため、公開デフォの新しい内容を受け取る唯一の道。
   * 設定(settings.json)自体は「保存」を押すまで変わらない。
   */
  async function updateFromBundled(): Promise<void> {
    if (!draft) return;
    const ok = await confirm({
      title: '同梱デフォで更新しますか？',
      message:
        'この端末の「デフォ保存」を削除し、アプリ同梱の公開デフォを既定に戻します。画面の内容も同梱デフォに置き換わります。',
      detail: '設定そのものは「保存」を押すまで変わりません。自分のデフォが必要なら、あとでもう一度「デフォ保存」してください。',
      confirmLabel: '更新する',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await rpc('challengeDefault.clear', undefined);
      patch(r.cfg);
      toast({
        level: 'info',
        msgJa: r.removed
          ? 'デフォ保存を削除し、同梱デフォを画面に反映しました。「保存」を押すと確定します。'
          : 'デフォ保存はありませんでした。同梱デフォを画面に反映しました。「保存」を押すと確定します。',
      });
    } catch (e) {
      toast({ level: 'error', msgJa: (e as Error).message });
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
        // マウント完了は待たない — モニターの watermark はマウント時、最初の
        // スナップショットに含まれる test 演出を再生する(freshChallengeEffects の
        // mountPlaysTest)ので、push が先でも捨てられない。以前の固定 1500ms 待ちは
        // ウィンドウ生成が遅い環境で足りず「▶ が無言で消える」原因だった。
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
          onClick={() => rpcFire(monitorOpen ? 'monitor.close' : 'monitor.open', undefined, 'モニターの開閉')}
        >
          {monitorOpen ? 'モニターを閉じる' : 'モニターを開く'}
        </button>
        <button
          className="btn small"
          onClick={() => void saveDefault()}
          disabled={busy}
          title={
            '現在の内容をデフォ(既定値)として challenge-default.json に書き出します。' +
            '「チャレンジ設定をすべて既定に戻す」の戻り先になり、' +
            'このファイルを他のPCのデータフォルダ内 config\\ にコピーすると、そのPCでも同じ内容がデフォになります。'
          }
        >
          デフォ保存
        </button>
        <button
          className="btn small"
          onClick={() => void updateFromBundled()}
          disabled={busy}
          title={
            '自分の「デフォ保存」を削除して、アプリ同梱の公開デフォ(配布物に入っている challenge-default.json)を既定に戻し、' +
            '内容をこの画面に読み込みます。自分のデフォ保存は同梱版より常に優先されるため、' +
            '公開デフォの新しい内容を受け取るにはこの操作が必要です。'
          }
        >
          同梱デフォで更新
        </button>
        <button className="btn primary" onClick={() => void save()} disabled={busy || !dirty}>
          {dirty ? '保存' : '保存済み'}
        </button>
      </div>
      {confirmNode}

      <label className="row" style={{ cursor: 'pointer' }}>
        <input type="checkbox" checked={draft.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
        <span>有効にする(ライブ画面に操作カードが出ます)</span>
      </label>
      <div className="faint" style={{ fontSize: 11, marginLeft: 22, marginBottom: 8 }}>
        「0まで寝ない」型の企画: ボタンで数字が減り、フォロー・いいねで増え(妨害)、ギフトで増減します。指定コメントの妨害は「コメント」タブで設定できます。
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
            {window.matchMedia('(prefers-reduced-motion: reduce)').matches ? (
              <div
                className="row"
                style={{
                  background: 'rgba(255, 180, 0, 0.12)',
                  border: '1px solid rgba(255, 180, 0, 0.4)',
                  borderRadius: 6,
                  padding: '6px 10px',
                  marginBottom: 10,
                  fontSize: 12,
                }}
              >
                ⚠ OS の「アニメーション効果(視覚効果を減らす)」が有効のため、着弾・ルーレット・
                カットインなどの動きのある演出はモニターに表示されません。Windows 設定 →
                アクセシビリティ → 視覚効果 で「アニメーション効果」をオンにすると表示されます。
              </div>
            ) : null}
            <MiniFxSection cfg={draft} onPatch={patch} onTest={onTest} testBusy={testBusy} />
            <GiftClipsSection cfg={draft} onPatch={patch} onTest={onTest} testBusy={testBusy} />
            <GiftFullCutSection cfg={draft} onPatch={patch} onTest={onTest} testBusy={testBusy} />
            <StockCutinSection cfg={draft} onPatch={patch} onTest={onTest} testBusy={testBusy} />
            <GiftBandFxSection cfg={draft} onPatch={patch} onTest={onTest} testBusy={testBusy} />
            <GiftRepeatFxSection cfg={draft} onPatch={patch} onTest={onTest} testBusy={testBusy} />
          </>
        ) : null}
        {tab === 'roulette' ? <RouletteSection cfg={draft} onPatch={patch} onTest={onTest} testBusy={testBusy} /> : null}
        {tab === 'gifts' ? <GiftRulesSection cfg={draft} onPatch={patch} /> : null}
        {tab === 'comment' ? (
          <CommentRulesSection cfg={draft} onPatch={patch} onTest={onTest} testBusy={testBusy} />
        ) : null}
        {tab === 'helper' ? (
          <HelperSection cfg={draft} onPatch={patch} onTest={onTest} testBusy={testBusy} />
        ) : null}
        {tab === 'boost' ? (
          <BoostSection cfg={draft} onPatch={patch} onTest={onTest} testBusy={testBusy} />
        ) : null}
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
      <label className="row" style={{ marginTop: 8, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={cfg.wakeEnabled}
          onChange={(e) => onPatch({ wakeEnabled: e.target.checked })}
        />
        <span>「何時起き」をモニターの左下に出す</span>
      </label>
      <div className="faint" style={{ fontSize: 11, marginLeft: 22 }}>
        起きた時刻はライブ画面の操作カード(開始ボタンの横)で設定します。企画の途中でも変えられます。表示は「起床
        5:30 / 18時間42分」。
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
                  <span style={{ flex: '0 0 240px', minWidth: 0, fontSize: 11 }}>
                    <span style={{ display: 'block' }}>{SE_SLOT_LABELS[slot]}</span>
                    <span
                      className="faint"
                      style={{ display: 'block', fontSize: 10, lineHeight: 1.25 }}
                    >
                      {SE_SLOT_HINTS[slot]}
                    </span>
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
        音はモニターを開いているときはモニター側で、閉じているときはライブ画面側で鳴ります。
        ただし各行に「モニター表示中のみ」と書いてある音だけは、着弾やリール停止の瞬間に
        合わせてモニターが直接鳴らすため、モニターを閉じていると鳴りません。
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
            {CHALLENGE_SE_SLOTS.map((slot) => {
              const off = cfg.miniFx[slot] === 'off';
              return (
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
                  <MonitorTestBtn
                    spec={specForSlot(slot)}
                    onTest={onTest}
                    busy={testBusy}
                    disabled={off}
                    title={
                      off
                        ? 'このスロットは「出さない」です。簡易演出を選ぶと実演できます'
                        : undefined
                    }
                  />
                </div>
              );
            })}
          </div>
          <div className="row" style={{ marginTop: 8, marginLeft: 22 }}>
            <button className="btn small" onClick={() => onPatch({ miniFx: { ...DEFAULT_MINI_FX } })}>
              簡易演出を既定に戻す
            </button>
          </div>
          <div className="faint" style={{ fontSize: 11, marginLeft: 22, marginTop: 4 }}>
            ギフトは下の「ギフトごとの演出クリップ」で個別に上書きできます(ハートミーは既定でハンマー)。
            ここのギフト(小)〜(特大)は、個別指定の無いギフトに効きます。お助け(ファンスタンプ)は
            専用スロットなので、ギフト(小)を変えても影響しません(「お助け」タブでも同じ設定を変えられます)。
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
                    <FxClipOptions />
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
/**
 * 連打ギフト(コンボ)の演出反復。TikTok は同じギフトの連打を1メッセージに畳んで
 * 送るため、素だと「10連打でも演出1回」になる。ここはその回数ぶん演出を撃ち直す設定。
 * 値・統計・履歴は動かさない。
 *
 * **ルーレットだけは別枠**: 抽選回数と増減は常に個数ぶん(ここの max では削らない)。
 * rouletteEnabled が決めるのは「リールを何本見せるか」だけ。演出用の上限で値まで
 * 削っていたのが v0.5.4 の不具合だったので、ここは分けたまま保つこと。
 */
function GiftRepeatFxSection({ cfg, onPatch, onTest, testBusy }: SectionProps): React.JSX.Element {
  const rf = cfg.giftRepeatFx;
  const patchRf = (p: Partial<GiftRepeatFxConfig>): void => {
    onPatch({ giftRepeatFx: { ...rf, ...p } });
  };
  // カットイン反復の最悪ケースを実数値で見せる — 「何秒カウントが止まるか」は
  // 設定次第で大きく変わるので、文章ではなく計算結果を出す。
  const longestBandSec = cfg.giftBandFx.enabled
    ? Math.max(0, ...cfg.giftBandFx.bands.filter((b) => b.enabled && b.clip !== 'off').map((b) => b.durationSec))
    : 0;
  const worstFreezeSec = Math.min(longestBandSec * rf.max, GIFT_FX_FREEZE_MAX_TOTAL_MS / 1000);

  return (
    <>
      <h3 style={{ marginTop: 14 }}>連打ギフトの演出(同じギフトを連続で出す)</h3>
      <label className="row" style={{ cursor: 'pointer' }}>
        <input type="checkbox" checked={rf.enabled} onChange={(e) => patchRf({ enabled: e.target.checked })} />
        <span>同じ人が同じギフトを連打したら、まとめて1回ではなく回数ぶん演出する</span>
      </label>
      <div className="faint" style={{ fontSize: 11, marginLeft: 22, marginBottom: 8 }}>
        TikTok は連打(バラ・指ハート等)を<b>1メッセージにまとめて</b>送るため、既定では
        「10連打でも演出1回」になります。ここを有効にすると回数ぶん撃ち直します。
        <b>ダイヤ合計・統計・履歴ログは変わりません</b>(演出だけを繰り返します)。
      </div>
      <div className="row">
        <label className="field">
          最大の繰り返し回数
          <input
            type="number"
            min="1"
            max={GIFT_FX_REPEAT_MAX}
            value={rf.max}
            onChange={(e) => patchRf({ max: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          間隔(ミリ秒)
          <input
            type="number"
            min={GIFT_FX_REPEAT_MIN_MS}
            max={GIFT_FX_REPEAT_MAX_MS}
            step="100"
            value={rf.intervalMs}
            onChange={(e) => patchRf({ intervalMs: Number(e.target.value) })}
          />
        </label>
        <MonitorTestBtn
          spec={{ kind: 'gift', diamonds: 10, repeat: rf.max }}
          onTest={onTest}
          busy={testBusy}
          label="▶ モニターで連打を実演"
          title="モニターウィンドウで反復演出を再生します(値は動きません)"
          style={{ alignSelf: 'flex-end' }}
        />
      </div>
      <label className="row" style={{ cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={rf.bandEnabled}
          disabled={!rf.enabled}
          onChange={(e) => patchRf({ bandEnabled: e.target.checked })}
        />
        <span>ダイヤ帯域カットインも繰り返す</span>
      </label>
      <div className="faint" style={{ fontSize: 11, marginLeft: 22, marginBottom: 8 }}>
        カットインは全画面なので間隔ではなく<b>尺ぶん続けて</b>再生し、その間ずっとカウントが
        止まります。
        {longestBandSec > 0 ? (
          <>
            {' '}
            いまの設定だと最長 <b>約{worstFreezeSec}秒</b>(
            {longestBandSec}秒 × {rf.max}回)止まります。
          </>
        ) : null}{' '}
        長すぎるときは回数を下げるか、このチェックを外してください。
        <b>既定のバンドは1💎から全ギフトに当たる</b>ので、軽いクリップ演出で繰り返したい場合は
        上の「ダイヤ数のカットイン演出」で対象ギフトを除外するか、その帯域のクリップを
        「出さない」にしてください。
      </div>
      <label className="row" style={{ cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={rf.rouletteEnabled}
          disabled={!rf.enabled}
          onChange={(e) => patchRf({ rouletteEnabled: e.target.checked })}
        />
        <span>ギフトルーレットのリールも回数ぶん回す</span>
      </label>
      <div className="faint" style={{ fontSize: 11, marginLeft: 22, marginBottom: 8 }}>
        ルーレットは抽選なので、<b>抽選回数とカウントの増減は常に贈られた個数ぶん</b>です
        (17連打なら17回転ぶん)。上の「最大の繰り返し回数」でも減りません — 減らすと
        視聴者が贈ったギフトぶんがカウントに反映されなくなるためです。
        <br />
        このチェックが変えるのは<b>リールを何本見せるか</b>だけ。外すとリールは1本になり、
        残りは「残り◯回ぶん」の合算バナーでまとめて出ます(カウントの動きは同じ)。
        リールは最大 {ROULETTE_REELS_MAX} 本まで(それ以上は同じく合算バナー)。
      </div>
      <div className="row">
        <button className="btn small" onClick={() => patchRf({ ...DEFAULT_GIFT_REPEAT_FX })}>
          既定に戻す
        </button>
      </div>
    </>
  );
}

/**
 * ダイヤの全面カットの設定セクション。**ダイヤ数帯(GiftBandFxSection)より優先**
 * されるので、画面上でも帯域より上に置いて評価順と並び順を一致させている。
 *
 * 帯域との違いは2点だけ: (1) ダイヤ数ではなくギフト(名前/ID/canonical)で一致させる、
 * (2) BGM 選択を持たない — 素材(assets/fx/cut/*.mp4)に音声が焼き込んであるので
 * 音量スライダーだけを持つ。
 */
function GiftFullCutSection({ cfg, onPatch, onTest, testBusy }: SectionProps): React.JSX.Element {
  const fc = cfg.giftFullCut;
  // 試写。全面カットは音声入りなので muted を外す(帯域の試写は無音のまま)。
  const [preview, setPreview] = useState<{ key: number; url: string; sound: boolean } | null>(null);

  const patchFc = (p: Partial<GiftFullCutConfig>): void => {
    onPatch({ giftFullCut: { ...fc, ...p } });
  };
  const patchRule = (i: number, p: Partial<GiftFullCutRule>): void => {
    patchFc({ rules: fc.rules.map((r, j) => (j === i ? { ...r, ...p } : r)) });
  };

  return (
    <>
      <h3 style={{ marginTop: 14 }}>ダイヤの全面カット(最優先・カウント一時停止)</h3>
      <label className="row" style={{ cursor: 'pointer' }}>
        <input type="checkbox" checked={fc.enabled} onChange={(e) => patchFc({ enabled: e.target.checked })} />
        <span>指定したギフトで全面カットを再生する</span>
      </label>
      <div className="faint" style={{ fontSize: 11, marginLeft: 22, marginBottom: 8 }}>
        指定したギフトが届いたら画面全体にカットイン動画を再生し、<b>再生中はカウントを一時停止</b>します
        (その間のギフト・いいね・フォローは捨てられず、演出後に順番に反映されます)。
        <b>下の「ダイヤ数のカットイン演出」より優先</b>され、ここで一致したギフトは帯域のカットインを再生しません。
        BGM は動画に入っているので選択欄はありません(音量だけ下で調整)。
      </div>

      {fc.enabled ? (
        <>
          {fc.rules.map((r, i) => (
            <div className="challenge-rule" key={r.id}>
              <label className="field" style={{ width: 110 }}>
                表示名
                <input
                  type="text"
                  value={r.label}
                  placeholder="バラ"
                  onChange={(e) => patchRule(i, { label: e.target.value })}
                />
              </label>
              <div style={{ width: 150 }}>
                <label className="field">
                  ギフト名
                  <input
                    type="text"
                    value={r.giftName}
                    placeholder="バラ"
                    onChange={(e) => patchRule(i, { giftName: e.target.value.toLowerCase() })}
                  />
                </label>
                <label
                  className="row"
                  style={{ cursor: 'pointer', marginTop: 2 }}
                  title="オンにするとギフト名が完全に一致したときだけ再生します。オフ(既定)は部分一致で、たとえば「tiktok」は「TikTok Universe」にも当たります。"
                >
                  <input
                    type="checkbox"
                    checked={r.exactName}
                    onChange={(e) => patchRule(i, { exactName: e.target.checked })}
                  />
                  <span className="faint" style={{ fontSize: 11 }}>
                    完全一致
                  </span>
                </label>
              </div>
              <label className="field" style={{ width: 100 }}>
                giftId(任意)
                <input
                  type="text"
                  value={r.giftId}
                  placeholder="5655"
                  onChange={(e) => patchRule(i, { giftId: e.target.value.trim() })}
                />
              </label>
              <div className="row" style={{ gap: 6, flex: 1 }}>
                <label className="field" style={{ flex: 1 }}>
                  カットイン動画
                  <select value={r.clip} onChange={(e) => patchRule(i, { clip: e.target.value })}>
                    <option value="off">出さない</option>
                    <FxClipOptions />
                  </select>
                </label>
                <button
                  className="btn small"
                  disabled={r.clip === 'off'}
                  title="このクリップを試写(音あり)"
                  style={{ alignSelf: 'flex-end' }}
                  onClick={() => {
                    const url = FX_CLIPS.find((f) => f.id === r.clip)?.url;
                    if (url) setPreview({ key: clipSeq++, url, sound: isFullCutClip(r.clip) });
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
                    value={r.durationSec}
                    onChange={(e) => patchRule(i, { durationSec: Number(e.target.value) })}
                  />
                </label>
                <MonitorTestBtn
                  spec={r.clip !== 'off' ? { kind: 'gift', fullCutId: r.id, diamonds: 1 } : null}
                  onTest={onTest}
                  busy={testBusy}
                  label="▶ モニター"
                  title={
                    r.clip !== 'off'
                      ? 'この行の全面カット(動画+音声)をモニターで実演再生。テスト中はカウントを止めません。'
                      : 'カットイン動画を選ぶと実演再生できます'
                  }
                  style={{ alignSelf: 'flex-end' }}
                />
                <label className="row" style={{ cursor: 'pointer', alignSelf: 'flex-end', paddingBottom: 6 }}>
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    onChange={(e) => patchRule(i, { enabled: e.target.checked })}
                  />
                  <span className="faint" style={{ fontSize: 11 }}>
                    有効
                  </span>
                </label>
                <button
                  className="btn small danger"
                  style={{ alignSelf: 'flex-end' }}
                  onClick={() => patchFc({ rules: fc.rules.filter((_, j) => j !== i) })}
                >
                  削除
                </button>
              </div>
            </div>
          ))}
          <div className="row" style={{ gap: 10, marginTop: 8, alignItems: 'center' }}>
            <button
              className="btn small"
              onClick={() =>
                patchFc({
                  rules: [
                    ...fc.rules,
                    {
                      id: `fullcut-${Date.now().toString(36)}-${clipSeq++}`,
                      label: '',
                      giftId: '',
                      giftName: '',
                      canonical: '',
                      // 手で足した行は従来どおり部分一致から始める。
                      exactName: false,
                      clip: 'off',
                      durationSec: 5,
                      enabled: true,
                    },
                  ],
                })
              }
            >
              行を追加
            </button>
            <label className="field" style={{ width: 220 }}>
              音量 {fc.volume}
              <input
                type="range"
                min="0"
                max="100"
                value={fc.volume}
                onChange={(e) => patchFc({ volume: Number(e.target.value) })}
              />
            </label>
            <button
              className="btn small"
              onClick={() => onPatch({ giftFullCut: structuredClone(DEFAULT_GIFT_FULL_CUT) })}
            >
              全面カット設定を既定に戻す
            </button>
          </div>
          <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>
            ギフト名は既定で<b>部分一致</b>・大文字小文字は無視します(「バラ」は「バラ」を含むギフト名すべてに一致)。
            短い名前は他のギフトを巻き込みます — たとえば「tiktok」は<b>「TikTok Universe」(44,999💎)にも一致</b>してしまうので、
            そういう行は<b>完全一致</b>にチェックを入れてください(既定では TikTok と GG の2行だけ入っています)。
            giftId を入れるとそちらが優先され、確実に1つのギフトだけに絞れます(ライブのギフト履歴で確認できます)。
            ギフト名・giftId がどちらも空の行はどのギフトにも一致しません。音量は<b>効果音がオフのときは無音</b>になります。
          </div>

          {preview ? (
            <div className={`fx-preview${preview.sound ? ' opaque' : ''}`}>
              <video
                key={preview.key}
                src={preview.url}
                autoPlay
                muted={!preview.sound}
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
 * いいねストック満杯の全面カットの音量。**ダイヤの全面カットの隣**に置いてある —
 * どちらも「音声焼き込みの動画をそのまま鳴らす」同じ仕組みで、スライダーの目盛りも
 * 同じ絶対値(0-100・全体音量は掛からない)。
 *
 * 「効果音」タブに置かないのは目盛りの意味が食い違うため — あちらのスライダーは
 * 全部「全体音量に対する%」で、絶対値を1本だけ混ぜると読めなくなる。代わりに
 * SE_SLOT_HINTS['stock-full'] からこのタブへ案内している。
 *
 * 行の有効/無効やクリップ選択は持たない(素材は stock-cutin.mp4 の1本きりで、
 * 出す/出さないは「演出クリップを出す」= fxClipsEnabled が握っている)。
 */
function StockCutinSection({ cfg, onPatch, onTest, testBusy }: SectionProps): React.JSX.Element {
  return (
    <>
      <h3 style={{ marginTop: 14 }}>いいねストック満杯の全面カット(カウント一時停止)</h3>
      <div className="faint" style={{ fontSize: 11, marginBottom: 8 }}>
        ストックのドットが全部埋まると、着弾の瞬間から約5秒の全面カット動画を再生し、
        <b>再生中はカウントを一時停止</b>します(その間のギフト・いいね・フォローは捨てられず、演出後に反映されます)。
        BGM は動画に入っているので選択欄はありません(音量だけ下で調整)。
      </div>
      <div className="row" style={{ gap: 10, alignItems: 'center' }}>
        <label className="field" style={{ width: 220 }}>
          音量 {cfg.stockCutinVolume}
          <input
            type="range"
            min="0"
            max="100"
            value={cfg.stockCutinVolume}
            onChange={(e) => onPatch({ stockCutinVolume: Number(e.target.value) })}
          />
        </label>
        <MonitorTestBtn
          spec={{ kind: 'stock-full' }}
          onTest={onTest}
          busy={testBusy}
          title="ストック満杯の演出をモニターで実演再生(カットイン動画の音もこの音量で鳴ります)。テスト中はカウントを止めません。"
        />
      </div>
      <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>
        これは<b>動画に焼き込まれた音</b>の音量です。同じ瞬間に鳴る効果音
        「いいねストック満杯(着弾)」は<b>別枠</b>で、あちらは「効果音」タブで調整します
        (以前は両方が同じスライダーに連動していて、効果音側を絞ると動画の音まで小さくなっていました)。
        音量は<b>効果音がオフのときは無音</b>になります。
      </div>
    </>
  );
}

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
                    <FxClipOptions />
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
                // key で外部からの変更(「既定に戻す」・保存後の setDraft)に追従させる。
                // 素の defaultValue だけだと表示が古いまま draft と乖離する。
                key={bf.excludeGiftIds.join(',')}
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
 *
 * ルーレットは複数登録できる。**上から順に評価し、最初に一致した1件だけ**が回る
 * (worker/challenge.ts の matchRoulette と同じ規約)。トリガーに一致したギフトは
 * 「ギフト増減」規則を通らない — ルーレットが増減を置き換える。
 */
function RouletteSection({ cfg, onPatch, onTest, testBusy }: SectionProps): React.JSX.Element {
  const list = cfg.roulettes;
  const snd = cfg.rouletteSound;
  const patchAt = (i: number, p: Partial<ChallengeRouletteConfig>): void =>
    onPatch({ roulettes: list.map((r, j) => (j === i ? { ...r, ...p } : r)) });
  const patchSnd = (p: Partial<RouletteSoundConfig>): void =>
    onPatch({ rouletteSound: { ...snd, ...p } });

  // 回転サウンドの試聴(GiftBandFxSection の auditionRef と同じ持ち方)。
  // key は 'bgm:'/'spin:' の接頭辞付き — 同じ id が両スロットに現れることは
  // 無いが、■/♪ 表示の判定を単純に保つため。
  const auditionRef = useRef<BgmHandle | null>(null);
  const [auditionKey, setAuditionKey] = useState<string | null>(null);
  useEffect(
    () => () => {
      auditionRef.current?.stop(0);
    },
    []
  );
  const toggleAudition = (key: string, id: string, volume: number): void => {
    const playing = auditionKey;
    auditionRef.current?.stop(0);
    auditionRef.current = null;
    setAuditionKey(null);
    if (playing === key) return;
    auditionRef.current = playBandBgm(id, volume);
    if (auditionRef.current) setAuditionKey(key);
  };

  return (
    <>
      <div className="row">
        <h3 style={{ margin: 0 }}>ギフトルーレット</h3>
      </div>
      <div className="faint" style={{ fontSize: 11, marginTop: 6, marginBottom: 10 }}>
        指定したギフトが届くとモニターでルーレットが回り、出目が数字に加算(または減算)されます。
        複数登録できますが、<b>上から順に評価し、最初に一致した1件だけ</b>が回ります。
        トリガーに一致したギフトは「ギフト増減」規則を通りません。
      </div>
      <label className="row" style={{ marginTop: 8, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={cfg.hideRouletteResultInLog}
          onChange={(e) => onPatch({ hideRouletteResultInLog: e.target.checked })}
        />
        <span>ライブ画面のログでルーレットの結果を伏せる(ネタバレ防止)</span>
      </label>
      <div className="faint" style={{ fontSize: 11, marginLeft: 22, marginBottom: 10 }}>
        モニターのリールは確定した出目を遅れて再生しているだけなので、伏せないとリールが止まる前に
        ログで結果が読めてしまいます。伏せた行は「+?」「→ ?????」になります。切ると過去の行も数字が戻ります。
        ただしカード上部の大きな残数はギフト到着と同時に動くので、完全には隠せません。
      </div>
      <div
        style={{
          border: '1px solid rgba(255,255,255,.12)',
          borderRadius: 8,
          padding: '10px 12px',
          marginBottom: 10,
        }}
      >
        <h4 style={{ margin: '0 0 8px' }}>回転中のサウンド(全ルーレット共通)</h4>
        <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
          <label className="field" style={{ width: 230 }}>
            BGM
            <select value={snd.bgm} onChange={(e) => patchSnd({ bgm: e.target.value })}>
              <option value="off">鳴らさない(既定)</option>
              {[...ROULETTE_BGM, ...BAND_BGM].map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <button
            className="btn small"
            disabled={snd.bgm === 'off'}
            title={auditionKey === `bgm:${snd.bgm}` ? '試聴を停止' : 'このBGMを試聴'}
            onClick={() => toggleAudition(`bgm:${snd.bgm}`, snd.bgm, snd.bgmVolume)}
          >
            {auditionKey === `bgm:${snd.bgm}` ? '■' : '♪'}
          </button>
          <input
            type="range"
            min="0"
            max="100"
            value={snd.bgmVolume}
            disabled={snd.bgm === 'off'}
            onChange={(e) => patchSnd({ bgmVolume: Number(e.target.value) })}
          />
          <span className="faint" style={{ fontSize: 11, minWidth: 56 }}>音量 {snd.bgmVolume}</span>
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'flex-end', marginTop: 6 }}>
          <label className="field" style={{ width: 230 }}>
            リール回転音(ループ)
            <select value={snd.spinSe} onChange={(e) => patchSnd({ spinSe: e.target.value })}>
              <option value="off">鳴らさない</option>
              {ROULETTE_SPIN_SE.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <button
            className="btn small"
            disabled={snd.spinSe === 'off'}
            title={auditionKey === `spin:${snd.spinSe}` ? '試聴を停止' : 'この回転音を試聴'}
            onClick={() => toggleAudition(`spin:${snd.spinSe}`, snd.spinSe, snd.spinSeVolume)}
          >
            {auditionKey === `spin:${snd.spinSe}` ? '■' : '♪'}
          </button>
          <input
            type="range"
            min="0"
            max="100"
            value={snd.spinSeVolume}
            disabled={snd.spinSe === 'off'}
            onChange={(e) => patchSnd({ spinSeVolume: Number(e.target.value) })}
          />
          <span className="faint" style={{ fontSize: 11, minWidth: 56 }}>音量 {snd.spinSeVolume}</span>
        </div>
        <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>
          リールが回っている間だけ鳴ります。連続スピン中はBGMを止めません。回転音は終盤の
          「止まりそう」の間で自動的に静かになります。音量は効果音の設定とは独立です。
          各行の「▶ モニターで回す」でも鳴ります。既定はBGM無し・回転音のジングルのみ —
          停止まわりの3音(回転 / 止まりそう / 確定)は「効果音」のセクションで差し替えます。
        </div>
      </div>
      {list.length === 0 ? (
        <div className="faint" style={{ fontSize: 12, marginBottom: 8 }}>
          登録されたルーレットはありません(どのギフトでもルーレットは回りません)。
        </div>
      ) : null}
      {list.map((rl, i) => (
        <RouletteRow
          key={rl.id}
          rl={rl}
          onPatch={(p) => patchAt(i, p)}
          onRemove={() => onPatch({ roulettes: list.filter((_, j) => j !== i) })}
          onTest={onTest}
          testBusy={testBusy}
        />
      ))}
      <div className="row" style={{ marginTop: 10 }}>
        <button
          className="btn small"
          disabled={list.length >= ROULETTES_MAX}
          onClick={() =>
            onPatch({
              roulettes: [
                ...list,
                {
                  id: `rl-${Date.now().toString(36)}-${rlSeq++}`,
                  label: '',
                  enabled: true,
                  // トリガーは空で出して設定を促す。出目だけ既定を配る。
                  giftId: '',
                  giftName: '',
                  canonical: '',
                  segments: structuredClone(DEFAULT_ROULETTE.segments),
                  direction: 'add',
                  patterns: [...ROULETTE_PATTERNS],
                },
              ],
            })
          }
        >
          ルーレットを追加
        </button>
        <button
          className="btn small"
          onClick={() => onPatch({ roulettes: [structuredClone(DEFAULT_ROULETTE)] })}
        >
          既定(ハートミー1件)に戻す
        </button>
      </div>
      <JoinRouletteSection cfg={cfg} onPatch={onPatch} onTest={onTest} testBusy={testBusy} />
    </>
  );
}

/**
 * 入室ルーレットの設定。ギフトルーレットと違い**単一設定でトリガーギフトを
 * 持たない** — 視聴者の入室(初見さんのみ / すべて)で自動的に1スピン回る。
 * 回転中のサウンドは上の「全ルーレット共通」をそのまま使う。
 */
function JoinRouletteSection({ cfg, onPatch, onTest, testBusy }: SectionProps): React.JSX.Element {
  const jr = cfg.joinRoulette;
  const patch = (p: Partial<JoinRouletteConfig>): void => onPatch({ joinRoulette: { ...jr, ...p } });

  return (
    <>
      <div className="row" style={{ marginTop: 18 }}>
        <h3 style={{ margin: 0 }}>入室ルーレット</h3>
      </div>
      <div className="faint" style={{ fontSize: 11, marginTop: 6, marginBottom: 10 }}>
        視聴者が入室するとモニターでルーレットが回り、出目が数字に加算(または減算)されます。
        対象「初見さんのみ」は、このツールで初めて記録された視聴者だけに回ります。
        同じ人はチャレンジ1回につき1度だけ。直前の発火から10秒以内の入室は間引かれます
        (レイド対策)。ライブ画面のボタンからもオン/オフできます。
      </div>
      <div
        style={{
          border: '1px solid rgba(255,255,255,.12)',
          borderRadius: 8,
          padding: '10px 12px',
          marginBottom: 10,
        }}
      >
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <label className="row" style={{ cursor: 'pointer', gap: 4 }}>
            <input
              type="checkbox"
              checked={jr.enabled}
              onChange={(e) => patch({ enabled: e.target.checked })}
            />
            <span>有効</span>
          </label>
          <div className="spacer" />
          <MonitorTestBtn
            spec={{ kind: 'roulette', join: true }}
            onTest={onTest}
            busy={testBusy}
            label="▶ モニターで回す"
            title="この盤面で抽選してモニターのルーレットを実演再生します(カウントは変わりません)"
          />
        </div>
        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          <label className="field" style={{ width: 170 }}>
            対象
            <select
              value={jr.target}
              onChange={(e) => patch({ target: e.target.value as 'first' | 'all' })}
            >
              <option value="first">初見さんのみ</option>
              <option value="all">すべての入室</option>
            </select>
          </label>
          <label className="field" style={{ width: 170 }}>
            表示名(モニター)
            <input
              type="text"
              placeholder={`例: ${DEFAULT_JOIN_ROULETTE.label}`}
              maxLength={ROULETTE_LABEL_MAX}
              value={jr.label}
              onChange={(e) => patch({ label: e.target.value })}
            />
          </label>
          <label className="field" style={{ width: 150 }}>
            出目の方向
            <select
              value={jr.direction}
              onChange={(e) => patch({ direction: e.target.value as 'add' | 'sub' })}
            >
              <option value="add">増やす(妨害)</option>
              <option value="sub">減らす(応援)</option>
            </select>
          </label>
        </div>
        <div className="faint" style={{ fontSize: 11, marginTop: 4, marginBottom: 6 }}>
          モニターには「{jr.label.trim() !== '' ? jr.label.trim() : DEFAULT_JOIN_ROULETTE.label}{' '}
          ○○がルーレット」と出ます(○○ = 入室した人の名前)。空で保存すると「
          {DEFAULT_JOIN_ROULETTE.label}」に戻ります。
          {jr.target === 'all'
            ? ' 対象が「すべての入室」のときは表示名の変更をおすすめします(例: ようこそ)。'
            : ''}
        </div>
        <RoulettePatternPicker
          patterns={jr.patterns}
          onChange={(patterns) => patch({ patterns })}
          makeSpec={(p) => ({ kind: 'roulette', join: true, pattern: p })}
          onTest={onTest}
          testBusy={testBusy}
        />
        <RouletteSegmentsEditor segments={jr.segments} onChange={(segments) => patch({ segments })} />
      </div>
    </>
  );
}

/**
 * 焦らしパターンの表示名と説明(チェックボックスのラベルと title)。
 * 一覧と並び順の出所は shared/dto.ts の ROULETTE_PATTERNS。
 */
const ROULETTE_PATTERN_LABELS: Record<RoulettePattern, { label: string; hint: string }> = {
  slow: { label: 'じわじわ減速', hint: '段々遅くなり、あと一歩で粘ってから止まる' },
  pop: { label: 'ポンポン', hint: '4段飛び移り。間が段々長くなる' },
  kick: { label: 'フェイク→キック', hint: '1つ手前で止まったと見せて、キックで1個ずれる' },
  overrun: { label: '行き過ぎ巻き戻し', hint: '当選を通り過ぎて隣に着地→巻き戻して戻ってくる' },
  crawl: { label: '超低速', hint: '最後の3個を這うように進む。微停止3回' },
  doublefake: { label: '二段フェイク', hint: 'フェイク停止2回→キック2発' },
  restart: { label: '失速→再加速', hint: '途中で止まったと見せて、再点火して駆け抜ける' },
  teeter: { label: '境界シーソー', hint: '当選と隣の境界でシーソー→こてんと倒れる' },
  stairs: { label: '階段落ち', hint: '5段の階段。段の間が 180ms→510ms と伸びる' },
  blackout: { label: '暗転', hint: '終盤に真っ暗→明けたらもう止まっている' },
  jackstop: { label: '大当たり寸止め', hint: '一番下の出目が完全に入って止まる→蹴り出される' },
  jackslip: { label: '大当たりすり抜け', hint: '一番下の出目が寸前で震えて、スローですり抜ける' },
  jackback: { label: '大当たり届かず', hint: '一番下の出目が届かず、後ろへ転がり戻る' },
};

/**
 * 焦らしパターンのチェックリスト。ギフトルーレット(RouletteRow)と入室ルーレット
 * (JoinRouletteSection)で共用する — 正順への正規化・「最後の1つは外せない」
 * ガード・パターン別 ▶ の試写を1実装に保つため。
 */
function RoulettePatternPicker({
  patterns,
  onChange,
  makeSpec,
  onTest,
  testBusy,
}: {
  patterns: RoulettePattern[];
  onChange: (patterns: RoulettePattern[]) => void;
  /** パターン別 ▶ の試写 spec。行の rouletteId / 入室の join は呼び元が焼き込む。 */
  makeSpec: (p: RoulettePattern) => ChallengeTestEffectSpec;
  onTest: OnTest;
  testBusy: boolean;
}): React.JSX.Element {
  return (
    <div
      style={{
        border: '1px solid rgba(255,255,255,.12)',
        borderRadius: 8,
        padding: '8px 10px',
        marginBottom: 8,
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
        焦らしパターン
        <span className="faint" style={{ fontWeight: 400, marginLeft: 8, fontSize: 11 }}>
          回るたびにチェックした中から均等に抽選。▶ でそのパターンを狙って試し回し。
        </span>
      </div>
      <div className="row" style={{ flexWrap: 'wrap', gap: '6px 14px', alignItems: 'center' }}>
        {ROULETTE_PATTERNS.map((p) => {
          const checked = patterns.includes(p);
          // 全部外すと回れない(保存側は sanitizeRoulettePatterns が全許可へ倒すが、
          // UI では最後の1つを外せなくして「なぜか全部戻った」の混乱を防ぐ)。
          const last = checked && patterns.length <= 1;
          const info = ROULETTE_PATTERN_LABELS[p];
          return (
            <span key={p} className="row" style={{ gap: 3, alignItems: 'center', whiteSpace: 'nowrap' }}>
              <label
                className="row faint"
                style={{ fontSize: 11, cursor: last ? 'not-allowed' : 'pointer', gap: 3, whiteSpace: 'nowrap' }}
                title={last ? '最低1つは必要です' : info.hint}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={last}
                  onChange={(e) =>
                    onChange(
                      // ROULETTE_PATTERNS の正順へ正規化して持つ — 保存側の正規化と
                      // 揃え、保存後に draft と差分が出る「保存したのに未保存
                      // マーク」を防ぐ。
                      e.target.checked
                        ? ROULETTE_PATTERNS.filter((q) => q === p || patterns.includes(q))
                        : patterns.filter((q) => q !== p)
                    )
                  }
                />
                {info.label}
              </label>
              <MonitorTestBtn
                spec={makeSpec(p)}
                onTest={onTest}
                busy={testBusy}
                label="▶"
                title={`「${info.label}」を狙ってモニターで試し回しします(チェックの有無に関係なく再生できます)`}
              />
            </span>
          );
        })}
      </div>
      <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>
        「大当たり〜」の3つは、盤面の<b>一番下の出目</b>が入りそうになる超焦らし演出です
        (どれが当たるかは変わりません)。連打のキュー消化中の短縮スピンには焦らしは入りません。
      </div>
    </div>
  );
}

/** 出目テーブル(出目・重み・確率%)。ギフト・入室ルーレットで共用する。 */
function RouletteSegmentsEditor({
  segments,
  onChange,
}: {
  segments: ChallengeRouletteSegment[];
  onChange: (segments: ChallengeRouletteSegment[]) => void;
}): React.JSX.Element {
  const patchSeg = (i: number, p: Partial<ChallengeRouletteSegment>): void =>
    onChange(segments.map((s, j) => (j === i ? { ...s, ...p } : s)));
  const totalWeight = segments.reduce((s, x) => s + Math.max(0, x.weight), 0);

  return (
    <>
      {segments.map((s, i) => (
        <div className="row" key={i} style={{ gap: 8, alignItems: 'center' }}>
          <label className="field" style={{ width: 110 }}>
            {i === 0 ? '出目' : ''}
            <input type="number" min="1" value={s.amount} onChange={(e) => patchSeg(i, { amount: Number(e.target.value) })} />
          </label>
          <label className="field" style={{ width: 110 }}>
            {i === 0 ? '重み' : ''}
            <input type="number" min="0" value={s.weight} onChange={(e) => patchSeg(i, { weight: Number(e.target.value) })} />
          </label>
          <span className="faint" style={{ fontSize: 11, minWidth: 54, textAlign: 'right' }}>
            {totalWeight > 0 ? `${((Math.max(0, s.weight) / totalWeight) * 100).toFixed(1)}%` : '—'}
          </span>
          <button
            className="btn small danger"
            disabled={segments.length <= 1}
            onClick={() => onChange(segments.filter((_, j) => j !== i))}
          >
            削除
          </button>
        </div>
      ))}
      <div className="row" style={{ marginTop: 8 }}>
        <button
          className="btn small"
          disabled={segments.length >= ROULETTE_SEGMENTS_MAX}
          onClick={() => onChange([...segments, { amount: 5, weight: 10 }])}
        >
          出目を追加
        </button>
        <button className="btn small" onClick={() => onChange(structuredClone(DEFAULT_ROULETTE.segments))}>
          出目を既定に戻す
        </button>
      </div>
      <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
        確率 = 重み ÷ 重みの合計。既定は +5(30%) +10(25%) +20(20%) +30(15%) +100(9%) +1000(1%)。
        重み 0 の出目は出ません。
      </div>
    </>
  );
}

/** ルーレット1件ぶんの設定行。トリガー・出目・確率をここで完結させる。 */
function RouletteRow({
  rl,
  onPatch,
  onRemove,
  onTest,
  testBusy,
}: {
  rl: ChallengeRouletteConfig;
  onPatch: (p: Partial<ChallengeRouletteConfig>) => void;
  onRemove: () => void;
  onTest: OnTest;
  testBusy: boolean;
}): React.JSX.Element {
  return (
    <div
      style={{
        border: '1px solid rgba(255,255,255,.12)',
        borderRadius: 8,
        padding: '10px 12px',
        marginBottom: 10,
      }}
    >
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <label className="row" style={{ cursor: 'pointer', gap: 4 }}>
          <input type="checkbox" checked={rl.enabled} onChange={(e) => onPatch({ enabled: e.target.checked })} />
          <span>有効</span>
        </label>
        <div className="spacer" />
        <MonitorTestBtn
          spec={{ kind: 'roulette', rouletteId: rl.id }}
          onTest={onTest}
          busy={testBusy}
          label="▶ モニターで回す"
          title="この盤面で抽選してモニターのルーレットを実演再生します(カウントは変わりません)"
        />
        <button className="btn small danger" onClick={onRemove}>
          この行を削除
        </button>
      </div>
      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <label className="field" style={{ width: 170 }}>
          表示名(モニター)
          <input
            type="text"
            placeholder="例: ハートミー"
            maxLength={ROULETTE_LABEL_MAX}
            value={rl.label}
            onChange={(e) => onPatch({ label: e.target.value })}
          />
        </label>
        <label className="field" style={{ width: 130 }}>
          トリガー giftId
          <input
            type="text"
            placeholder="例: 7934(ハートミー)"
            value={rl.giftId}
            onChange={(e) => onPatch({ giftId: e.target.value.trim() })}
          />
        </label>
        <label className="field" style={{ flex: 1 }}>
          ギフト名(部分一致・IDが変わった時の保険)
          <input
            type="text"
            placeholder="例: heart me"
            value={rl.giftName}
            onChange={(e) => onPatch({ giftName: e.target.value.toLowerCase() })}
          />
        </label>
        <label className="field" style={{ width: 150 }}>
          出目の方向
          <select value={rl.direction} onChange={(e) => onPatch({ direction: e.target.value as 'add' | 'sub' })}>
            <option value="add">増やす(妨害)</option>
            <option value="sub">減らす(応援)</option>
          </select>
        </label>
      </div>
      <div className="faint" style={{ fontSize: 11, marginTop: 4, marginBottom: 6 }}>
        モニターには「{rl.label.trim() !== '' ? rl.label.trim() : 'ギフト名'} ○○がルーレット」と出ます
        (○○ = 送信者の名前)。表示名が空のときは TikTok から届く実際のギフト名を使います。
      </div>
      <RoulettePatternPicker
        patterns={rl.patterns}
        onChange={(patterns) => onPatch({ patterns })}
        makeSpec={(p) => ({ kind: 'roulette', rouletteId: rl.id, pattern: p })}
        onTest={onTest}
        testBusy={testBusy}
      />
      <RouletteSegmentsEditor
        segments={rl.segments}
        onChange={(segments) => onPatch({ segments })}
      />
    </div>
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
        <button
          className="btn small"
          onClick={() =>
            // 「既定」= デフォ保存(challenge-default.json)があればその内容、無ければ同梱既定。
            void rpc('challengeDefault.get', undefined)
              .then((r) => onPatch(r.cfg))
              .catch((e: Error) => toast({ level: 'error', msgJa: e.message }))
          }
        >
          チャレンジ設定をすべて既定に戻す
        </button>
      </div>
    </>
  );
}

/**
 * 指定コメント妨害。キーワードがコメントに含まれたらカウントが増える。
 * 規則は上から先勝ち(giftRules と同じ)。登録なし = 機能オフ。
 */
function CommentRulesSection({ cfg, onPatch, onTest, testBusy }: SectionProps): React.JSX.Element {
  const rules = cfg.commentRules;
  const patchRule = (i: number, p: Partial<ChallengeCommentRule>): void => {
    onPatch({ commentRules: rules.map((r, j) => (j === i ? { ...r, ...p } : r)) });
  };

  return (
    <>
      <h3>指定コメントの妨害</h3>
      <div className="faint" style={{ fontSize: 11, marginTop: 6, marginBottom: 10 }}>
        登録したキーワードが<b>コメントに含まれていたら</b>(部分一致)、その規則の量だけカウントが
        <b>増えます</b>(妨害)。複数の規則は<b>上から順に評価し、最初に一致した1件だけ</b>適用。
        同じ人が連投しても<b>打たれるたび毎回</b>反応します。規則が1件も無ければこの機能はオフです。
        効果音・簡易演出は「効果音」「演出」タブの「コメント妨害」スロットで変えられます。
      </div>

      {rules.length === 0 ? (
        <div className="faint" style={{ fontSize: 12, marginBottom: 8 }}>
          登録された規則はありません(どのコメントでもカウントは動きません)。
        </div>
      ) : null}
      {rules.map((r, i) => (
        <div className="challenge-rule" key={r.id}>
          <label className="field" style={{ flex: 1 }}>
            キーワード(コメントに含まれたら反応)
            <input
              type="text"
              placeholder="例: おやすみ"
              value={r.keyword}
              onChange={(e) => patchRule(i, { keyword: e.target.value })}
            />
          </label>
          <div className="row" style={{ gap: 6 }}>
            <label className="field" style={{ width: 110 }}>
              加算量(妨害)
              <input
                type="number"
                min="1"
                value={r.amount}
                onChange={(e) => patchRule(i, { amount: Number(e.target.value) })}
              />
            </label>
            <MonitorTestBtn
              spec={r.keyword.trim() !== '' ? { kind: 'comment', ruleId: r.id } : null}
              onTest={onTest}
              busy={testBusy}
              label="▶ モニター"
              title={
                r.keyword.trim() !== ''
                  ? 'このコメントが届いた体でモニターに実演再生(値は動きません)'
                  : 'キーワードを入力すると実演再生できます'
              }
              style={{ alignSelf: 'flex-end' }}
            />
          </div>
          <button
            className="btn small danger"
            onClick={() => onPatch({ commentRules: rules.filter((_, j) => j !== i) })}
          >
            削除
          </button>
        </div>
      ))}
      <div className="row" style={{ marginTop: 8 }}>
        <button
          className="btn small"
          disabled={rules.length >= COMMENT_RULES_MAX}
          onClick={() =>
            onPatch({
              commentRules: [
                ...rules,
                { id: `cr-${Date.now().toString(36)}-${crSeq++}`, keyword: '', amount: 10 },
              ],
            })
          }
        >
          規則を追加
        </button>
      </div>
      <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>
        キーワードは絵文字や語尾が付いても反応します(例:「おやすみ」→「おやすみ〜🌙」)。
        英字は大文字小文字を区別しません。空欄の規則は何にも反応しません。
      </div>
    </>
  );
}

/**
 * お助け機能(ファンスタンプ)。クリエイター専用のカスタムギフトを「応援」に割り当て、
 * 届いた個数ぶんカウントを減らす。ルーレット/ギフト増減規則より先に評価される。
 *
 * giftId は文字列比較(normalize.ts の idStr)なので type="text" で扱う —
 * type="number" にすると前置ゼロや長い ID が壊れる(RouletteRow と同じ理由)。
 */
/**
 * 配信中に届いたギフトから giftId を拾って設定へ写すピッカー。
 *
 * ファンスタンプは**配信者ごとのカスタムギフト**なので既定値も一覧も存在せず、
 * ID を事前に知る方法が無い。ギフト名での指定は表記ゆれと同名別IDで外れるため、
 * 「実際に届いた1件の giftId をそのまま写す」のが唯一確実な入手経路になる。
 *
 * 出所はライブフィード(useLive の feed)— worker が gid を載せている。
 * 同じギフトが連続で並ぶので giftId で名寄せし、新しい順に数件だけ出す。
 * 未接続やギフト未着でフィードが空のときは、その旨だけ出して何も描かない。
 */
function GiftIdPicker({
  selected,
  onPick,
}: {
  selected: string;
  onPick: (giftId: string) => void;
}): React.JSX.Element {
  const feed = useLive((s) => s.feed);
  // フィードは新しい順。giftId で重複を畳んで先頭 8 件。
  const seen = new Set<string>();
  const gifts: Array<{ gid: string; name: string; dia: number }> = [];
  for (const f of feed) {
    if (f.k !== 'g' || f.gid === '' || seen.has(f.gid)) continue;
    seen.add(f.gid);
    gifts.push({ gid: f.gid, name: f.gift, dia: f.dia });
    if (gifts.length >= 8) break;
  }

  return (
    <label className="field" style={{ marginBottom: 8 }}>
      最近届いたギフトから取得（クリックで上の「対象 giftId」に入ります）
      {gifts.length === 0 ? (
        <div className="faint" style={{ fontSize: 11, paddingTop: 6 }}>
          配信に接続してギフトが届くと、ここに giftId 付きで並びます。
        </div>
      ) : (
        <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
          {gifts.map((g) => (
            <button
              key={g.gid}
              type="button"
              className={g.gid === selected ? 'active' : ''}
              title={`giftId ${g.gid} を対象に設定します（${g.dia}💎）`}
              onClick={() => onPick(g.gid)}
              style={{ fontSize: 11 }}
            >
              {g.name}
              <span style={{ color: 'var(--fg-dim)' }}> {g.gid}</span>
            </button>
          ))}
        </div>
      )}
    </label>
  );
}

function HelperSection({ cfg, onPatch, onTest, testBusy }: SectionProps): React.JSX.Element {
  const fs = cfg.fanStamp;
  // fanStamp はネストしたオブジェクト — 丸ごと差し替える(patchBf と同じ作法)。
  const patchFs = (p: Partial<FanStampConfig>): void => {
    onPatch({ fanStamp: { ...fs, ...p } });
  };
  // 効果音・簡易演出はお助け専用スロット('helper')。設定の実体は seSounds /
  // seVolumes / miniFx なので、「効果音」タブ・「演出」タブと同じ値を映す。
  const seOff = cfg.seSounds.helper === 'off';

  return (
    <>
      <h3>お助け機能(ファンスタンプ)</h3>
      <label className="row" style={{ cursor: 'pointer' }}>
        <input type="checkbox" checked={fs.enabled} onChange={(e) => patchFs({ enabled: e.target.checked })} />
        <span>ファンスタンプでカウントを減らす</span>
      </label>
      <div className="faint" style={{ fontSize: 11, marginLeft: 22, marginBottom: 10 }}>
        あなた専用のカスタムギフト(ファンスタンプ)が届いたら、<b>個数 × 指定量</b>だけカウントを動かします。
        <b>ギフト増減規則・ギフトルーレットより先に評価</b>され、一致したギフトはそちらの規則を通りません。
      </div>

      {fs.enabled ? (
        <>
          <div className="row" style={{ gap: 8 }}>
            <label className="field" style={{ width: 160 }}>
              対象 giftId
              <input
                type="text"
                placeholder="例: 76637"
                value={fs.giftId}
                onChange={(e) => patchFs({ giftId: e.target.value.trim() })}
              />
            </label>
            <label className="field" style={{ flex: 1 }}>
              ギフト名(部分一致・IDが変わった時の保険)
              <input
                type="text"
                placeholder="例: おやすみトッポ"
                value={fs.giftName}
                onChange={(e) => patchFs({ giftName: e.target.value.toLowerCase() })}
              />
            </label>
            <label className="field" style={{ width: 110 }}>
              1個あたりの増減
              <input
                type="number"
                value={fs.amountEach}
                onChange={(e) => patchFs({ amountEach: Number(e.target.value) })}
              />
            </label>
          </div>
          <GiftIdPicker selected={fs.giftId} onPick={(giftId) => patchFs({ giftId })} />
          <div className="faint" style={{ fontSize: 11, marginBottom: 10 }}>
            負の値=数字が<b>減る</b>(お助け)、正の値=増える(妨害)。10連打なら この値 × 10 です。
          </div>

          <label className="row" style={{ cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={fs.suppressBandFx}
              onChange={(e) => patchFs({ suppressBandFx: e.target.checked })}
            />
            <span>カットイン演出を出さない(推奨)</span>
          </label>
          <div className="faint" style={{ fontSize: 11, marginLeft: 22, marginBottom: 8 }}>
            1ダイヤのギフトでも「ダイヤ数のカットイン」が出ると<b>その間カウントが止まります</b>
            (既定で6秒)。ファンスタンプは連続で届くので、オフを強く推奨します。
          </div>

          <label className="row" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={fs.flash} onChange={(e) => patchFs({ flash: e.target.checked })} />
            <span>照明フラッシュ</span>
          </label>

          <h4 style={{ margin: '14px 0 6px' }}>お助け専用の効果音・簡易演出</h4>
          <div className="row" style={{ gap: 6, alignItems: 'center' }}>
            <span style={{ flex: '0 0 72px', fontSize: 11 }}>効果音</span>
            <select
              style={{ flex: 1, minWidth: 0 }}
              disabled={!cfg.seEnabled}
              value={cfg.seSounds.helper}
              onChange={(e) => onPatch({ seSounds: { ...cfg.seSounds, helper: e.target.value } })}
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
              value={cfg.seVolumes.helper}
              disabled={!cfg.seEnabled || seOff}
              title="この音だけの音量(全体音量に対する割合)"
              onChange={(e) =>
                onPatch({ seVolumes: { ...cfg.seVolumes, helper: Number(e.target.value) } })
              }
            />
            <span className="faint" style={{ fontSize: 11, minWidth: 32, textAlign: 'right' }}>
              {cfg.seVolumes.helper}%
            </span>
            <button
              className="btn small"
              disabled={!cfg.seEnabled || seOff}
              title="この音を試聴(全体×個別の実際の音量で鳴ります)"
              onClick={() =>
                playSe(cfg.seSounds.helper, effectiveSeVolume(cfg.seVolume, cfg.seVolumes.helper))
              }
            >
              ♪
            </button>
          </div>
          {!cfg.seEnabled ? (
            <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
              「効果音」タブの<b>「演出の効果音を鳴らす」がオフ</b>なので、いまは鳴りません。
            </div>
          ) : null}

          <div className="row" style={{ gap: 6, alignItems: 'center', marginTop: 6 }}>
            <span style={{ flex: '0 0 72px', fontSize: 11 }}>簡易演出</span>
            <select
              style={{ flex: 1, minWidth: 0 }}
              disabled={!cfg.miniFxEnabled}
              value={cfg.miniFx.helper}
              onChange={(e) => onPatch({ miniFx: { ...cfg.miniFx, helper: e.target.value } })}
            >
              <option value="off">出さない</option>
              {CHALLENGE_MINI_IDS.map((m) => (
                <option key={m} value={m}>
                  {MINI_LABELS[m] ?? m}
                </option>
              ))}
            </select>
          </div>
          {!cfg.miniFxEnabled ? (
            <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
              「演出」タブの<b>「7セグの上に軽いアニメを重ねる」がオフ</b>なので、いまは出ません。
            </div>
          ) : null}
          <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
            この2つは<b>お助けギフト専用</b>で、ほかのギフト(小)には影響しません。同じ設定は
            「効果音」タブ・「演出 &gt; 簡易演出」の<b>お助け(ファンスタンプ)</b>の行にも出ます。
          </div>

          <div className="row" style={{ marginTop: 10 }}>
            <MonitorTestBtn
              spec={{ kind: 'fanStamp' }}
              onTest={onTest}
              busy={testBusy}
              label="▶ お助け演出をテスト"
              title="モニターウィンドウでお助けバナーを実演再生します(giftId 未設定でも確認できます)"
            />
            <MonitorTestBtn
              spec={{ kind: 'fanStamp', multi: true }}
              onTest={onTest}
              busy={testBusy}
              label="▶ まとめて届いたとき"
              title="複数人ぶんを1枚にまとめた合算バナーを実演再生します"
            />
          </div>

          <div className="faint" style={{ fontSize: 11, marginTop: 10 }}>
            giftId が空のあいだは何にも一致しません(この機能はオフと同じです)。giftId は
            ギフト一覧やビューアー詳細のギフト履歴で確認できます。モニターには
            <b>「−N ◯◯さん がお助け!」の専用バナー</b>(緑リング)が出ます — ギフトカードは出しません。
            効果音・簡易演出は上の<b>お助け専用</b>の設定が使われます。なお「ギフト増減」タブの
            「チャレンジ設定をすべて既定に戻す」を押すと、この設定も既定に戻ります。
          </div>
        </>
      ) : null}

      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn small" onClick={() => onPatch({ fanStamp: structuredClone(DEFAULT_FAN_STAMP) })}>
          お助け設定を既定に戻す
        </button>
      </div>
    </>
  );
}

/**
 * タップブースト(フィーバー)。トリガーギフトが届くと 起動カットイン(咆哮・
 * 固定5秒)→ カウントダウン(3・2・1 映像焼き込み・固定3秒)→ タップウィンドウ
 * (5〜15秒・ループ映像+BGM)→ 溜めたタップの着弾一括減算、と進む。
 * 各段の映像はドロップダウンで選択できる(id の出所は shared の TAP_BOOST_*_CLIPS)。
 *
 * giftId が type="text" なのは HelperSection と同じ理由(前置ゼロ・長い ID)。
 */
function BoostSection({ cfg, onPatch, onTest, testBusy }: SectionProps): React.JSX.Element {
  const tb = cfg.tapBoost;
  // tapBoost はネストしたオブジェクト — 丸ごと差し替える(patchFs と同じ作法)。
  const patchTb = (p: Partial<TapBoostConfig>): void => {
    onPatch({ tapBoost: { ...tb, ...p } });
  };
  const patchRule = (i: number, p: Partial<TapBoostRule>): void => {
    patchTb({ rules: tb.rules.map((r, j) => (j === i ? { ...r, ...p } : r)) });
  };
  const introSec = Math.round(TAP_BOOST_INTRO_MS / 1000);
  const countSec = Math.round(TAP_BOOST_COUNT_MS / 1000);
  const resultSec = Math.round(TAP_BOOST_RESULT_MS / 1000);

  return (
    <>
      <h3>タップブースト(フィーバー)</h3>
      <label className="row" style={{ cursor: 'pointer' }}>
        <input type="checkbox" checked={tb.enabled} onChange={(e) => patchTb({ enabled: e.target.checked })} />
        <span>指定ギフトでタップブーストを発動する</span>
      </label>
      <div className="faint" style={{ fontSize: 11, marginLeft: 22, marginBottom: 10 }}>
        ギフトが届くと <b>起動カットイン{introSec}秒 → カウントダウン{countSec}秒(3・2・1)→
        タップウィンドウ</b>に入り、その間の PUSH(クリック / Space / ホットキー)は
        <b>数えるだけ</b>で溜まります。ウィンドウが終わると<b>結果カットシーン(任意)→
        減算量「-N」のドラムロール発表 → 7セグへ着弾</b>と進み、
        <b>タップ数 × 1回の減少量 × 倍率</b> がまとめて減ります。
        <b>お助け(ファンスタンプ)より後・ルーレットより先</b>に判定され、一致したギフトは
        増減規則を通りません。
      </div>

      {tb.enabled ? (
        <>
          {tb.rules.map((r, i) => (
            <div className="challenge-rule" key={r.id}>
              <label
                className="row"
                style={{ cursor: 'pointer', width: 60 }}
                title="この行だけ一時的に止めます(下の行の判定は続きます)"
              >
                <input
                  type="checkbox"
                  checked={r.enabled}
                  onChange={(e) => patchRule(i, { enabled: e.target.checked })}
                />
                <span className="faint" style={{ fontSize: 11 }}>
                  有効
                </span>
              </label>
              <label className="field" style={{ width: 110 }}>
                表示名
                <input
                  type="text"
                  value={r.label}
                  placeholder="コーギー"
                  onChange={(e) => patchRule(i, { label: e.target.value })}
                />
              </label>
              <label className="field" style={{ width: 110 }}>
                対象 giftId
                <input
                  type="text"
                  placeholder="例: 6267"
                  value={r.giftId}
                  onChange={(e) => patchRule(i, { giftId: e.target.value.trim() })}
                />
              </label>
              <div style={{ width: 150 }}>
                <label className="field">
                  ギフト名(IDの保険)
                  <input
                    type="text"
                    value={r.giftName}
                    placeholder="corgi"
                    onChange={(e) => patchRule(i, { giftName: e.target.value.toLowerCase() })}
                  />
                </label>
                <label
                  className="row"
                  style={{ cursor: 'pointer', marginTop: 2 }}
                  title="オンにするとギフト名が完全に一致したときだけ発動します。オフ(既定)は部分一致で、たとえば「panther」は「Panther Paw」にも当たります。ブーストは一致すると最長23秒カウントが止まるので、短い名前を使うときはオンにしてください。"
                >
                  <input
                    type="checkbox"
                    checked={r.exactName}
                    onChange={(e) => patchRule(i, { exactName: e.target.checked })}
                  />
                  <span className="faint" style={{ fontSize: 11 }}>
                    完全一致
                  </span>
                </label>
              </div>
              <label className="field" style={{ width: 90 }}>
                タップ倍率
                <input
                  type="number"
                  min={TAP_BOOST_MULT_MIN}
                  max={TAP_BOOST_MULT_MAX}
                  value={r.multiplier}
                  onChange={(e) => patchRule(i, { multiplier: Number(e.target.value) })}
                />
              </label>
              <label className="field" style={{ width: 110 }}>
                ウィンドウ(秒)
                <input
                  type="number"
                  min={TAP_BOOST_DURATION_MIN_SEC}
                  max={TAP_BOOST_DURATION_MAX_SEC}
                  value={r.durationSec}
                  onChange={(e) => patchRule(i, { durationSec: Number(e.target.value) })}
                />
              </label>
              <label className="field" style={{ width: 150 }}>
                起動カットイン({introSec}秒)
                <select value={r.introClip} onChange={(e) => patchRule(i, { introClip: e.target.value })}>
                  {TAP_BOOST_INTRO_CLIPS.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                  <option value="off">出さない(この段をスキップ)</option>
                </select>
              </label>
              <label className="field" style={{ width: 150 }}>
                カウントダウン({countSec}秒)
                <select value={r.countClip} onChange={(e) => patchRule(i, { countClip: e.target.value })}>
                  {TAP_BOOST_COUNT_CLIPS.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                  <option value="off">出さない(この段をスキップ)</option>
                </select>
              </label>
              <label className="field" style={{ width: 150 }}>
                タップウィンドウの映像
                <select value={r.loopClip} onChange={(e) => patchRule(i, { loopClip: e.target.value })}>
                  {TAP_BOOST_LOOP_CLIPS.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                  <option value="off">出さない(暗幕+カウンタのみ)</option>
                </select>
              </label>
              <label className="field" style={{ width: 150 }}>
                結果カットシーン({resultSec}秒)
                <select value={r.resultClip} onChange={(e) => patchRule(i, { resultClip: e.target.value })}>
                  {TAP_BOOST_RESULT_CLIPS.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                  <option value="off">出さない(この段をスキップ)</option>
                </select>
              </label>
              <label className="row" style={{ cursor: 'pointer', width: 76 }}>
                <input
                  type="checkbox"
                  checked={r.flash}
                  onChange={(e) => patchRule(i, { flash: e.target.checked })}
                />
                <span className="faint" style={{ fontSize: 11 }}>
                  フラッシュ
                </span>
              </label>
              <MonitorTestBtn
                spec={{ kind: 'tapBoost', boostId: r.id }}
                onTest={onTest}
                busy={testBusy}
                label="▶ この行"
                title="モニターウィンドウで、この行の設定(倍率・秒数・映像)のまま起動カットイン→3・2・1→タップウィンドウ→結果カットシーン→減算発表→着弾を実演再生します(giftId 未設定でも確認できます)。カウント値は変わりません"
              />
              <button
                className="btn small"
                title="この行を削除します"
                onClick={() => patchTb({ rules: tb.rules.filter((_, j) => j !== i) })}
              >
                削除
              </button>
            </div>
          ))}

          <div className="row" style={{ marginTop: 8, gap: 8 }}>
            <button
              className="btn small"
              disabled={tb.rules.length >= TAP_BOOST_RULES_MAX}
              onClick={() =>
                patchTb({
                  rules: [
                    ...tb.rules,
                    {
                      ...structuredClone(DEFAULT_TAP_BOOST_RULE),
                      id: `boost-${Date.now().toString(36)}-${clipSeq++}`,
                    },
                  ],
                })
              }
            >
              ブーストを追加
            </button>
            <span className="faint" style={{ fontSize: 11 }}>
              最大 {TAP_BOOST_RULES_MAX} 件(現在 {tb.rules.length} 件)
            </span>
          </div>

          <div className="faint" style={{ fontSize: 11, marginTop: 10 }}>
            例: 倍率5・1回の減少量1で、ウィンドウ中に20回タップすると <b>−100</b> がまとめて反映されます。
            起動{introSec}秒・カウントダウン{countSec}秒は固定です(3・2・1 が映像に焼き込まれているため)。
            「スキップ」にした段はその秒数ごと飛ばします。映像は素材を assets/fx/boost に追加すると
            選択肢を増やせます(素材が無い段は暗幕で同じ秒数を待ちます)。結果カットシーンをスキップしても
            <b>減算量「-N」のドラムロール発表と着弾は必ず出ます</b>。
          </div>
          <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>
            <b>上から順に判定し、最初に一致した1行だけ</b>が発動します。giftId で当てるのが最も確実です。
            トリガーが3つとも空の行は何にも一致しません(その行はオフと同じ)。
            演出中はモニターの数字が止まり、<b>画面中央にタップ数のカウンタ</b>が出ます。
            モニターを閉じているとき(演出が出せないとき)はカウントを止めず、
            タップのたびに倍率ぶんが即時反映されます。効果音は「効果音」タブの
            <b>ブースト タップ開始 / ブースト着弾</b>で変更できます。
          </div>
        </>
      ) : null}

      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn small" onClick={() => onPatch({ tapBoost: structuredClone(DEFAULT_TAP_BOOST) })}>
          ブースト設定を既定に戻す
        </button>
      </div>
    </>
  );
}
