import { memo } from 'react';

/**
 * SVG 自作の7セグメント数字。
 *
 * 外部フォント(DSEG 等)を使わないのは CSP(font-src 'self')とオフライン動作の
 * 制約のため。SVG なら任意サイズでシャープに出る上、消灯セグメントを薄く常時
 * 表示する「ゴースト 8888」という 7 セグ特有の見た目が無料で手に入る。
 */

// セグメント順: a(上) b(右上) c(右下) d(下) e(左下) f(左上) g(中央)
// ビットは 0bABCDEFG(a=64 … g=1)。
const SEG: Record<string, number> = {
  '0': 0b1111110,
  '1': 0b0110000,
  '2': 0b1101101,
  '3': 0b1111001,
  '4': 0b0110011,
  '5': 0b1011011,
  '6': 0b1011111,
  '7': 0b1110000,
  '8': 0b1111111,
  '9': 0b1111011,
};

/** viewBox 0 0 100 180。面取り付き六角形バー7本。 */
const SEGMENT_POLYGONS = [
  '8,10 16,2 84,2 92,10 84,18 16,18', // a
  '90,10 98,18 98,82 90,90 82,82 82,18', // b
  '90,90 98,98 98,162 90,170 82,162 82,98', // c
  '8,170 16,162 84,162 92,170 84,178 16,178', // d
  '10,90 18,98 18,162 10,170 2,162 2,98', // e
  '10,10 18,18 18,82 10,90 2,82 2,18', // f
  '8,90 16,82 84,82 92,90 84,98 16,98', // g
];

const Digit = memo(function Digit({ ch }: { ch: string }) {
  const on = SEG[ch] ?? 0; // 空白(ゴースト桁)は全消灯
  return (
    <svg className="seg-digit" viewBox="0 0 100 180" aria-hidden>
      {SEGMENT_POLYGONS.map((pts, i) => (
        <polygon key={i} points={pts} className={on & (1 << (6 - i)) ? 'seg on' : 'seg'} />
      ))}
    </svg>
  );
});

/**
 * 値を右詰めで表示する。digits 桁に満たない上位桁は全消灯(ゴーストのみ)。
 * 値が桁数を超えたら必要なだけ桁を増やす(妨害で初期値を超えることがある)。
 */
export function SevenSeg({ value, digits }: { value: number; digits: number }): React.JSX.Element {
  const text = String(Math.max(0, Math.floor(value)));
  const width = Math.max(digits, text.length);
  const padded = text.padStart(width, ' ');
  return (
    <div className="seg-row" role="img" aria-label={text}>
      {Array.from(padded).map((ch, i) => (
        <Digit key={`${width}-${i}`} ch={ch} />
      ))}
    </div>
  );
}
