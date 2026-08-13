import { describe, expect, it } from 'vitest';
import { CSV_BOM, CsvText, compact, csvCell, csvRow, diamondsToJpy, num, percent, score } from '@shared/format';

describe('csvCell — Excel 安全性', () => {
  it('数式インジェクションの接頭辞を無効化する', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@cmd')).toBe("'@cmd");
  });

  it('引用符・改行・カンマを含むセルをクォートする', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('null/undefined は空セル', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('CsvText は int64 を丸めさせない ="…" 形式で出す', () => {
    // 19桁の user_id — 素の数値セルだと Excel が 6.88E+18 に丸めて復元不能になる。
    expect(csvCell(new CsvText('6885748734620038153'))).toBe('"=""6885748734620038153"""');
  });

  it('csvRow は CRLF 終端', () => {
    expect(csvRow(['a', 1])).toBe('a,1\r\n');
  });

  it('BOM は U+FEFF', () => {
    expect(CSV_BOM.charCodeAt(0)).toBe(0xfeff);
  });
});

describe('compact — 桁境界の丸め上がり', () => {
  it('9999.5 は 1.0万(丸め後に桁があふれない)', () => {
    expect(compact(9999.5)).toBe('1.0万');
  });
  it('9999.4 は 9,999', () => {
    expect(compact(9999.4)).toBe('9,999');
  });
  it('99,999,500 は 1.0億(10000.0万 にならない)', () => {
    expect(compact(99_999_500)).toBe('1.0億');
  });
  it('99,999,499 は 万 表示のまま', () => {
    expect(compact(99_999_499)).toBe('9999.9万');
  });
  it('非有限は —', () => {
    expect(compact(null)).toBe('—');
    expect(compact(Number.NaN)).toBe('—');
  });
});

describe('percent / diamondsToJpy / num / score — エッジケース', () => {
  it('percent は NaN を表示しない', () => {
    expect(percent(Number.NaN, 100)).toBe('—');
    expect(percent(50, 0)).toBe('—');
    expect(percent(50, 100)).toBe('50.0%');
  });
  it('diamondsToJpy は積のオーバーフローで ∞ を出さない', () => {
    expect(diamondsToJpy(Number.MAX_VALUE, 2)).toBe('—');
    expect(diamondsToJpy(1000, 0.5)).toBe('約 ¥500');
  });
  it('num / score の非有限ガード', () => {
    expect(num(undefined)).toBe('—');
    expect(score(Number.POSITIVE_INFINITY)).toBe('—');
    expect(score(99.94)).toBe('99.9'); // toFixed 表示レンジ
  });
});
