# HoYoLAB MCP

[**English README**](README_en.md)

HoYoLAB の記事・返信・HoYoWiki を検索し、AI が扱いやすい MDX 形式で取得する MCP サーバーです。

> [!CAUTION]
> 本プロジェクトを使用する前に、以下の[**免責事項**](#免責事項)を必ずお読みください。

## 免責事項

> 　本プロジェクトは**独立した非公式のオープンソースプロジェクト**であり、COGNOSPHERE PTE. LTD.、miHoYo Co., Ltd. またはこれらの関連会社が**運営・提供・承認・後援するものではなく、当該企業との間に提携・代理・代表・協業その他の関係も一切ありません**。また、**各サービス・タイトルの公式ツールでもありません**。
>
> 　本プロジェクトは、HoYoLAB が第三者向けに**公式に提供または承認した API を利用するものではありません**。対象サービスの仕様変更、エンドポイントの廃止、レート制限、アクセス制御その他の事由により**予告なく一部または全部の機能が動作しなくなる可能性**があり、開発者およびコントリビューターは**互換性の維持、不具合の修正、アップデートの提供またはサポートを行う義務を負いません**。
>
> 　本プロジェクトを通じて検索・取得・変換・表示その他の処理が行われる記事・返信・HoYoWiki・画像・動画・絵文字・メタデータ等のコンテンツについて著作権・著作者人格権その他の権利が存在する場合、ならびに記載・言及される会社名・サービス名・ゲーム名・キャラクター名・ロゴ・商標等に関する知的財産権は、**それぞれの著作者または正当な権利者に帰属します**。HoYoverse、HoYoLAB、HoYoWiki、原神、崩壊：スターレイル、ゼンレスゾーンゼロその他の名称およびロゴは、COGNOSPHERE PTE. LTD.、miHoYo Co., Ltd. またはこれらの関連会社の商標または登録商標です。本プロジェクトにおける名称等の記載は対象となるサービスを示すためのものであり、本プロジェクトはこれらについて**いかなる権利も取得・主張しません**。また、本リポジトリのオープンソースライセンスは本プロジェクトのソースコードおよびドキュメントのみに適用され、**第三者のコンテンツや知的財産に関する権利を移転するものではなく、本プロジェクトはそれらの複製・再配布・公衆送信・二次的著作物の作成・データセット構築・AI 学習・商用利用その他の利用を許諾する立場にありません**。これらの利用の可否は、各権利者の許諾、適用される権利制限規定および対象サービスの規約に基づき、利用者自身が判断してください。
>
> 　本プロジェクトは**利用者自身の責任において利用するものとし、対象となる各サービスの利用規約・コミュニティガイドライン・コンテンツ利用ポリシー・自動アクセスに関する規定その他の関連規約および適用法令を確認し、遵守してください**。本プロジェクトの公開および提供は、規約違反、技術的制限やアクセス制御の回避、無断での大量自動収集、対象サーバーに過度な負荷を与えるリクエスト、第三者の権利侵害その他の不適切な行為を**許諾・推奨・助長するものではありません**。
>
> 　本プロジェクトによる検索、MDX 変換、目次・モジュール・表の行範囲・文字数上限に基づく部分取得その他の処理では、**元の表現・構造・表データ・メディア・文脈等の一部が省略、簡略化または変更される場合**があり、上流 API の応答が公式 Web 画面上の全データを網羅・再現していることも保証されません。また、取得される記事・返信・HoYoWiki その他の情報は第三者が作成・投稿した未検証の外部コンテンツであり、誤情報、古い情報、悪意あるリンク、AI システムに対する不正な指示その他のリスクが含まれる可能性があるため、**取得情報の真偽・安全性の確認および接続先 MCP クライアントや AI エージェントにおける権限管理・安全対策は利用者自身の判断と責任で行ってください**。
>
> 　本プロジェクトおよび取得・変換された情報は**現状有姿かつ利用可能な範囲で提供**され、その完全性・正確性・信頼性・有用性・最新性・商品性・特定目的への適合性・第三者の権利非侵害・安全性・継続的または不具合のない利用可能性を含むいかなる事項についても、明示または黙示を問わず**一切保証しません**。適用法令で認められる最大限の範囲において、契約・不法行為・過失・無過失責任その他のいかなる法理に基づくかを問わず、アカウントや IP アドレスの停止・遮断、アクセスやレートの制限、データの消失・破損、システム障害、AI の誤動作や不正確な出力、第三者との紛争・請求その他本プロジェクトまたは取得情報の利用もしくは利用不能に起因または関連して生じた直接的・間接的・偶発的・特別・懲罰的・結果的な一切の損害について、**本プロジェクトの開発者・著作権者およびコントリビューターは、たとえそのような損害が生じる可能性を知らされていた場合であっても、一切の責任を負いません**。
>
> 　本免責事項において記載された各対象・コンテンツ・権利・規約・処理・事由・リスク・保証項目・損害は例示であり、**本免責事項の適用範囲は指定・列挙された内容に限られません**。また、本免責事項のいずれかの記述が適用法令のもとで無効または執行不能と判断された場合であっても、当該部分は法令で認められる最大限の範囲で効力を有し、**その他の部分の有効性には影響しないものとします**。

## 概要

ブラウザやアカウントを用意することなく、MCP クライアントから HoYoLAB 上の情報を直接参照できます。全文の取得に加え、目次や文書内検索から必要なセクションや表だけを切り出せるため、長大な記事や HoYoWiki でもコンテキストを圧迫しません。

## 特徴

- 記事・返信・HoYoWiki の検索と MDX 変換
- 目次・文書内検索・行範囲指定による部分取得
- HoYoWiki のモジュール・コンポーネント単位での取得
- 絵文字・画像・スレッド構造を含む返信の取得
- 原神、崩壊：スターレイル、ゼンレスゾーンゼロおよび多言語に対応
- リクエスト間隔・同時実行数の制御とキャッシュ
- ブラウザや HoYoLAB アカウントが不要

## 必要環境

- Node.js 20 以上（推奨: LTS 22 または 24）

## インストール

1. 依存パッケージをインストールします。
2. [`hoyolab.config.example.yaml`](hoyolab.config.example.yaml)（設定例）を `hoyolab.config.yaml` にコピーします。

```bash
npm ci
cp -n hoyolab.config.example.yaml hoyolab.config.yaml
```

## クイックスタート

1. MCP クライアントの設定ファイルにサーバーを登録します。`/path/to/hoyolab-mcp` は**実際の配置先に置き換えてください**。

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

2. 疎通テストを実行します。

   ```bash
   npm run mcp:check
   ```

   期待結果:

   ```text
   8つのツールが登録され、検索・記事・HoYoWiki・階層・返信の取得結果が表示されます。
   ```

## 使い方

単体でサーバーを起動する場合:

```bash
npm run --silent mcp:server
```

設定ファイルを指定して起動する場合:

```bash
node scripts/mcp-server.mjs --config /path/to/hoyolab.config.yaml
```

### 利用フロー

1. `search_hoyolab_posts` / `search_hoyowiki` — キーワードで検索し、記事や HoYoWiki の ID を特定します。
2. `get_hoyowiki_hierarchy` — HoYoWiki の階層構造を確認します。
3. `read_hoyolab_article` / `read_hoyowiki_*` — 全文または指定したセクション・モジュール・表を読み込みます。
4. `read_hoyolab_replies` — 記事への返信を読み込みます。

### ツール一覧

| ツール | 説明 |
|---|---|
| `search_hoyolab_posts` | HoYoLAB の記事を検索 |
| `search_hoyowiki` | 記事および HoYoWiki を検索 |
| `read_hoyolab_article` | 記事を MDX で取得（目次・文書内検索・部分取得に対応） |
| `read_hoyowiki_entry` | HoYoWiki 全体を MDX で取得 |
| `get_hoyowiki_hierarchy` | HoYoWiki の階層構造を取得 |
| `read_hoyowiki_module` | HoYoWiki のモジュールを MDX で取得 |
| `read_hoyowiki_component` | HoYoWiki のコンポーネントを MDX で取得 |
| `read_hoyolab_replies` | 記事の返信を取得 |

各ツールの引数・部分取得・ページネーション・エラーコードの詳細は [`docs/mcp-document-access.md`](docs/mcp-document-access.md)（文書アクセスの使い方）を参照してください。

## 設定

`hoyolab.config.yaml`:

```yaml
language: ""
gameId: 2

api:
  timeoutMs: 20000
  minRequestIntervalMs: 100
  concurrency: 4
  maxQueue: 24
```

| キー | 既定値 | 説明 |
|---|---|---|
| `language` | `""` | 既定の言語コード（`ja-jp`、`en-us` など） |
| `gameId` | `2` | 既定のゲーム ID（`2`: 原神、`6`: 崩壊：スターレイル、`8`: ゼンレスゾーンゼロ） |
| `api.timeoutMs` | `20000` | リクエストのタイムアウト（ms） |
| `api.minRequestIntervalMs` | `100` | リクエストの最小間隔（`0`〜`10000` ms、`0` で制限なし） |
| `api.concurrency` | `4` | 同時リクエスト数の上限（`1`〜`32`） |
| `api.maxQueue` | `24` | リクエスト待機数の上限（`0`〜`1000`） |

リクエストの頻度を1回/秒程度に抑える設定例:

```yaml
language: "ja-jp"            # "" -> "ja-jp"
gameId: 2

api:
  timeoutMs: 30000           # 20000 -> 30000
  minRequestIntervalMs: 1000 # 100 -> 1000
  concurrency: 1             # 4 -> 1
  maxQueue: 24
```

設定変更はサーバー再起動後に反映されます。

## テスト

API 通信なしの単体テスト:

```bash
npm test
```

実 API に対する疎通テスト:

```bash
npm run mcp:check
npm run mcp:check:games
npm run mcp:check:regressions
npm run mcp:check:corpus
```

## トラブルシューティング

- MCP クライアントからサーバーを起動できない（`Cannot find module` など）: クライアント設定や `--config` の `/path/to/...` を実際の配置先に書き換えているか確認します。
- 起動時に設定エラーになる: `hoyolab.config.yaml` に未知のキーや範囲外の値が含まれていないか確認します。
- `429`（`RATE_LIMITED`）が返る: `hoyolab.config.yaml` の `api.minRequestIntervalMs` を大きくし（例: `1000`）、`api.concurrency` を下げてリクエスト頻度を抑えます。
- `TIMEOUT` または `BUSY` が返る: `api.minRequestIntervalMs` を大きくしている場合は、`api.timeoutMs` と `api.maxQueue` も引き上げます。
- `BUDGET_TOO_SMALL` が返る: 出力上限（`max_chars`）を増やすか、取得するセクションや表の行範囲を絞ります。
- 返信の次ページが進まない: `page` 番号だけでなく、`next_page`（`last_id` を含む）をそのまま渡します。

## 生成支援ツール利用

- 使用した AI: GPT-5.6 Luna、Gemini 4 Argon
- 利用範囲: API 仕様調査、実装方針検討、コード作成・修正、テスト設計・検証、ドキュメント構成・文言調整
- 人手レビュー: ツール仕様、設定項目、動作説明をソースコードおよびテストと照合して確認

## コントリビュート

Issue / Pull Request を歓迎します。

### Issue

日本語・英語など言語は問いません。以下の項目をわかる範囲で記載してください。

- `Summary`: 現象の要約
- `Environment`: Node.js バージョン、OS、`gameId`、言語設定
- `Reproduction`: ツール名と引数
- `Behavior`: 実際の動作やエラー内容

<details>
<summary>Issue の記述例</summary>

````markdown
## Summary

複数行セルを含むヘッダーを持つ HoYoWiki の表で、1行だけ指定して `read_hoyowiki_component` を呼び出すと `BUDGET_TOO_SMALL` が返る。

## Environment

- Node.js: v22.14.0
- OS: Ubuntu 24.04
- `gameId`: `2` (`language: "ja-jp"`)

## Reproduction

以下の引数で `read_hoyowiki_component` を実行する:

```json
{
  "entry_page_id": "1234",
  "module": "module[1]",
  "component": "component[2]",
  "row_start": 1,
  "row_end": 1
}
```

## Behavior

データ行が出力される前に `BUDGET_TOO_SMALL` エラーになる。
````

</details>

### Pull Request

以下の項目を含めてください。

- `Summary`: 変更の要約
- `Problem`: 問題と原因
- `Change`: 実装内容と挙動
- `Testing`: 実施したテストとスコープ外の事項

<details>
<summary>PR の記述例</summary>

````markdown
Related to #12.

## Summary

HoYoWiki の表の部分取得におけるヘッダー予算計算と `continuation` の開始行位置を修正します。

## Problem

`row_start` / `row_end` による表スライス時にヘッダー行のサイズが二重計上されており、列数の多い表で1行取得を行うと最小予算チェックで失敗していました。また、`continuation` で続きを取得した際に直前のスライスの最終行が重複して出力されていました。

## Change

`src/document/hoyolab-document.mjs` でスライスごとのヘッダーサイズ計算を1回に統一し、最小予算の判定基準を「ヘッダー＋データ1行」に修正しました。あわせて `continuation.row_start` を出力済み最終行の次インデックスへ進めるようにしました。

列数の多い HoYoWiki の表でも既定予算のまま1行単位のスライスが可能になり、`continuation` による継続取得でも行の重複が発生しなくなります。

## Testing

- `test/hoyolab-document.test.mjs` に境界値・継続取得の単体テストを追加し、`npm test` が通過することを確認しました。
- 原神、崩壊：スターレイル、ゼンレスゾーンゼロの実 API に対して `npm run mcp:check:regressions` を実行し、表の部分取得と継続取得が正常に動作することを確認しました。

カスタム折りたたみブロック内のネストされた HTML 表の分割は本 PR の対象外です。
````

</details>

## ライセンス

本プロジェクトは [GNU AGPLv3 or later](LICENSE) の条件で提供されます。MIT ライセンスなど別ライセンスでの利用を希望する場合は、このリポジトリの [Issue](https://github.com/cyrne1-7208/HoYoLAB-MCP/issues) で申請してください。

## サポート

不具合報告や質問は、このリポジトリの [Issue](https://github.com/cyrne1-7208/HoYoLAB-MCP/issues) へ投稿してください。
