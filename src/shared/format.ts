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
  if (a >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}億`;
  if (a >= 10_000) return `${(n / 10_000).toFixed(1)}万`;
  return NF.format(Math.round(n));
}

/** Diamonds → yen, at a user-configurable rate. Always labelled 目安 in the UI. */
export function diamondsToJpy(diamonds: number, rate: number): string {
  if (!Number.isFinite(diamonds) || !Number.isFinite(rate)) return '—';
  return `約 ¥${NF.format(Math.round(diamonds * rate))}`;
}

export function percent(part: number, whole: number, digits = 1): string {
  if (!whole) return '—';
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

/** Excel-safe CSV cell: quotes, embedded newlines, and the =/+/-/@ formula-injection prefixes. */
export function csvCell(v: unknown): string {
  if (v == null) return '';
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
