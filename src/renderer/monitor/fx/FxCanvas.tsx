import { useEffect, useRef } from 'react';
import { createFxEngine, type FxEngine } from './engine';

/**
 * パーティクルエンジンの canvas を .fx-layer 内に張る薄いラッパ。
 *
 * StrictMode の二重マウント(create→dispose→create)に耐えるよう、エンジンの
 * 生成と破棄は必ず同じ effect のペアで行い、ref には生きているエンジンだけを
 * 入れる。viewport 反映は別 effect — 宣言順に走るので attach が先に済む。
 */
export function FxCanvas({
  engineRef,
  stageW,
  stageH,
  scale,
}: {
  engineRef: { current: FxEngine | null };
  stageW: number;
  stageH: number;
  scale: number;
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const engine = createFxEngine();
    if (canvasRef.current) engine.attach(canvasRef.current);
    engineRef.current = engine;
    return () => {
      engineRef.current = null;
      engine.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    engineRef.current?.setViewport(stageW, stageH, scale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageW, stageH, scale]);

  return <canvas ref={canvasRef} className="fx-canvas" aria-hidden="true" />;
}
