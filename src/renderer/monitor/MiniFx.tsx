import panicUrl from '../assets/fx/mini/panic-man.webp';

/**
 * 簡易演出 — SVG + CSS キーフレームの軽量アニメ。
 *
 * 映像クリップ(assets/fx/*.mp4)が最短4秒で高頻度イベントには重いのに対し、
 * こちらはバンドル増加ゼロ・デコード無しで一瞬だけ出る。ハートミーやいいねの
 * ように連発されるものはこちら側で受ける。
 *
 * 設計上の約束:
 * - 動き(@keyframes)は monitor.css 側。ここは形だけを持つ。
 * - 衝撃の星・集中線も同じ SVG 内に置き、同じアニメーションで動かす。
 *   JS タイマーで canvas と同期させると必ずズレるため、外に出さない。
 * - 位置(数字の左上)と寸法は外側の .mini が left/top/width/height で持ち、
 *   回転・拡縮は内側の .mini-art が持つ。1要素に両方載せると keyframes の
 *   transform が位置指定を上書きする。
 *
 * 素材を持つのは 'panic' の1枚だけ(理由は Panic のコメント)。
 */

/*
 * 初回発火で復号待ちの空フレームが出ないよう、モジュール読み込み時に温めておく。
 * <img> には <video> のような preload 属性が無く、CSS 経由でも先読みされない。
 */
if (typeof Image !== 'undefined') {
  const warm = new Image();
  warm.src = panicUrl;
}

export interface MiniFxProps {
  /** CHALLENGE_MINI_IDS の id。 */
  id: string;
  /** カウント変化量。ハンコに載せる(0 のときは出さない)。 */
  amount: number;
}

export function MiniFx({ id, amount }: MiniFxProps): React.JSX.Element | null {
  if (id === 'hammer') return <Hammer />;
  if (id === 'stamp') return <Stamp amount={amount} />;
  if (id === 'shock') return <Shock />;
  if (id === 'panic') return <Panic />;
  return null;
}

/**
 * ピコピコハンマー。右上の支点を中心に振り下ろし、7セグの上で当たって星が散る。
 *
 * 幾何は1箇所に集約する: 柄と頭は +x 方向に真っ直ぐ描き、
 * translate(支点) rotate(角度) でまとめて所定の姿勢へ倒す。
 * CSS 側の回転は同じ支点(PIVOT)を transform-box: view-box で指定すること
 * — fill-box にすると基準がグループ自身の bbox になり支点がズレる。
 */
const PIVOT = { x: 82, y: 18 };
/** 支点から見た柄の向き。頭が viewBox の中央下(≒7セグ)に来る角度。 */
const ARM_DEG = 133.5;

function Hammer(): React.JSX.Element {
  return (
    <svg className="mini-art mini-hammer" viewBox="0 0 100 100" aria-hidden="true">
      <g className="mh-body">
        <g transform={`translate(${PIVOT.x} ${PIVOT.y}) rotate(${ARM_DEG})`}>
          {/* 柄 — 支点から +x へ伸ばす */}
          <rect x="-2" y="-3.5" width="54" height="7" rx="3.5" fill="#ffc542" />
          {/* 頭 — 柄の先に直角の円筒。白帯とハイライトで玩具らしく */}
          <rect x="36" y="-20" width="34" height="40" rx="12" fill="#ff5c8a" />
          <rect x="36" y="-6" width="34" height="12" fill="#fff3f7" opacity="0.92" />
          <rect x="40" y="-16" width="8" height="32" rx="4" fill="#ffffff" opacity="0.3" />
        </g>
      </g>
      {/* 着弾の星 — 頭が当たる点(45,62)に合わせ、当たる瞬間だけ開く */}
      <g className="mh-hit" stroke="#ffe27a" strokeWidth="4.5" strokeLinecap="round">
        <line x1="45" y1="62" x2="45" y2="44" />
        <line x1="45" y1="62" x2="27" y2="50" />
        <line x1="45" y1="62" x2="63" y2="50" />
        <line x1="45" y1="62" x2="21" y2="66" />
        <line x1="45" y1="62" x2="69" y2="66" />
      </g>
    </svg>
  );
}

/** ハンコ。回転しながら押し込まれ、ドンと止まって滲む。 */
function Stamp({ amount }: { amount: number }): React.JSX.Element {
  const label = amount > 0 ? `+${amount}` : amount < 0 ? String(amount) : '';
  return (
    <svg className="mini-art mini-stamp" viewBox="0 0 100 100" aria-hidden="true">
      {/* 下敷き。7セグの赤と重なると +N が読めないので、押された跡として一瞬だけ覆う。 */}
      <circle cx="50" cy="50" r="34" fill="rgba(0, 0, 0, 0.62)" />
      <circle cx="50" cy="50" r="34" fill="none" stroke="#ff2d2d" strokeWidth="6" />
      {label ? (
        <text
          x="50"
          y="50"
          textAnchor="middle"
          dominantBaseline="central"
          fill="#ff2d2d"
          fontSize="30"
          fontWeight="700"
          fontFamily="'Cascadia Mono', Consolas, ui-monospace, monospace"
        >
          {label}
        </text>
      ) : null}
    </svg>
  );
}

/** 集中線。最軽量 — いいねのような高頻度イベント向け。 */
function Shock(): React.JSX.Element {
  const lines = Array.from({ length: 12 }, (_, i) => {
    const a = (i / 12) * Math.PI * 2;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    return (
      <line
        key={i}
        x1={50 + cos * 26}
        y1={50 + sin * 26}
        x2={50 + cos * 46}
        y2={50 + sin * 46}
      />
    );
  });
  return (
    <svg className="mini-art mini-shock" viewBox="0 0 100 100" aria-hidden="true">
      <g stroke="#ff4fa0" strokeWidth="3.5" strokeLinecap="round">
        {lines}
      </g>
    </svg>
  );
}

/**
 * 絶望カットイン。フォロー妨害の既定 — 戻された数字の左上で頭を抱える。
 *
 * SVG 勢と違い素材を持つが、mp4 のようなデコード待ちが無く1枚を使い回すので
 * 連発しても軽い(≒97KB)。素材(assets/fx/mini/panic-man.webp)は元写真の黒背景を
 * そのまま置くと矩形の切り口が見えるため、**楕円のアルファを焼き込んである**。
 * したがって CSS 側で mask を重ねないこと — 二重にフェードして芯まで薄くなる。
 *
 * 箱が素材と同じ 3:2 になるよう playMini が w/h を分けて出しているので、
 * ここは縦横比を触らない。amount(±N)も載せない — フォローの +N は
 * 浮上バナーが既に出しており、小さな写真の上で重ねても読めない。
 */
function Panic(): React.JSX.Element {
  return <img className="mini-art mini-panic" src={panicUrl} alt="" aria-hidden />;
}
