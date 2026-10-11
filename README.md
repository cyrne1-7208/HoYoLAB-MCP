# HoYoLAB MCP

HoYoLABの公開記事・返信・HoYoWikiを検索し、AIが参照しやすいMDX風Markdownとして取得するMCPサーバーです。目次・階層・文書内検索・節やブロック・表の行範囲による部分取得に対応し、リビジョンを固定して続きを取得できます。

> [!CAUTION]
>
> 本プロジェクトは、COGNOSPHERE PTE. LTD.、miHoYo Co., Ltd.またはこれらの関連会社が運営、提供、承認、後援もしくは提携するものではありません。また、本プロジェクトとこれら企業との間に、提携、代理その他の関係はありません。
>
> 本プロジェクトを通じて取得、検索、表示または提供される投稿、文章、画像その他のコンテンツおよびデータに関する著作権その他の権利は、それぞれの投稿者、著作者その他の正当な権利者に帰属します。本プロジェクトは、これらのコンテンツおよびデータについて権利を取得または主張するものではありません。
>
> 本プロジェクト内で使用または言及される会社名、サービス名、ゲーム名、ロゴ、商標その他の知的財産に関する権利は、それぞれの権利者に帰属します。
>
> 本プロジェクトは、HoYoLABが第三者向けに公式に提供または承認したAPIを利用するものではありません。
>
> 本プロジェクトを利用する際は、対象となる各サービスの利用規約、ガイドラインその他の関連ポリシーをご確認のうえ、これらを遵守してください。本プロジェクトの提供は、各サービスの利用規約その他の条件に反する行為を許諾または推奨するものではありません。
>
> 本プロジェクトおよび本プロジェクトを通じて提供される情報について、その完全性、正確性、有用性、特定目的への適合性についていかなる保証も行いません。本プロジェクトの利用または利用不能により生じた一切の損害（アカウントの利用制限、データ消失等を含みますがこれらに限られません）について、本プロジェクトの開発者および関係者は一切の責任を負いません。利用者自身の責任においてご利用ください。

## セットアップ

必要最低バージョンはNode.js 20です。運用には保守期限内のLTS（Node.js 22または24）を推奨します。対応状況は[Node.jsのリリース情報](https://nodejs.org/en/about/previous-releases)を確認してください。MCPのAPI取得・変換にはブラウザのインストールやHoYoLABへのログインは不要です。

```bash
npm ci
npm run --silent mcp:server
```

言語などの環境設定を変更する場合は`.env.example`を参考に`.env`を用意します。言語・ゲーム・API通信のタイムアウトを設定できます。言語とゲームは各ツールの引数による指定が優先されます。

## MCPサーバー

MCPサーバーは、公開HoYoLAB APIを読み取り専用ツールとしてstdioで公開します。記事とWikiエントリの取得ツールは、`content`に変換後のMDXを返し、構造化結果にも同じ本文を`structuredContent.mdx`として含めます。reply取得は`content`と`structuredContent.markdown`にMarkdownを返し、`structuredContent.replies`には返信単位の本文・投稿者・日時・親子関係を含めます。検索ツールは候補ID・タイトル・URLを軽量なMarkdownと構造化結果で返すため、検索後に記事またはWiki取得ツールを呼び出せます。

```bash
npm run --silent mcp:server
```

登録されるツール:

- `search_hoyolab_posts` — HoYoLAB記事検索
- `search_hoyowiki` — 記事・HoYoWikiエントリ検索
- `read_hoyolab_article` — 記事全文をMDXで取得
- `read_hoyowiki_entry` — Wikiエントリ全体を番号付きMDXで取得
- `get_hoyowiki_hierarchy` — `1.`、`1.1.`、`1.1.1.` の番号付き階層とAPI上の場所を取得
- `read_hoyowiki_module` — `module[1]`やモジュール名を指定して、そのモジュールだけを番号付きMDXで取得
- `read_hoyowiki_component` — モジュールと`component[1]`等を指定して、そのコンポーネントだけを番号付きMDXで取得
- `read_hoyolab_replies` — 記事返信をMarkdownで取得（構造化本文、絵文字、画像、sub-replies対応）

検索ツールでは、HoYoLABの検索画面と同じフィルターを指定できます。`order_type`は`0`が通常順、`2`が新着順です。`author_type`は`0`が全投稿者、`1`が公式アカウント、`2`が認証済みアカウントです。返却結果の`structuredContent.filters`にも適用した値と意味を含めます。

言語は`ja-jp`、`en-us`、`zh-cn`などの正式コードを指定できます。HoYoLABの言語カタログにある`JA`／`JP`／`EN`などの別名は正式コードへ正規化し、カタログ外の値はMCPエラーとして返します。多言語記事では、記事MDXのfrontmatterと`structuredContent`に実際に返された言語、原言語、利用可能言語を記録します。

Wikiの階層番号は1始まりで、表示とAPI指定場所を対応させています。例えば`1.2.`は1番目のModuleに属する2番目のComponentで、場所は`module[1].component[2]`です。`module[...]`と`module[...].component[...]`は階層取得結果から直接取得ツールへ渡せます。番号は文書の版に依存するため、階層取得結果の`revision`を直接取得へ引き継ぐと同じ文書を参照できます。個別項目の取得には、目次に返された`section_id`を使用します。

記事とWikiの取得ツールは`view: "outline"`で目次、`view: "search"`と`query`で文書内検索を返します。節・ブロック・表の行範囲を選択でき、出力上限に達した場合は`continuation`に次の呼び出し引数を返します。要求言語と実際の言語、変換上の警告、取得範囲を別々に記録します。実際の言語がAPIで未報告の場合は推測せず`language_status: "unknown"`とします。

仕様・呼び出し例・取得状態とエラーの意味は[文書アクセスの使い方](docs/mcp-document-access.md)を参照してください。

MCPクライアント設定例（`/path/to/hoyolab-mcp`は実際のインストール先に置き換えてください）:

```json
{
  "mcpServers": {
    "hoyolab": {
      "command": "node",
      "args": ["/path/to/hoyolab-mcp/scripts/mcp-server.mjs"],
      "cwd": "/path/to/hoyolab-mcp"
    }
  }
}
```

## 動作確認

API通信を伴わない回帰テスト:

```bash
npm test
```

SDKクライアント経由で、ツール一覧・検索・記事MDX・Wiki MDX・階層・Module/Component直接取得・返信取得を実APIに対して確認するには次を実行します。

```bash
npm run mcp:check
```

崩壊：スターレイルとゼンレスゾーンゼロを含む複数ゲームの全ツールを実APIで確認するには次を実行します。

```bash
npm run mcp:check:games
```

3タイトルで、多言語と通常の記事、Wikiの全モジュール／コンポーネント、検索フィルター、返信のカーソルと分割取得を確認するには次を実行します。

```bash
npm run mcp:check:regressions
```

キャラクター以外の装備・素材・敵・ボンプなどのWikiと、検索から選んだ新しい記事を使って、元データの文章、部分取得、表の行選択、継続取得を照合する場合:

```bash
npm run mcp:check:corpus
```

大きな表などは指定予算に収まらないことがあるため、`BUDGET_TOO_SMALL`を確認してから予算を拡大します。上流APIに本文がない場合は`EMPTY_BODY`を報告します。テストの成功はすべての投稿や今後のAPI変更への対応を保証するものではありません。

返信の次ページは、返された`next_page`をカーソル`last_id`ごと同じツールへ渡してください。`page`の番号だけではAPIのページは進みません。`continuation`がある場合は現在のページを先に読み終えます。

## コントリビュート

Issue / Pull Request を歓迎します。PR には以下を含めてください。

- 変更目的
- 実装内容の要約
- 再現手順または確認手順

## 生成AIによる開発支援の表記

- 使用した生成AIモデル: GPT‑5.6 Luna
  - 活用範囲: HoYoLAB API仕様の調査、実装方針の検討、コードの作成・修正、テストの設計・検証、ドキュメントの作成

## ライセンス

本プロジェクトは [GNU AGPL v3以降](LICENSE) の条件で提供されます。
