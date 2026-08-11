import { rpc, useQuery } from '../ipc/client';
import { toast } from '../state/uiStore';

/**
 * AGPL-3.0 §6 conveyance surface. The binary is built from AGPL-licensed source,
 * so anyone who receives the app must be able to identify and obtain the exact
 * source it was built from — hence the commit SHA and the archive button.
 */
export function Licenses(): React.JSX.Element {
  const { data } = useQuery('app.licenses', undefined, []);
  const { data: diag } = useQuery('q.diagnostics', undefined, []);

  return (
    <div className="screen">
      <h2>ライセンスとソースコード</h2>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', alignItems: 'start' }}>
        <div className="card">
          <h3>このアプリのライセンス</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            このアプリは <b>GNU Affero General Public License v3.0 (AGPL-3.0)</b> で配布されています。
            TikTok への接続に AGPL のライブラリを使用しているため、アプリ全体が同じライセンスになります。
          </p>
          <ul className="muted" style={{ fontSize: 12, paddingLeft: 18 }}>
            <li>自由に使用・改変・再配布できます。</li>
            <li>
              <b>他の人にこのアプリを渡すときは、同じ AGPL-3.0 の条件で渡し、対応するソースコードも入手できるようにする必要があります。</b>
            </li>
            <li>下の「ソースコードを保存」で、この実行ファイルの元になったソース一式を書き出せます。</li>
          </ul>
          <div className="row wrap" style={{ marginTop: 10 }}>
            <button
              className="btn"
              onClick={() =>
                void rpc('file.saveSource', undefined)
                  .then((r) => r && toast({ level: 'info', msgJa: 'ソースコードを保存しました。' }))
                  .catch((e: Error) => toast({ level: 'error', msgJa: e.message }))
              }
            >
              ソースコードを保存
            </button>
          </div>
          {diag ? (
            <div className="faint" style={{ fontSize: 11, marginTop: 10, fontFamily: 'var(--mono)' }}>
              version {diag.appVersion} · commit {diag.gitSha} · built {diag.buildTime}
            </div>
          ) : null}
        </div>

        <div className="card">
          <h3>ソースコードの入手方法</h3>
          {data?.sourceOffer ? (
            <pre className="doc">{data.sourceOffer}</pre>
          ) : (
            <div className="empty">SOURCE-OFFER.txt が同梱されていません。</div>
          )}
        </div>

        <div className="card">
          <h3>使用しているソフトウェア</h3>
          {data?.thirdParty ? (
            <pre className="doc">{data.thirdParty}</pre>
          ) : (
            <div className="empty">THIRD-PARTY-NOTICES.md が同梱されていません。</div>
          )}
        </div>

        <div className="card">
          <h3>AGPL-3.0 全文</h3>
          {data?.license ? <pre className="doc">{data.license}</pre> : <div className="empty">LICENSE が同梱されていません。</div>}
        </div>
      </div>
    </div>
  );
}
