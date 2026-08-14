import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * 描画中の例外でツリーごと消えるのを止める。
 *
 * これが無かったので、MonitorView(3000行超の演出状態機械)が1回でも throw すると
 * 配信中に**真っ黒な窓へ無言で落ちて二度と戻らなかった** — ログもトーストも
 * 復旧手段も無い。fx エンジンの tick だけは try/catch されているが、それは
 * canvas のループを守るだけで React の描画は守らない。
 *
 * モニターとダッシュボードで方針が正反対なので、fallback は呼び出し側が渡す:
 * - モニターは配信者の背面に映っている。**赤いエラーカードは黒画面より悪い**
 *   (「機材が止まっている」ではなく「このアプリは壊れている」が数時間映る)。
 *   放送に耐える黒フォールバック + main 側のループガード付き自動復旧。
 * - ダッシュボードは人が見ているので、原因と復旧ボタンを普通に出す。
 *
 * tsconfig.web.json は noImplicitOverride: true なので render/componentDidCatch は
 * override が必須(付け忘れるとビルドで落ちる)。
 */

interface Props {
  children: ReactNode;
  /** 例外時に出す UI。error は表示用、reset はツリーの再マウント。 */
  fallback: (error: Error, reset: () => void) => ReactNode;
  /** 例外の通知先(診断リングへの送信・自動復旧の起動など)。 */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    try {
      this.props.onError?.(error, info);
    } catch {
      // 通知でさらに throw して二重障害にしない。
    }
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (error) return this.props.fallback(error, this.reset);
    return this.props.children;
  }
}
