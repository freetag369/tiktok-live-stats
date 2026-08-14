/**
 * モニター演出用の canvas 2D パーティクルエンジン(零依存・React 非依存)。
 *
 * CSS では出せない加算合成(globalCompositeOperation:'lighter')の光・花火・
 * 吸い込みを担当する。フラッシュ/シェイク/テキストフロートは従来どおり CSS 側。
 *
 * 設計上の約束:
 * - 座標は全てステージ座標(540×960 / 1280×720)。裏解像度への変換は
 *   setTransform で一括して行い、呼び出し側は scale を意識しない。
 * - rAF ループは粒子が居るときだけ回す — 演出が終わればアイドル CPU ゼロ。
 * - 粒子はプール再利用 + MAX_PARTICLES ハードキャップ。ギフト連打では
 *   spawn が黙って間引かれる(recentEffects の上限クリップと同じ思想)。
 * - グローは事前描画スプライトの drawImage で出す。粒子ごとの shadowBlur は
 *   フレーム毎に数百回のガウスぼかしになるため絶対に使わない。
 */

export interface FxPoint {
  x: number;
  y: number;
}

/** DOM 要素のステージ座標系での中心とサイズ。 */
export interface FxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FxEngine {
  attach(canvas: HTMLCanvasElement): void;
  /** ステージ寸法と表示倍率。寸法が変わったら(縦横切替)粒子は全消去。 */
  setViewport(stageW: number, stageH: number, scale: number): void;
  /** DOM 要素の位置をステージ座標へ。シェイク中も canvas と同じ親が動くのでズレない。 */
  pointFor(el: Element | null): FxRect | null;
  /** 拡大するリング波紋(press の手応え)。 */
  ringWave(x: number, y: number, opts?: { hue?: number; radius?: number }): void;
  /** 放射状の火花。 */
  sparkBurst(x: number, y: number, count: number, opts?: { hue?: number; speed?: number; size?: number }): void;
  /** ハートが弾け上がって落ちる。 */
  heartBurst(x: number, y: number, count: number, opts?: { hue?: number; size?: number }): void;
  /** ハートが目標へ吸い込まれる(いいね→ゲージ)。着弾ごとに onArrive。 */
  heartStream(from: FxPoint, to: FxPoint, count: number, onArrive?: () => void): void;
  /** 紙吹雪(旧 DOM confetti の置換)。 */
  confettiRain(count: number, opts?: { gold?: boolean }): void;
  /** 放射光線(大型ギフト・クリア)。 */
  rays(x: number, y: number, opts?: { count?: number; hue?: number }): void;
  /** 花火1発(打ち上げなしの空中炸裂)。 */
  firework(x: number, y: number, opts?: { hue?: number }): void;
  /** 花火の段発(大型ギフト)。タイマーはエンジンが管理し dispose で消える。 */
  fireworkVolley(x: number, y: number, opts?: { count?: number; hue?: number }): void;
  /** ゲージ満タンの複合バースト。 */
  burstGauge(x: number, y: number): void;
  /**
   * ゲージ→7セグへ撃ち込むハートの弾。ms で指定した時間ちょうどで着弾する
   * (呼び出し側が同じ ms のタイマーで数字を切り替える前提の決定論的トゥイーン)。
   * 着弾コールバックは持たない — 縦横切替で粒子が捨てられると呼ばれず、
   * タイミングの権威が二重になるため。演出の同期は呼び出し側が一手に握る。
   */
  strike(from: FxPoint, to: FxPoint, opts?: { ms?: number; hue?: number; size?: number }): void;
  /** クリア時の多段祝祭(内部で段発タイマーを持つ)。 */
  celebrate(): void;
  dispose(): void;
}

const MAX_PARTICLES = 2000;
/** ヒッチ(GC・ウィンドウ移動)後に粒子がテレポートしないよう dt を制限。 */
const MAX_DT = 0.048;

const TAU = Math.PI * 2;

type Shape = 'spark' | 'heart' | 'diamond' | 'rect' | 'ribbon' | 'ring' | 'ray' | 'seek' | 'comet';

interface Particle {
  shape: Shape;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 重力 px/s²。 */
  g: number;
  /** 速度の指数減衰 /s。 */
  drag: number;
  /** 経過秒。負から始めると出現待ち(スタガ)になる。 */
  life: number;
  ttl: number;
  /** 基本サイズ。ray は長さ、ring は最大半径として使う。 */
  size: number;
  /** 補助サイズ。ray の幅、rect の高さ。 */
  size2: number;
  rot: number;
  vr: number;
  /** 色相 0-360。-1 = 白。 */
  hue: number;
  phase: number;
  /** confetti の横揺れ強度 px/s。 */
  wobble: number;
  /** spark のきらめき周波数 rad/s。0 = なし。 */
  twinkle: number;
  tx: number;
  ty: number;
  /** comet のトゥイーン始点。他の形状では使わない。 */
  ox: number;
  oy: number;
  /** seek の吸い込み加速 px/s²。 */
  accel: number;
  onArrive: (() => void) | null;
}

/**
 * 粒子を初期状態に**その場で**戻す。
 *
 * プールの意味は「1粒ごとのオブジェクト生成を避けること」なので、再利用のたびに
 * `Object.assign(p, blankParticle())` と書くと新しいオブジェクトを作って捨てる
 * ぶんだけ目的を打ち消す。t4ギフトの連打は1発で約5,000 spawn 走るため、これが
 * そのまま演出中のGC圧になる(実測: 200万 spawn で 427ms/1.7MB → 18ms/0MB)。
 *
 * フィールド一覧をここ1箇所に集約し、blankParticle はこれに委譲する —
 * Particle に項目を足したとき片方だけ直し忘れる事故を構造的に防ぐため。
 */
function resetParticle(p: Particle): Particle {
  p.shape = 'spark';
  p.x = 0;
  p.y = 0;
  p.vx = 0;
  p.vy = 0;
  p.g = 0;
  p.drag = 0;
  p.life = 0;
  p.ttl = 1;
  p.size = 8;
  p.size2 = 0;
  p.rot = 0;
  p.vr = 0;
  p.hue = -1;
  p.phase = 0;
  p.wobble = 0;
  p.twinkle = 0;
  p.tx = 0;
  p.ty = 0;
  p.ox = 0;
  p.oy = 0;
  p.accel = 0;
  p.onArrive = null;
  return p;
}

/** 新規確保。フィールドの真実は resetParticle 側だけに置く。 */
function blankParticle(): Particle {
  // resetParticle が全項目を必ず代入するので、空オブジェクトからで健全。
  return resetParticle({} as Particle);
}

const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);

// ── 形状/スプライトのキャッシュ(モジュール共有 — エンジン再生成でも作り直さない) ──

let heartPath: Path2D | null = null;
function getHeartPath(): Path2D {
  if (!heartPath) {
    const p = new Path2D();
    p.moveTo(0, 0.4);
    p.bezierCurveTo(-0.55, 0.05, -0.45, -0.45, 0, -0.15);
    p.bezierCurveTo(0.45, -0.45, 0.55, 0.05, 0, 0.4);
    heartPath = p;
  }
  return heartPath;
}

let diamondPath: Path2D | null = null;
function getDiamondPath(): Path2D {
  if (!diamondPath) {
    const p = new Path2D();
    p.moveTo(-0.45, -0.12);
    p.lineTo(-0.22, -0.4);
    p.lineTo(0.22, -0.4);
    p.lineTo(0.45, -0.12);
    p.lineTo(0, 0.45);
    p.closePath();
    diamondPath = p;
  }
  return diamondPath;
}

/** 色相を 30° バケットに量子化してスプライト数を抑える。-1 = 白。 */
function hueBucket(hue: number): number {
  return hue < 0 ? -1 : ((Math.round(hue / 30) * 30) % 360 + 360) % 360;
}

const glowCache = new Map<number, HTMLCanvasElement>();
function glowSprite(hue: number): HTMLCanvasElement {
  const key = hueBucket(hue);
  let c = glowCache.get(key);
  if (!c) {
    c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.25, key < 0 ? 'rgba(255,255,255,0.9)' : `hsla(${key} 100% 72% / 0.9)`);
    grad.addColorStop(1, key < 0 ? 'rgba(255,255,255,0)' : `hsla(${key} 100% 60% / 0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    glowCache.set(key, c);
  }
  return c;
}

const rayCache = new Map<number, HTMLCanvasElement>();
function raySprite(hue: number): HTMLCanvasElement {
  const key = hueBucket(hue);
  let c = rayCache.get(key);
  if (!c) {
    c = document.createElement('canvas');
    c.width = 256;
    c.height = 64;
    const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 256, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0.95)');
    grad.addColorStop(0.3, key < 0 ? 'rgba(255,255,255,0.5)' : `hsla(${key} 100% 72% / 0.55)`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    // 根元が細く先端へ広がる光条(中心から外へ向けて描く前提の台形)。
    g.beginPath();
    g.moveTo(0, 27);
    g.lineTo(256, 6);
    g.lineTo(256, 58);
    g.lineTo(0, 37);
    g.closePath();
    g.fill();
    rayCache.set(key, c);
  }
  return c;
}

export function createFxEngine(): FxEngine {
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let stageW = 540;
  let stageH = 960;
  let raf = 0;
  let lastMs = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const pool: Particle[] = [];
  let alive = 0;

  function spawn(): Particle | null {
    if (!ctx || alive >= MAX_PARTICLES) return null;
    let p = pool[alive];
    if (!p) {
      p = blankParticle();
      pool[alive] = p;
    } else {
      // 使い回し。ここで新しいオブジェクトを作るとプールの意味が消える。
      resetParticle(p);
    }
    alive++;
    ensureLoop();
    return p;
  }

  function kill(i: number): void {
    // swap-remove。順序は描画に影響しない(パスごとに全走査するため)。
    const last = alive - 1;
    const tmp = pool[i]!;
    pool[i] = pool[last]!;
    pool[last] = tmp;
    alive--;
  }

  function ensureLoop(): void {
    if (raf !== 0) return;
    lastMs = performance.now();
    raf = requestAnimationFrame(tick);
  }

  function tick(nowMs: number): void {
    raf = 0;
    if (!ctx || !canvas) return;
    const dt = Math.min((nowMs - lastMs) / 1000, MAX_DT);
    lastMs = nowMs;
    try {
      update(dt);
      render();
    } catch (e) {
      // 例外で再スケジュールが切れると、粒子が静止画のまま画面に貼り付く。
      // 全滅させてキャンバスを拭き、次の spawn の ensureLoop で再開させる。
      alive = 0;
      ctx.clearRect(0, 0, stageW, stageH);
      console.warn('[fx-skip]', 'engine tick でエラー — 粒子を全破棄して停止', e);
      return;
    }
    if (alive > 0) {
      raf = requestAnimationFrame(tick);
    } else {
      // 最終フレームを消してから停止 — 以後 rAF は回らない(アイドル CPU ゼロ)。
      ctx.clearRect(0, 0, stageW, stageH);
    }
  }

  function update(dt: number): void {
    for (let i = alive - 1; i >= 0; i--) {
      const p = pool[i]!;
      p.life += dt;
      if (p.life < 0) continue; // 出現待ち(スタガ)
      if (p.life >= p.ttl) {
        kill(i);
        continue;
      }
      if (p.shape === 'comet') {
        // 時間で位置が決まるトゥイーン。物理ホーミング(seek)だと accel/drag 次第で
        // 到達時刻がブレて、7セグの数字が切り替わる瞬間とフレーム単位で合わせられない。
        // ttl が飛翔時間そのものなので、呼び出し側はタイマーと同じ値を渡せば必ず一致する。
        const t = p.life / p.ttl;
        const bx = p.tx - p.ox;
        const by = p.ty - p.oy;
        const d = Math.hypot(bx, by) || 1;
        // 進行方向の法線へ膨らませて弧を描く — 直線だと機械的に見える。
        // 始点・終点では sin が 0 なので、狙った座標には必ず正確に着弾する。
        const bulge = Math.sin(t * Math.PI) * p.wobble;
        const e = t * t; // イーズイン = 加速して突っ込む
        p.x = p.ox + bx * e - (by / d) * bulge;
        p.y = p.oy + by * e + (bx / d) * bulge;
        p.rot = Math.atan2(by, bx);
        continue;
      }
      if (p.shape === 'seek') {
        // 目標へのホーミング。減衰を強めにして終端で行き過ぎない。
        const dx = p.tx - p.x;
        const dy = p.ty - p.y;
        const d = Math.hypot(dx, dy);
        if (d < 26) {
          p.onArrive?.();
          kill(i);
          continue;
        }
        p.vx += (dx / d) * p.accel * dt;
        p.vy += (dy / d) * p.accel * dt;
      }
      const k = Math.exp(-p.drag * dt);
      p.vx *= k;
      p.vy = p.vy * k + p.g * dt;
      const wobbleVx = p.wobble > 0 ? Math.sin(p.phase + p.life * 4) * p.wobble : 0;
      p.x += (p.vx + wobbleVx) * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      // 画面下へ抜けた紙吹雪は ttl を待たず回収する。
      if (p.y > stageH + 80) kill(i);
    }
  }

  /** 残り寿命 30% でフェードアウトする既定エンベロープ。 */
  function fadeAlpha(p: Particle): number {
    const frac = p.life / p.ttl;
    return frac > 0.7 ? (1 - frac) / 0.3 : 1;
  }

  function render(): void {
    const g = ctx!;
    g.clearRect(0, 0, stageW, stageH);

    // パス1: 通常合成(紙吹雪・ハート・ダイヤ)。
    g.globalCompositeOperation = 'source-over';
    for (let i = 0; i < alive; i++) {
      const p = pool[i]!;
      if (p.life < 0) continue;
      const a = fadeAlpha(p);
      if (p.shape === 'rect' || p.shape === 'ribbon') {
        g.globalAlpha = a;
        g.fillStyle = `hsl(${p.hue} 90% 62%)`;
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.rot);
        // scaleX の揺れでひらひらの見かけの厚み変化を出す(3D 回転の代用)。
        g.scale(Math.abs(Math.sin(p.phase + p.life * 5)) * 0.7 + 0.3, 1);
        g.fillRect(-p.size / 2, -p.size2 / 2, p.size, p.size2);
        g.restore();
      } else if (p.shape === 'heart' || p.shape === 'diamond') {
        g.globalAlpha = a;
        g.fillStyle = p.hue < 0 ? '#fff' : `hsl(${p.hue} 95% 66%)`;
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.rot);
        g.scale(p.size, p.size);
        g.fill(p.shape === 'heart' ? getHeartPath() : getDiamondPath());
        g.restore();
      }
    }

    // パス2: 加算合成(光り物)— 豪華さの主成分。
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < alive; i++) {
      const p = pool[i]!;
      if (p.life < 0) continue;
      let a = fadeAlpha(p);
      if (p.shape === 'spark') {
        if (p.twinkle > 0) a *= 0.7 + 0.3 * Math.sin(p.phase + p.life * p.twinkle);
        g.globalAlpha = Math.max(0, a);
        const s = p.size;
        g.drawImage(glowSprite(p.hue), p.x - s / 2, p.y - s / 2, s, s);
      } else if (p.shape === 'seek') {
        g.globalAlpha = a;
        const s = p.size * 2.2;
        g.drawImage(glowSprite(p.hue), p.x - s / 2, p.y - s / 2, s, s);
        g.fillStyle = '#fff';
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.rot);
        g.scale(p.size * 0.8, p.size * 0.8);
        g.fill(getHeartPath());
        g.restore();
      } else if (p.shape === 'comet') {
        const frac = p.life / p.ttl;
        // 着弾の瞬間まで減光しない — 全速のまま数字へ消える(fadeAlpha は使わない)。
        const ca = frac < 0.12 ? frac / 0.12 : 1;
        g.globalAlpha = ca;
        // 尾: raySprite は原点から +X へ広がる台形なので、進行方向の逆へ向ける。
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.rot + Math.PI);
        g.drawImage(raySprite(p.hue), 0, -p.size2 / 2, p.size * (2.4 + frac * 2.6), p.size2);
        g.restore();
        // 頭: グロー + 白いハート(傾けない — 回すと形が読めなくなる)。
        const hs = p.size * 2.6;
        g.drawImage(glowSprite(p.hue), p.x - hs / 2, p.y - hs / 2, hs, hs);
        g.fillStyle = '#fff';
        g.save();
        g.translate(p.x, p.y);
        g.scale(p.size, p.size);
        g.fill(getHeartPath());
        g.restore();
      } else if (p.shape === 'ring') {
        const frac = p.life / p.ttl;
        g.globalAlpha = (1 - frac) * 0.9;
        g.strokeStyle = p.hue < 0 ? '#fff' : `hsl(${p.hue} 100% 72%)`;
        g.lineWidth = Math.max(1, p.size2 * (1 - frac));
        g.beginPath();
        g.arc(p.x, p.y, p.size * frac + 6, 0, TAU);
        g.stroke();
      } else if (p.shape === 'ray') {
        // 立ち上がり 15% / 減衰 85%(flash の flashenv と同じ非対称エンベロープ)。
        const frac = p.life / p.ttl;
        g.globalAlpha = (frac < 0.15 ? frac / 0.15 : 1 - (frac - 0.15) / 0.85) * 0.85;
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.rot);
        g.drawImage(raySprite(p.hue), 0, -p.size2 / 2, p.size, p.size2);
        g.restore();
      }
    }
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
  }

  function later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  }

  // ── 公開 API ────────────────────────────────────────────────────────────
  // (burstGauge/celebrate が他メソッドを呼ぶため this ではなく変数経由で合成する)

  const api: FxEngine = {
    attach(el) {
      canvas = el;
      ctx = el.getContext('2d');
    },

    setViewport(w, h, scale) {
      const dimsChanged = w !== stageW || h !== stageH;
      stageW = w;
      stageH = h;
      if (!canvas || !ctx) return;
      // 裏解像度 = ステージ × 表示倍率 × DPR(上限2)。transform:scale の下でも
      // 実ピクセルにシャープに乗る。
      const k = Math.max(0.5, scale) * Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(w * k));
      canvas.height = Math.max(1, Math.round(h * k));
      ctx.setTransform(k, 0, 0, k, 0, 0);
      if (dimsChanged) {
        // 縦横切替 — 旧座標系の粒子は意味を失うので捨てる。
        alive = 0;
        ctx.clearRect(0, 0, stageW, stageH);
      }
    },

    pointFor(el) {
      if (!el || !canvas) return null;
      const cr = canvas.getBoundingClientRect();
      if (cr.width <= 0) return null;
      const er = el.getBoundingClientRect();
      const f = cr.width / stageW; // 表示px → ステージpx
      return {
        x: (er.left + er.width / 2 - cr.left) / f,
        y: (er.top + er.height / 2 - cr.top) / f,
        w: er.width / f,
        h: er.height / f,
      };
    },

    ringWave(x, y, opts) {
      const p = spawn();
      if (!p) return;
      p.shape = 'ring';
      p.x = x;
      p.y = y;
      p.hue = opts?.hue ?? -1;
      p.size = opts?.radius ?? 150;
      p.size2 = 10;
      p.ttl = 0.45;
    },

    sparkBurst(x, y, count, opts) {
      const speed = opts?.speed ?? 520;
      for (let i = 0; i < count; i++) {
        const p = spawn();
        if (!p) return;
        p.shape = 'spark';
        p.x = x;
        p.y = y;
        const ang = Math.random() * TAU;
        const v = rand(0.25, 1) * speed;
        p.vx = Math.cos(ang) * v;
        p.vy = Math.sin(ang) * v - speed * 0.15;
        p.g = 700;
        p.drag = 2.4;
        p.ttl = rand(0.5, 0.95);
        p.size = rand(10, 26) * (opts?.size ?? 1);
        p.hue = opts?.hue ?? -1;
        p.twinkle = 22;
        p.phase = Math.random() * TAU;
      }
    },

    heartBurst(x, y, count, opts) {
      for (let i = 0; i < count; i++) {
        const p = spawn();
        if (!p) return;
        p.shape = 'heart';
        p.x = x + rand(-30, 30);
        p.y = y;
        p.vx = rand(-190, 190);
        p.vy = rand(-460, -180);
        p.g = 620;
        p.drag = 1.1;
        p.ttl = rand(1.1, 1.7);
        p.size = rand(14, 30) * (opts?.size ?? 1);
        p.hue = opts?.hue ?? 338;
        p.rot = rand(-0.5, 0.5);
        p.vr = rand(-2.4, 2.4);
      }
    },

    heartStream(from, to, count, onArrive) {
      for (let i = 0; i < count; i++) {
        const p = spawn();
        if (!p) return;
        p.shape = 'seek';
        p.x = from.x + rand(-46, 46);
        p.y = from.y + rand(-26, 26);
        // 最初は外向きに散ってから吸い込まれる — 直線移動より「集まる」感が出る。
        const ang = Math.random() * TAU;
        const v = rand(120, 320);
        p.vx = Math.cos(ang) * v;
        p.vy = Math.sin(ang) * v;
        p.drag = 2.6;
        p.accel = 2600;
        p.tx = to.x + rand(-8, 8);
        p.ty = to.y + rand(-6, 6);
        p.ttl = 2.2; // 安全弁 — 通常は着弾で消える
        p.life = -i * 0.05; // スタガ出現
        p.size = rand(12, 20);
        p.hue = 338;
        p.rot = rand(-0.4, 0.4);
        p.onArrive = onArrive ?? null;
      }
    },

    confettiRain(count, opts) {
      for (let i = 0; i < count; i++) {
        const p = spawn();
        if (!p) return;
        const ribbon = Math.random() < 0.18;
        p.shape = ribbon ? 'ribbon' : 'rect';
        p.x = rand(-20, stageW + 20);
        p.y = rand(-120, -20);
        p.vx = rand(-40, 40);
        p.vy = rand(180, 300);
        p.g = 240;
        p.drag = 0.9; // 終端速度に落ち着く
        p.ttl = rand(2.6, 4.2);
        p.life = -rand(0, 0.6); // 出現をばらして「降り続く」見た目に
        p.size = ribbon ? rand(7, 10) : rand(8, 16);
        p.size2 = ribbon ? rand(26, 42) : rand(10, 18);
        p.hue = opts?.gold ? rand(38, 55) : rand(0, 360);
        p.rot = rand(0, TAU);
        p.vr = rand(-6, 6);
        p.wobble = rand(30, 90);
        p.phase = Math.random() * TAU;
      }
    },

    rays(x, y, opts) {
      const count = opts?.count ?? 10;
      const base = Math.random() * TAU;
      for (let i = 0; i < count; i++) {
        const p = spawn();
        if (!p) return;
        p.shape = 'ray';
        p.x = x;
        p.y = y;
        p.rot = base + (i / count) * TAU + rand(-0.12, 0.12);
        p.vr = rand(-0.22, 0.22);
        p.ttl = rand(0.7, 1.05);
        p.size = rand(300, 520); // 長さ
        p.size2 = rand(36, 64); // 幅
        p.hue = opts?.hue ?? 45;
      }
    },

    firework(x, y, opts) {
      const hue = opts?.hue ?? 45;
      // 中心の閃光。
      const flash = spawn();
      if (flash) {
        flash.shape = 'spark';
        flash.x = x;
        flash.y = y;
        flash.ttl = 0.22;
        flash.size = 170;
        flash.hue = -1;
      }
      const ring = spawn();
      if (ring) {
        ring.shape = 'ring';
        ring.x = x;
        ring.y = y;
        ring.hue = hue;
        ring.size = 210;
        ring.size2 = 8;
        ring.ttl = 0.5;
      }
      // 炸裂片は2色相(本体色 + 白)を混ぜると安っぽくならない。
      for (let i = 0; i < 78; i++) {
        const p = spawn();
        if (!p) return;
        p.shape = 'spark';
        p.x = x;
        p.y = y;
        const ang = Math.random() * TAU;
        const v = rand(0.35, 1) * 640;
        p.vx = Math.cos(ang) * v;
        p.vy = Math.sin(ang) * v;
        p.g = 460;
        p.drag = 1.5;
        p.ttl = rand(0.8, 1.5);
        p.size = rand(8, 22);
        p.hue = Math.random() < 0.25 ? -1 : hue + rand(-12, 12);
        p.twinkle = 26;
        p.phase = Math.random() * TAU;
      }
    },

    fireworkVolley(x, y, opts) {
      const n = opts?.count ?? 3;
      const hue = opts?.hue ?? 45;
      for (let i = 0; i < n; i++) {
        const dx = i === 0 ? 0 : rand(-stageW * 0.28, stageW * 0.28);
        const dy = i === 0 ? 0 : rand(-90, 60);
        if (i === 0) api.firework(x, y, { hue });
        else later(280 * i, () => api.firework(x + dx, y + dy, { hue: hue + rand(-8, 8) }));
      }
    },

    strike(from, to, opts) {
      const hue = opts?.hue ?? 332;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const p = spawn();
      if (p) {
        p.shape = 'comet';
        p.ox = from.x;
        p.oy = from.y;
        p.x = from.x;
        p.y = from.y;
        p.tx = to.x;
        p.ty = to.y;
        p.ttl = Math.max(0.08, (opts?.ms ?? 300) / 1000);
        p.size = opts?.size ?? 26;
        p.size2 = 46; // 尾の幅
        p.hue = hue;
        p.wobble = Math.hypot(dx, dy) * 0.12; // 弧の膨らみ(comet では横揺れに使わない)
      }
      // 発射の反動 — 弾が出ていった勢いをゲージ側に残す。
      const ang = Math.atan2(dy, dx);
      for (let i = 0; i < 8; i++) {
        const s = spawn();
        if (!s) break;
        s.shape = 'spark';
        s.x = from.x;
        s.y = from.y;
        const a = ang + rand(-0.9, 0.9);
        const v = rand(160, 420);
        s.vx = Math.cos(a) * v;
        s.vy = Math.sin(a) * v;
        s.drag = 3.2;
        s.ttl = rand(0.25, 0.5);
        s.size = rand(10, 22);
        s.hue = hue;
        s.twinkle = 18;
        s.phase = Math.random() * TAU;
      }
    },

    burstGauge(x, y) {
      api.ringWave(x, y, { hue: 330, radius: 190 });
      api.sparkBurst(x, y, 30, { hue: 330, speed: 620 });
      api.heartBurst(x, y - 10, 10, { hue: 335 });
    },

    celebrate() {
      const cx = stageW / 2;
      api.rays(cx, stageH * 0.34, { count: 12, hue: 45 });
      api.firework(cx, stageH * 0.3, { hue: 45 });
      api.confettiRain(160, { gold: true });
      later(400, () => {
        api.firework(stageW * 0.24, stageH * 0.42, { hue: 40 });
        api.firework(stageW * 0.76, stageH * 0.4, { hue: 50 });
      });
      later(900, () => {
        api.firework(cx, stageH * 0.22, { hue: 45 });
        api.rays(cx, stageH * 0.3, { count: 10, hue: 45 });
        api.confettiRain(140, { gold: false });
      });
    },

    dispose() {
      if (raf !== 0) cancelAnimationFrame(raf);
      raf = 0;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      alive = 0;
      if (ctx) ctx.clearRect(0, 0, stageW, stageH);
      canvas = null;
      ctx = null;
    },
  };
  return api;
}
