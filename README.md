# HoYoLAB read-only MCP server

公開HoYoLAB／HoYoWiki APIを読み取り専用のMCPツールとして提供します。記事本文はMDX風Markdownへ変換し、HTML、Quill Delta、旧形式のJSON本文、段落、表、画像、動画を扱います。

ライセンスは [GNU AGPL v3以降](LICENSE) です。

## セットアップ

```bash
npm install
npm test
```

実APIを使ったMCP疎通確認:

```bash
npm run mcp:check
```

崩壊：スターレイルとゼンレスゾーンゼロを含む複数ゲームの全ツールを実APIで確認するには次を実行します。

```bash
npm run mcp:check:games
```

## 起動

stdio MCPサーバーとして起動します。

```bash
npm run mcp:server
```

MCPクライアント設定例:

```json
{
  "mcpServers": {
    "hoyolab": {
      "command": "node",
      "args": ["/absolute/path/to/hoyolab-mcp/scripts/mcp-server.mjs"],
      "cwd": "/absolute/path/to/hoyolab-mcp"
    }
  }
}
```

HoYoLABの公開読み取りAPIは通常認証情報を必要としません。必要に応じて`.env`へ次の値を設定できます。

```dotenv
HOYOLAB_LANGUAGE=ja-jp
HOYOLAB_GAME_ID=2
HOYOLAB_API_TIMEOUT_MS=20000
```

## MCPツール

- `search_hoyolab_posts` — HoYoLAB記事を検索
- `search_hoyowiki` — 記事とHoYoWikiエントリを検索
- `read_hoyolab_article` — 記事全文をMDX風Markdownで取得
- `read_hoyowiki_entry` — Wikiエントリ全体を番号付きMarkdownで取得
- `get_hoyowiki_hierarchy` — `1.`、`1.1.`、`1.1.1.` の番号付き階層と場所を取得
- `read_hoyowiki_module` — 指定したModuleだけを取得
- `read_hoyowiki_component` — 指定したComponentだけを取得
- `read_hoyolab_replies` — 記事返信をMarkdownと構造化データで取得

記事取得結果は、`content[0].text`と`structuredContent.mdx`に同じ完全な本文を返します。返信取得結果は、`content[0].text`と`structuredContent.markdown`にMarkdownを返し、返信単位の本文・投稿者・日時・親子関係を`structuredContent.replies`で返します。

Wikiの階層番号は1始まりです。例えば`1.2.`は`module[1].component[2]`で直接取得できます。
