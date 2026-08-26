import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 「フィーバーのギフトが着弾してから起動カットインが鳴り出すまで、アプリの音が
 * 全部消える(実測 2.7〜3.1 秒)」の再発防止(ソース不変条件)。
 *
 * 症状の作られ方は独立した2つの正しい仕組みの非同期:
 * (A) worker は**アーム時点**(ギフト着弾の瞬間・タップ窓はまだ開いていない)で
 *     fxFreezeUntilMs を張る。凍結中は press も gift も effect を積まないので、
 *     この瞬間からアプリの SE が全部止まる。
 * (B) モニターは boost-start を pendingBoosts へ持ち越し、舞台が空くまで待つ。
 *     待ちの実体は finishBandFx が出す**無音の**ギフトカードバナー(2200ms)+
 *     STAGE_GAP_CUTIN_MS(500ms)。
 * その間ブースト自身は音を1つも出さない(起動カットインの音声は mp4 に焼かれて
 * いるので、動画が始まるまで鳴らない)。
 *
 * ここで固定するのは (B) を潰す2点と、同じ症状を別経路で作る回転音の即断:
 *  1. pushFloat の高速路が待機中のブーストを追い越さない
 *  2. ブーストギフトの着弾音(トリガーギフトは gift の effect を出さないので、
 *     useChallengeSe が鳴らさないと構造的に無音)
 *  3. ルーレット回転音は boost への引き継ぎでフェードする(即断しない)
 *
 * レンダラのテスト環境がこのリポジトリに無い(vitest は node 環境のみ)ための
 * 機械的な担保。fx-video-pool.spec.ts / fx-hold-safety.spec.ts と同型。
 * **CRLF 正規化を必ず通すこと** — MonitorView.tsx / useChallengeSe.ts は CRLF で、
 * Windows CI のチェックアウトでも読み口が変わらないようにする。
 */

const MONITOR = readFileSync(resolve('src/renderer/monitor/MonitorView.tsx'), 'utf8').replace(
  /\r\n/g,
  '\n'
);
const SE_HOOK = readFileSync(resolve('src/renderer/lib/useChallengeSe.ts'), 'utf8').replace(
  /\r\n/g,
  '\n'
);

/** コンポーネント直下(2スペースインデント)の関数本文を切り出す。 */
function fnBody(src: string, name: string): string {
  const m = src.match(new RegExp(`function ${name}\\([\\s\\S]*?\\r?\\n {2}\\}`));
  expect(m, `${name} が見つからない`).toBeTruthy();
  return m![0];
}

describe('フィーバー着弾〜起動カットインの無音(ソース不変条件)', () => {
  describe('pushFloat の高速路は待機中のブーストを追い越さない', () => {
    // 2026-08-26: 判定の本体は bannerWillShowNow へ切り出した(ダイヤ増減の浮上が
    // 「押した瞬間に出る」ことを前提に据え置きを張るため、同じ判定を共有する必要が
    // ある)。**条件が二重管理になるとモニターが全死する**ので、ここでは
    // 「本体に判定がある」と「pushFloat がそれを通す」の両方を固定する。
    const body = fnBody(MONITOR, 'bannerWillShowNow');
    const push = fnBody(MONITOR, 'pushFloat');

    it('pendingBoosts と boost ランクで追い越し判定を作っている', () => {
      // pumpStage は pickStageNext でランク比較するのに、この高速路だけが
      // 素通しで舞台を奪っていた = 2.7 秒の無音の本体。
      expect(body).toContain('pendingBoosts.current.length > 0');
      expect(body).toContain("fxRank('boost')");
      // 同ランクは drain 勝ち(bannerWinsByRank のタイブレーク)なので >= で見る。
      expect(body).toMatch(/bannerRank\(kind\) >= fxRank\('boost'\)/);
    });

    it('その判定が戻り値の合議に入っている(宣言だけで未使用にならない)', () => {
      expect(body).toContain('!boostOutranks');
      const declAt = body.indexOf('const boostOutranks');
      const useAt = body.indexOf('!boostOutranks');
      expect(declAt, 'boostOutranks の宣言が無い').toBeGreaterThanOrEqual(0);
      expect(declAt, 'boostOutranks は使用より前で決めること').toBeLessThan(useAt);
      // 順番待ちが居る / カットイン中 / 間合い中は即時表示しない、も同じ合議の中。
      expect(body).toContain('bannerQueue.current.length === 0');
      expect(body).toContain('!anyCutinHold()');
      expect(body).toContain("stageWaitFor('banner', now) === 0");
    });

    it('pushFloat は自前で判定を持たず bannerWillShowNow を通す(二重管理の禁止)', () => {
      expect(push).toContain('bannerWillShowNow(kind, now)');
      // 高速路の条件を pushFloat 側へコピーし直したら落とす。
      expect(push).not.toContain('boostOutranks');
    });

    it('immediate の権利は据え置き(確定バナーの即時表示を壊さない)', () => {
      // ルーレット確定バナーは immediate:true で舞台を奪ってよい契約のまま。
      expect(push).toContain('opts?.immediate === true || bannerWillShowNow(kind, now)');
    });
  });

  describe('worker の予告(fxQueue)に居るフィーバーへ道を空ける', () => {
    const pump = fnBody(MONITOR, 'pumpStage');
    const hold = fnBody(MONITOR, 'holdForInboundBoost');

    it('予告の boost と④のランクで待避を決める', () => {
      // pendingBoosts はまだ空(boost は worker の pendingOps に居る)なので、
      // worker の予告を見るしかない。
      expect(hold).toContain("fxQueueRef.current.some((x) => x.kind === 'boost')");
      expect(hold).toMatch(/best >= fxRank\('boost'\)/);
    });

    it('上限は絶対時刻ラッチ(固着しない)', () => {
      expect(hold).toContain('boostInboundHoldUntil.current');
      expect(hold).toContain('BOOST_INBOUND_HOLD_MS');
      // 予告が消えたら必ず解放する。
      expect(hold).toMatch(/if \(!inbound\)[\s\S]*?boostInboundHoldUntil\.current = 0;/);
    });

    it('【踏んだ罠】呼ぶのは takeNextBanner の直前だけで、pick には紐づけない', () => {
      // finishBandFx は giftImpactVisuals の**後**に scheduleDrain() するので、
      // その周回の pick は 'drain' になり、空振りしたあとバナーへフォールスルーする。
      // pick === 'banner' の枝に置くとこの経路がまるごと素通りする(実測 2724ms)。
      const holdAt = pump.indexOf('holdForInboundBoost(now, q)');
      const takeAt = pump.indexOf('takeNextBanner(q');
      expect(holdAt, 'pumpStage が holdForInboundBoost を呼んでいない').toBeGreaterThanOrEqual(0);
      expect(takeAt, 'takeNextBanner が見つからない').toBeGreaterThanOrEqual(0);
      expect(holdAt, '待避は takeNextBanner の直前で見ること').toBeLessThan(takeAt);
      // 呼び出しは1箇所だけ(pick 別に増やすと片方が必ず腐る)。
      expect(pump.split('holdForInboundBoost(').length - 1).toBe(1);
      // pick に紐づけていないことの直接固定。
      expect(pump).not.toMatch(/pick === 'banner'[\s\S]{0,120}holdForInboundBoost/);
    });
  });

  describe('ブーストギフトの着弾音', () => {
    // case 'boost-start' 〜 case 'boost-end' の間だけを見る。
    const slice = SE_HOOK.slice(
      SE_HOOK.indexOf("case 'boost-start':"),
      SE_HOOK.indexOf("case 'boost-end':")
    );

    it('スライスが取れている', () => {
      expect(SE_HOOK).toContain("case 'boost-start':");
      expect(slice.length).toBeGreaterThan(0);
    });

    it('無音(null)ではなくギフトのティアスロットを返す', () => {
      // worker の giftOp は matchTapBoost 一致で return するので gift の effect が
      // 出ない = ここを null に戻すと着弾が構造的に無音へ戻る。
      expect(slice).toContain('tierForDiamonds(e.diamonds ?? 0)');
      expect(slice).not.toMatch(/return null;/);
    });

    it("タップ開始の合図('boost-start' スロット)は流用しない", () => {
      // 合図が2回鳴って「今から押していい」の意味が壊れるため。
      // (スライス冒頭の case ラベル自体は 'boost-start' なので、**返り値**を見る。)
      expect(slice).not.toMatch(/return\s+'boost-start'/);
    });
  });

  describe('ルーレット回転音の引き継ぎ', () => {
    const body = fnBody(MONITOR, 'decideRouletteBgm');

    it('boost へ引き継ぐときは即断せずフェードする', () => {
      // フィーバーは BGM を持たず音は起動カットインの mp4 に焼かれているので、
      // 即断すると実際の再生開始までが音の崖になる。
      expect(body).toMatch(/nextKind === 'boost'[\s\S]*?stopRouletteSound\(400\)/);
    });

    it('即断は band だけに残す(自前の BGM と重ねないため)', () => {
      const hardCut = body.slice(body.indexOf('stopRouletteSound(0)'));
      expect(body).toContain('stopRouletteSound(0)');
      expect(body).toMatch(/nextKind === 'band'\) \{\n\s*stopRouletteSound\(0\)/);
      // 即断枝に boost が居ないこと。
      expect(hardCut).not.toContain("'boost'");
    });
  });
});
