import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type ConfirmOptions = {
  /** ヘッダの一行。「〜しますか？」の疑問形にする。 */
  title: string;
  /** 何が起きるかの本文。配信中に一目で読み切れる長さに収める。 */
  message: string;
  /** 「元に戻せません」などの補足。無ければ出さない。 */
  detail?: string;
  /** 実行ボタンの文言。既定は「実行する」。 */
  confirmLabel?: string;
  /** 取り返しの付かない操作なら赤くする。 */
  danger?: boolean;
};

/**
 * 確認ダイアログ本体。
 *
 * body 直下へポータルで出す。`.challenge-card.stuck` は position:sticky + z-index:3 で
 * スタッキングコンテキストを作るので、その中に置くと `.modal-bg` の z-index:40 が
 * カードの中でしか効かず、トップバーなどの下に潜る。
 *
 * 初期フォーカスはキャンセル側 — PUSH を連打している勢いのまま Enter/Space を
 * 叩いても実行されないようにするため(ネイティブの confirmDestructive も同じ既定)。
 */
function ConfirmDialog({
  opts,
  onConfirm,
  onCancel,
}: {
  opts: ConfirmOptions;
  onConfirm: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      // 他画面(ビューア詳細やメモ)の Escape ハンドラより先に取り、そこで止める。
      e.stopPropagation();
      onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  return createPortal(
    <div className="modal-bg" onClick={onCancel}>
      <div
        className="modal confirm"
        role="alertdialog"
        aria-modal="true"
        aria-label={opts.title}
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <strong>{opts.title}</strong>
        </header>
        <div className="body">
          <p>{opts.message}</p>
          {opts.detail ? <p className="faint">{opts.detail}</p> : null}
          <div className="row confirm-actions">
            <button className="btn" ref={cancelRef} onClick={onCancel}>
              キャンセル
            </button>
            <button className={`btn ${opts.danger ? 'danger' : 'primary'}`} onClick={onConfirm}>
              {opts.confirmLabel ?? '実行する'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * `window.confirm` と同じ使い勝手(await して bool)でアプリ内モーダルを出すフック。
 *
 *   const [confirmNode, confirm] = useConfirm();
 *   if (!(await confirm({ title: '…', message: '…' }))) return;
 *   …
 *   return (<>{confirmNode}…</>);
 *
 * resolve 関数を state ではなく ref に持つのが要点 — state 更新関数の中で resolve を
 * 呼ぶと、React が更新関数を二度実行する場面(StrictMode)で副作用が二重に走る。
 */
export function useConfirm(): [React.JSX.Element | null, (o: ConfirmOptions) => Promise<boolean>] {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const settle = useCallback((ok: boolean) => {
    const r = resolver.current;
    resolver.current = null;
    setOpts(null);
    r?.(ok);
  }, []);

  const confirm = useCallback((o: ConfirmOptions): Promise<boolean> => {
    // 前の確認が残っていたらキャンセル扱いで畳む(呼び出し元を待たせ続けない)。
    resolver.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setOpts(o);
    });
  }, []);

  // アンマウント時も待っている呼び出し元を必ず解放する。
  useEffect(
    () => () => {
      resolver.current?.(false);
      resolver.current = null;
    },
    [],
  );

  const node = opts ? (
    <ConfirmDialog opts={opts} onConfirm={() => settle(true)} onCancel={() => settle(false)} />
  ) : null;
  return [node, confirm];
}
