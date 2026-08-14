import { describe, expect, it } from 'vitest';
import {
  DASH_TRACK,
  DEFAULT_DASH_LAYOUT,
  dashTemplate,
  moveDashPane,
  normalizeDashLayout,
  type DashPaneKey,
} from '@shared/dash-layout';

describe('normalizeDashLayout', () => {
  it('未設定・壊れた値でも必ず3枚そろった並びを返す', () => {
    for (const raw of [undefined, null, {}, 'comments', [], 42, [null, 7]]) {
      expect(normalizeDashLayout(raw)).toEqual([...DEFAULT_DASH_LAYOUT]);
    }
  });

  it('保存された並びはそのまま通す', () => {
    expect(normalizeDashLayout(['summary', 'comments', 'viewers'])).toEqual(['summary', 'comments', 'viewers']);
  });

  it('重複と未知のキーを落とし、欠けたパネルを既定順で補う', () => {
    // 手編集で viewers を2度書いた settings.json。パネルが消える方が壊れ方として重い。
    expect(normalizeDashLayout(['viewers', 'viewers', 'chat'])).toEqual(['viewers', 'comments', 'summary']);
    expect(normalizeDashLayout(['summary'])).toEqual(['summary', 'comments', 'viewers']);
  });

  it('入力配列を書き換えない', () => {
    const raw = ['summary', 'comments'];
    normalizeDashLayout(raw);
    expect(raw).toEqual(['summary', 'comments']);
  });
});

describe('moveDashPane', () => {
  const base = (): DashPaneKey[] => ['comments', 'viewers', 'summary'];

  it('後ろのパネルを前へ入れる', () => {
    expect(moveDashPane(base(), 'summary', 'comments')).toEqual(['summary', 'comments', 'viewers']);
  });

  it('前のパネルを後ろへ入れる', () => {
    expect(moveDashPane(base(), 'comments', 'summary')).toEqual(['viewers', 'summary', 'comments']);
  });

  it('隣へ動かすと入れ替わる', () => {
    expect(moveDashPane(base(), 'viewers', 'comments')).toEqual(['viewers', 'comments', 'summary']);
  });

  it('自分自身へのドロップは元の配列をそのまま返す（保存しないため参照で判定する）', () => {
    const order = base();
    expect(moveDashPane(order, 'viewers', 'viewers')).toBe(order);
  });

  it('並びに無いキーは無視する', () => {
    const order: DashPaneKey[] = ['comments', 'viewers'];
    expect(moveDashPane(order, 'summary', 'comments')).toBe(order);
  });
});

describe('dashTemplate', () => {
  it('既定順は従来の .dash と同じトラックになる', () => {
    expect(dashTemplate(DEFAULT_DASH_LAYOUT)).toBe('minmax(320px, 1fr) minmax(500px, 1.7fr) 310px');
  });

  it('幅は位置ではなくパネルに付いてくる', () => {
    // サマリーは左端へ動かしても 310px のまま — 中身が 310px 前提で組まれている。
    expect(dashTemplate(['summary', 'comments', 'viewers'])).toBe(
      `${DASH_TRACK.summary} ${DASH_TRACK.comments} ${DASH_TRACK.viewers}`
    );
  });
});
