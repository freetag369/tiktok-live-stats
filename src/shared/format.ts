/** Presentation helpers. Kept in shared so worker-side CSV and the UI agree. */

const NF = new Intl.NumberFormat('ja-JP');

export function num(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return NF.format(Math.round(n));
}

/** Compact form for dense tables: 12.3万 / 1,234. */
export function compact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  // 丸め上がりを閾値に織り込む: 9999.5 は「10,000」ではなく「1.0万」、
  // 99,999,500 は「10000.0万」ではなく「1.0億」と表示する。
  if (a >= 100_000_000 - 500) return `${(n / 100_000_000).toFixed(1)}億`;
  if (a >= 10_000 - 0.5) return `${(n / 10_000).toFixed(1)}万`;
  return NF.format(Math.round(n));
}

/** Diamonds → yen, at a user-configurable rate. Always labelled 目安 in the UI. */
export function diamondsToJpy(diamonds: number, rate: number): string {
  if (!Number.isFinite(diamonds) || !Number.isFinite(rate)) return '—';
  const yen = Math.round(diamonds * rate);
  if (!Number.isFinite(yen)) return '—'; // 積のオーバーフローで「約 ¥∞」を出さない
  return `約 ¥${NF.format(yen)}`;
}

export function percent(part: number, whole: number, digits = 1): string {
  // part も検証する — NaN が来ると "NaN%" がそのまま画面に出る。
  if (!whole || !Number.isFinite(part) || !Number.isFinite(whole)) return '—';
  return `${((part / whole) * 100).toFixed(digits)}%`;
}

export function score(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n >= 100 ? NF.format(Math.round(n)) : n.toFixed(1);
}

export function bytes(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * 19桁の user_id(int64 を文字列で保持 — events.ts の「NEVER parseInt」の出口版)を
 * Excel が数値と解釈すると 6.88E+18 に丸められ復元不能になる。`="…"` 形式の
 * テキスト数式として出力させる明示マーカー。
 */
export class CsvText {
  constructor(readonly value: string) {}
}

/** Excel-safe CSV cell: quotes, embedded newlines, and the =/+/-/@ formula-injection prefixes. */
export function csvCell(v: unknown): string {
  if (v == null) return '';
  if (v instanceof CsvText) {
    // ="123..." — Excel はテキストを返す数式として評価し、桁を保つ。
    // 中身の引用符は CSV とセル内文字列の両方でエスケープする。
    const inner = v.value.replace(/"/g, '""""');
    return `"=""${inner}"""`;
  }
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/["\n\r,]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvRow(cells: readonly unknown[]): string {
  return cells.map(csvCell).join(',') + '\r\n';
}

/** Excel on Japanese Windows needs the BOM or UTF-8 renders as mojibake. */
export const CSV_BOM = '﻿';
