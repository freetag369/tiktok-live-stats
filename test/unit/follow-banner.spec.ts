import { describe, expect, it } from 'vitest';
import { followBannerParts } from '@shared/fan-stamp';

/**
 * フォロー合算バナーの文言決定(followBannerParts)。
 *
 * fanStampBannerParts と同じ最優先契約 — **1人ぶん(= 従来と同じ状況)では
 * 従来と完全に同じ結果**(names = [nickname]・multi=false)。モニターの
 * case 'follow' はこの結果だけで文言とクラスを決めるので、ここが従来形を
 * 返す限り既存の単発バナーは1ドットも変わらない。
 *
 * 名前の詰め方(人数上限・1人8文字・総予算14)は fan-stamp と共有 —
 * packNames が唯一の実装で、fan-stamp.spec.ts 側の予算テストが権威。
 */

describe('followBannerParts', () => {
  it('1人ぶんは従来と同じ(multi=false・nickname がそのまま)', () => {
    const p = followBannerParts({ amount: 10, nickname: 'たろう' });
    expect(p).toEqual({ names: ['たろう'], othersCount: 0, people: 1, multi: false });
  });

  it('合算3人 → 名前列 + people=3(coalesced が人数)', () => {
    const p = followBannerParts({
      amount: 30,
      nickname: 'ひと1',
      coalesced: 3,
      followNames: ['ひと1', 'ひと2', 'ひと3'],
    });
    expect(p.multi).toBe(true);
    expect(p.people).toBe(3);
    expect(p.names).toEqual(['ひと1', 'ひと2', 'ひと3']);
    expect(p.othersCount).toBe(0);
  });

  it('長い名前は 8 文字 + … に詰め、総予算 14 を超えたら人数を減らす', () => {
    const p = followBannerParts({
      amount: 30,
      nickname: 'あいうえおかきくけこ',
      coalesced: 3,
      followNames: ['あいうえおかきくけこ', 'さしすせそたちつてと', 'なにぬねの'],
    });
    // 1人目 = 7文字+…(8枠)。2人目は「・」込み 9 で予算 14 を超える → 1人だけ。
    expect(p.names).toEqual(['あいうえおかき…']);
    expect(p.othersCount).toBe(2);
    expect(p.people).toBe(3);
    expect(p.multi).toBe(true);
  });

  it('followNames 欠損 + coalesced≥2(旧 worker の effect)は nickname 1件へフォールバック', () => {
    const p = followBannerParts({ amount: 20, nickname: 'ふるい', coalesced: 2 });
    expect(p).toEqual({ names: ['ふるい'], othersCount: 0, people: 1, multi: false });
  });

  it('名無し(nickname 欠損)でも落ちない', () => {
    const p = followBannerParts({ amount: 10 });
    expect(p.names).toEqual(['']);
    expect(p.multi).toBe(false);
  });
});
