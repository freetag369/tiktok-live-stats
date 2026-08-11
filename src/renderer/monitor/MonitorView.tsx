import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppSettings, ChallengeEffect } from '@shared/dto';
import { tierForDiamonds } from '@shared/challenge';
import { num } from '@shared/format';
import { rpc, useQuery } from '../ipc/client';
import { liveRows, setChallenge, useLive } from '../state/liveStore';
import { Avatar } from '../components/common';
import { SevenSeg } from './SevenSeg';

/**
 * 背面モニター画面(縦型フルスクリーン想定)。
 *
 * 構成(上から): 現在時刻 / 企画タイトル / 7セグ残数 / バー2本 / 配信時間 /
 * ギフトランキング TOP3。FxLayer が照明フラッシュ・紙吹雪・±N 浮上を重ねる。
 *
 * 演出は ChallengeState.recentEffects(id 単調増加)を watermark 方式で冪等再生
 * する。マウント直後は全 effect を再生済みに倒す — リロード/再接続のたびに過去
 * 演出が一斉再生される事故を防ぐ。
 */

interface FloatItem {
  key: number;
  text: string;
  cls: string;
}
interface FlashItem {
  key: number;
  cls: string;
}
interface ConfettiPiece {
  key: number;
  style: React.CSSProperties;
}

let fxKey = 0;

const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

function clockText(d: Date): { time: string; date: string } {
  const p = (n: number) => String(n).padStart(2, '0');
  return {
    time: `${p(d.getHours())}時${p(d.getMinutes())}分${p(d.getSeconds())}秒`,
    date: `${p(d.getMonth() + 1)}月${p(d.getDate())}日 ${WEEKDAY_JA[d.getDay()]}曜`,
  };
}

function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${Math.floor(s / 3600)}時${p(Math.floor((s % 3600) / 60))}分${p(s % 60)}秒`;
}

export function MonitorView(): React.JSX.Element {
  const { challenge, totals, sessionId, version } = useLive();
  const [cfg, setCfg] = useState<AppSettings | null>(null);
  const [now, setNow] = useState(() => new Date());

  // 演出レイヤの揮発状態(store は汚さない)。
  const lastPlayed = useRef<number | null>(null);
  const [floats, setFloats] = useState<FloatItem[]>([]);
  const [flashes, setFlashes] = useState<FlashItem[]>([]);
  const [shake, setShake] = useState<{ key: number; cls: string } | null>(null);
  const [confetti, setConfetti] = useState<ConfettiPiece[]>([]);

  // 数字パンチ: 値が変わるたびに key を進めてアニメーションを再生する。
  const prevValue = useRef<number | null>(null);
  const [punchKey, setPunchKey] = useState(0);

  useEffect(() => {
    void rpc('cfg.get', undefined).then(setCfg);
    void rpc('challenge.get', undefined).then(setChallenge);
    const t = setInterval(() => setNow(new Date()), 1000);
    // 設定(lowThreshold / loadAvatars 等)は delta に乗らないので定期再取得する。
    const t2 = setInterval(() => void rpc('cfg.get', undefined).then(setCfg), 30_000);
    return () => {
      clearInterval(t);
      clearInterval(t2);
    };
  }, []);

  useEffect(() => {
    if (!challenge) return;
    document.title = challenge.title || 'チャレンジモニター';
    if (prevValue.current !== null && prevValue.current !== challenge.value) {
      setPunchKey((k) => k + 1);
    }
    prevValue.current = challenge.value;
  }, [challenge?.value, challenge?.title]);

  // ── 演出再生(冪等) ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!challenge) return;
    const effects = challenge.recentEffects;
    const maxId = effects.reduce((m, e) => Math.max(m, e.id), 0);
    if (lastPlayed.current === null) {
      lastPlayed.current = maxId;
      return;
    }
    // worker 再起動で effect id が 1 から振り直されると watermark が天井に残り、
    // 以後の演出が全て「再生済み」扱いで死ぬ。巻き戻りを検知したら追従させる
    // (古すぎる演出は下の 5 秒ゲートが落とす)。
    if (lastPlayed.current > maxId) lastPlayed.current = 0;
    const fresh = effects
      .filter((e) => e.id > lastPlayed.current!)
      .sort((a, b) => a.id - b.id);
    for (const e of fresh) {
      lastPlayed.current = Math.max(lastPlayed.current, e.id);
      // 取りこぼしの古い演出は無音でスキップ(復帰直後の演出ストーム防止)。
      if (Date.now() - e.atMs > 5000) continue;
      playEffect(e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [challenge?.recentEffects]);

  function pushFloat(text: string, cls: string): void {
    setFloats((f) => [...f.slice(-7), { key: ++fxKey, text, cls }]);
  }
  function pushFlash(cls: string): void {
    setFlashes((f) => [...f.slice(-3), { key: ++fxKey, cls }]);
  }
  function pushShake(cls: string): void {
    setShake({ key: ++fxKey, cls });
  }
  function pushConfetti(count: number): void {
    const pieces: ConfettiPiece[] = Array.from({ length: count }, () => ({
      key: ++fxKey,
      style: {
        left: `${Math.random() * 100}%`,
        background: `hsl(${Math.floor(Math.random() * 360)} 90% 60%)`,
        width: 6 + Math.random() * 8,
        height: 8 + Math.random() * 10,
        animationDuration: `${1.8 + Math.random() * 1.7}s`,
        animationDelay: `${Math.random() * 0.6}s`,
      },
    }));
    setConfetti((c) => [...c.slice(-250), ...pieces]);
  }

  function playEffect(e: ChallengeEffect): void {
    switch (e.kind) {
      case 'press':
        return; // パンチは値の変化側で再生済み。連打でフラッシュは鬱陶しいので無し。
      case 'follow':
        pushFlash('follow');
        pushShake('shake');
        pushFloat(`+${num(e.amount)} ${e.nickname ?? ''}がフォロー!`, 'bad');
        return;
      case 'gift': {
        const tier = tierForDiamonds(e.diamonds ?? 0);
        // 「照明」= 画面フラッシュ。flash 指定または tier に応じて点灯する。
        pushFlash(e.flash || tier >= 3 ? `gift-t${Math.max(tier, 3)}` : `gift-t${tier}`);
        if (tier >= 2) pushShake(tier >= 4 ? 'shake-strong' : 'shake');
        if (tier >= 3) pushConfetti(tier >= 4 ? 200 : 80);
        const who = e.nickname ? `${e.nickname}: ` : '';
        const gift = e.giftName ?? 'ギフト';
        const sign = e.amount > 0 ? `+${num(e.amount)}` : e.amount < 0 ? `${num(e.amount)}` : '';
        pushFloat(`${sign} ${who}${gift}`, e.amount > 0 ? 'bad' : 'good');
        return;
      }
      case 'achieved':
        pushFlash('clear');
        pushShake('shake-strong');
        pushConfetti(220);
        return;
    }
  }

  // ── ボタン: クリック / Space / Enter。Esc で閉じる ───────────────────────
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.repeat) return;
      if (ev.key === ' ' || ev.key === 'Enter') {
        ev.preventDefault();
        void rpc('challenge.press', undefined).then(setChallenge);
      } else if (ev.key === 'Escape') {
        void rpc('monitor.close', undefined);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ── ギフトランキング: DB がソース、live delta が隙間埋め ─────────────────
  const { data: baseRank } = useQuery(
    'q.viewerTable',
    { sessionId, sort: 'diamondsCurrent', desc: true, filter: 'gifter', limit: 10 },
    [sessionId, Math.floor(version / 60)],
    { skip: sessionId == null }
  );
  const top3 = useMemo(() => {
    const byId = new Map<string, { userId: string; nickname: string; avatarUrl: string | null; diamonds: number }>();
    for (const r of baseRank?.rows ?? []) {
      byId.set(r.userId, { userId: r.userId, nickname: r.nickname, avatarUrl: r.avatarUrl, diamonds: r.diamondsCurrent });
    }
    for (const l of liveRows()) {
      if (l.diamonds <= 0) continue;
      const e = byId.get(l.userId);
      if (e) e.diamonds = Math.max(e.diamonds, l.diamonds);
      else byId.set(l.userId, { userId: l.userId, nickname: l.nickname, avatarUrl: l.avatarUrl, diamonds: l.diamonds });
    }
    return [...byId.values()].sort((a, b) => b.diamonds - a.diamonds).slice(0, 3);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseRank, version]);

  if (!challenge) {
    return <div className="monitor-root idle-hint">読み込み中…</div>;
  }

  const lowThreshold = cfg?.challenge.lowThreshold ?? 10;
  const running = challenge.status === 'running';
  const achieved = challenge.status === 'achieved';
  const remainRatio = challenge.initialValue > 0 ? Math.min(1, challenge.value / challenge.initialValue) : 0;
  const digits = Math.max(4, String(challenge.initialValue).length);
  const clock = clockText(now);
  const showAvatars = cfg?.loadAvatars ?? true;
  const segCls = [
    'countdown',
    achieved ? 'clear' : '',
    running && challenge.value <= lowThreshold ? 'low' : '',
  ].join(' ');

  return (
    <div
      className={`monitor-root${shake ? ` ${shake.cls}` : ''}`}
      data-shake={shake?.key}
      onPointerDown={() => void rpc('challenge.press', undefined).then(setChallenge)}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget) setShake(null);
      }}
    >
      <div className="clock-row">
        現在時刻:{clock.time} {clock.date}
      </div>

      <div className={`title-banner${achieved ? ' clear' : ''}`}>{challenge.title}</div>

      <div className={segCls} key={punchKey}>
        <SevenSeg value={challenge.value} digits={digits} />
        {achieved ? <div className="clear-banner">CLEAR!</div> : null}
        {!running && !achieved ? (
          <div className="idle-note">
            {challenge.startedMs ? '一時停止中' : 'ダッシュボードの「開始」で始まります'}
          </div>
        ) : null}
      </div>

      <div className="bars">
        <div className="mbar pink">
          <i style={{ width: `${remainRatio * 100}%` }} />
          <span className="mbar-label">残り {num(challenge.value)}</span>
        </div>
        <div className="mbar blue">
          <i style={{ width: `${(1 - remainRatio) * 100}%` }} />
          <span className="mbar-label">
            進捗 {num(Math.max(0, challenge.initialValue - challenge.value))} / {num(challenge.initialValue)}
          </span>
        </div>
      </div>

      <div className="elapsed-row">
        配信時間: {totals.elapsedMs > 0 ? elapsedText(totals.elapsedMs) : '—'}
        <span className="stats-inline">
          {' '}
          ボタン{num(challenge.stats.presses)} / 妨害{num(challenge.stats.follows)}
        </span>
      </div>

      <div className="ranking">
        {[0, 1, 2].map((i) => {
          const g = top3[i];
          return (
            <div key={g?.userId ?? `ph-${i}`} className={`rank rank-${i + 1}`}>
              <div className="rank-place">{i + 1}位</div>
              {g ? (
                <>
                  <Avatar url={g.avatarUrl} name={g.nickname} size={56} enabled={showAvatars} />
                  <div className="rank-name">{g.nickname}</div>
                  <div className="rank-dia">{num(g.diamonds)}💎</div>
                </>
              ) : (
                <div className="rank-empty">—</div>
              )}
            </div>
          );
        })}
      </div>

      {/* 演出レイヤ(クリックを拾わない) */}
      <div className="fx-layer">
        {flashes.map((f) => (
          <div
            key={f.key}
            className={`flash ${f.cls}`}
            onAnimationEnd={() => setFlashes((s) => s.filter((x) => x.key !== f.key))}
          />
        ))}
        <div className="floats">
          {floats.map((f) => (
            <div
              key={f.key}
              className={`float ${f.cls}`}
              onAnimationEnd={() => setFloats((s) => s.filter((x) => x.key !== f.key))}
            >
              {f.text}
            </div>
          ))}
        </div>
        {confetti.map((c) => (
          <i
            key={c.key}
            className="confetti"
            style={c.style}
            onAnimationEnd={() => setConfetti((s) => s.filter((x) => x.key !== c.key))}
          />
        ))}
      </div>
    </div>
  );
}
