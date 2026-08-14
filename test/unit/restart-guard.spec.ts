import { describe, expect, it } from 'vitest';
import { AUTO_RECOVER_MAX, AUTO_RECOVER_WINDOW_MS, decideAutoRecover } from '@shared/restart-guard';

const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);
const MIN = 60_000;

describe('decideAutoRecover — モニター自動復旧のループガード', () => {
  it('履歴が空なら許可し、履歴に積む', () => {
    const d = decideAutoRecover([], NOW);
    expect(d.allow).toBe(true);
    expect(d.history).toEqual([NOW]);
    expect(d.retryAfterMs).toBe(0);
  });

  it('窓内 3回までは許可、4回目は拒否する', () => {
    let history: number[] = [];
    for (let i = 0; i < AUTO_RECOVER_MAX; i++) {
      const d = decideAutoRecover(history, NOW + i * MIN);
      expect(d.allow, `attempt ${i + 1}`).toBe(true);
      history = d.history;
    }
    expect(history).toHaveLength(AUTO_RECOVER_MAX);
    const d4 = decideAutoRecover(history, NOW + 3 * MIN);
    expect(d4.allow).toBe(false);
    expect(d4.retryAfterMs).toBeGreaterThan(0);
  });

  it('拒否は履歴に積まない — 積むと窓が後ろへずれて永久に復旧できなくなる', () => {
    const history = [NOW, NOW + MIN, NOW + 2 * MIN];
    const a = decideAutoRecover(history, NOW + 3 * MIN);
    expect(a.allow).toBe(false);
    expect(a.history).toEqual(history);
    const b = decideAutoRecover(a.history, NOW + 4 * MIN);
    expect(b.history).toEqual(history);
    // 最古が窓から出れば復活する(拒否で窓がずれていない証拠)。
    const c = decideAutoRecover(b.history, NOW + AUTO_RECOVER_WINDOW_MS + 1);
    expect(c.allow).toBe(true);
  });

  it('窓から出た履歴は捨てる', () => {
    const old = [NOW, NOW + MIN, NOW + 2 * MIN];
    const d = decideAutoRecover(old, NOW + AUTO_RECOVER_WINDOW_MS + 5 * MIN);
    expect(d.allow).toBe(true);
    expect(d.history).toEqual([NOW + AUTO_RECOVER_WINDOW_MS + 5 * MIN]);
  });

  it('retryAfterMs は最古の履歴が窓から出るまでの残り', () => {
    const history = [NOW, NOW + MIN, NOW + 2 * MIN];
    const d = decideAutoRecover(history, NOW + 3 * MIN);
    // 最古 = NOW。窓は NOW + WINDOW で明ける。
    expect(d.retryAfterMs).toBe(AUTO_RECOVER_WINDOW_MS - 3 * MIN);
  });

  it('手動リセット相当(履歴を空で渡す)は即座に許可される', () => {
    const blocked = decideAutoRecover([NOW, NOW + MIN, NOW + 2 * MIN], NOW + 3 * MIN);
    expect(blocked.allow).toBe(false);
    expect(decideAutoRecover([], NOW + 3 * MIN).allow).toBe(true);
  });

  it('時計が巻き戻っても暴走を止め損なわない(未来の記録は窓内として数える)', () => {
    const future = [NOW + 5 * MIN, NOW + 6 * MIN, NOW + 7 * MIN];
    expect(decideAutoRecover(future, NOW).allow).toBe(false);
  });

  it('閾値と窓は上書きできる(テスト・将来の調整用)', () => {
    const d = decideAutoRecover([NOW], NOW + 10, { maxInWindow: 1, windowMs: 1000 });
    expect(d.allow).toBe(false);
    expect(decideAutoRecover([NOW], NOW + 2000, { maxInWindow: 1, windowMs: 1000 }).allow).toBe(true);
  });
});
