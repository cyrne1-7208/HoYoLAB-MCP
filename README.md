# HoYoLAB MCP server

HoYoLABの公開APIを読み取り専用のMCPツールとして提供します。記事本文とHoYoWikiの内容を、AIが扱いやすいMDX風Markdownへ変換します。

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

```bash
npm install
npm test
```

## MCPサーバー

stdio MCPサーバーとして起動します。

```bash
npm run mcp:server
```

MCPクライアント設定例（`/path/to/HoYoLAB-MCP`は実際の配置先へ置き換えてください）:

```json
{
  "mcpServers": {
    "hoyolab": {
      "command": "node",
      "args": ["/path/to/HoYoLAB-MCP/scripts/mcp-server.mjs"],
      "cwd": "/path/to/HoYoLAB-MCP"
    }
  }
}
```

記事とWikiエントリの取得ツールは、`content`に変換後のMDXを返し、構造化結果にも同じ本文を`structuredContent.mdx`として含めます。返信取得は`content`と`structuredContent.markdown`にMarkdownを返し、`structuredContent.replies`には返信単位の本文・投稿者・日時・親子関係を含めます。検索ツールは候補ID・タイトル・URLを軽量なMarkdownと構造化結果で返すため、検索後に記事またはWiki取得ツールを呼び出せます。

## ツール

- `search_hoyolab_posts` — HoYoLAB記事検索
- `search_hoyowiki` — 記事・HoYoWikiエントリ検索
- `read_hoyolab_article` — 記事全文をMDXで取得
- `read_hoyowiki_entry` — Wikiエントリ全体を番号付きMDXで取得
- `get_hoyowiki_hierarchy` — `1.`、`1.1.`、`1.1.1.`の番号付き階層とAPI上の場所を取得
- `read_hoyowiki_module` — `module[1]`やモジュール名を指定して、そのモジュールだけを番号付きMDXで取得
- `read_hoyowiki_component` — モジュールと`component[1]`等を指定して、そのコンポーネントだけを番号付きMDXで取得
- `read_hoyolab_replies` — 記事返信をMarkdownで取得（構造化本文、絵文字、画像、sub-replies対応）

## 検索フィルター

検索ツールでは、HoYoLABの検索画面で確認できるフィルターを指定できます。`order_type`は`0`が関連度順、`2`が新着順です。`author_type`は`0`が全投稿者、`1`が公式アカウント、`2`が認証済みアカウントです。`author_type=3`（フォロー中のアカウント）は匿名公開検索では利用できないため、MCPの入力スキーマには公開していません。返却結果の`structuredContent.filters`にも適用した値と意味を含めます。

## 言語と多言語記事

言語は`ja-jp`、`en-us`、`zh-cn`などの正式コードを指定できます。HoYoLABの言語カタログにある`JA`／`JP`／`EN`などの別名は正式コードへ正規化し、カタログ外の値はMCPエラーとして返します。多言語記事では、記事MDXのfrontmatterと`structuredContent`に実際に返された言語、原言語、利用可能言語を記録します。

## Wikiの階層指定

Wikiの階層番号は1始まりで、表示とAPI指定場所を対応させています。例えば`1.2.`は1番目のModuleに属する2番目のComponentで、場所は`module[1].component[2]`です。`module[...]`と`module[...].component[...]`は階層取得結果から直接取得ツールへ渡せます。`item[...]`はComponent内の項目位置を示す情報で、取得時は親Componentを指定します。

## 動作確認

ローカルのモックテスト:

```bash
npm test
```

公開APIを使ったMCP疎通確認:

```bash
npm run mcp:check
```

崩壊：スターレイルとゼンレスゾーンゼロを含む複数ゲームの全ツールを実APIで確認するには、次を実行します。

```bash
npm run mcp:check:games
```

## コントリビュート

Issue / Pull Requestを歓迎します。PRには以下を含めてください。

- 変更目的
- 実装内容の要約
- 再現手順または確認手順

## 生成AIによる開発支援の表記

- 使用した生成AIモデル: GPT‑5.6 Luna
  - 活用範囲: HoYoLAB API仕様の調査、実装方針の検討、コードの作成・修正、テストの設計・検証、ドキュメントの作成

## ライセンス

本プロジェクトは[GNU AGPL v3以降](LICENSE)の条件で提供されます。
