# HoYoLAB MCP

[**日本語版 README**](README.md)

An MCP server that searches HoYoLAB articles, replies, and HoYoWiki entries and retrieves them in AI-friendly MDX format.

> [!CAUTION]
> Before using this project, please read the [**Disclaimer**](#disclaimer) below.

## Disclaimer

> &emsp;&emsp;This is an **independent, unofficial open-source project** that is **not operated, provided, approved, or sponsored by** COGNOSPHERE PTE. LTD., miHoYo Co., Ltd., or any of their affiliates, has **no affiliation, agency, representation, partnership, or other relationship** with those companies, and **is not an official tool for any of their services or titles**.
>
> &emsp;&emsp;This project **does not use any API officially provided or approved for third parties** by HoYoLAB. Due to upstream specification changes, endpoint deprecation, rate limiting, access controls, or other factors, this project **may cease functioning in whole or in part at any time without notice**, and the developers and contributors **assume no obligation to maintain compatibility, fix defects, provide updates, or offer support**.
>
> &emsp;&emsp;Where copyrights, moral rights, or other rights subsist in content searched, retrieved, converted, displayed, or otherwise processed through this project—including articles, replies, HoYoWiki entries and data, images, videos, emojis, and metadata—such rights, together with all intellectual property rights concerning referenced company names, service names, game titles, character names, logos, trademarks, and other identifiers, **belong to their respective authors or rightful owners**. HoYoverse, HoYoLAB, HoYoWiki, Genshin Impact, Honkai: Star Rail, Zenless Zone Zero, and other names and logos are trademarks or registered trademarks of COGNOSPHERE PTE. LTD., miHoYo Co., Ltd., or their affiliates. References to such names or marks in this project are solely to indicate the target services, and this project **neither acquires nor claims any rights over them**. Furthermore, this repository's open-source license applies strictly to this project's own source code and documentation; it **transfers no rights in any third-party content or intellectual property, and this project has no authority to grant permission to reproduce, redistribute, republish, create derivative works from, build datasets from, train AI models on, commercially exploit, or otherwise use them**. Whether any such use is permissible must be determined by the user based on authorization from the respective rightsholders, applicable statutory limitations and exceptions, and the terms of the target services.
>
> &emsp;&emsp;You **use this project at your own risk and are solely responsible for reviewing and complying with all applicable terms of service, community guidelines, content policies, automated-access rules, other related policies, and laws and regulations** of each target service and jurisdiction. The publication and provision of this project **do not permit, encourage, or facilitate any violation of those terms**, circumvention of technical restrictions or access controls, unauthorized automated bulk collection, excessive request loads on target servers, infringement of third-party rights, or any other improper conduct.
>
> &emsp;&emsp;Search, MDX conversion, partial retrieval based on outlines, modules, table row ranges, or character limits, and other processing performed by this project **may omit, simplify, or alter portions of the original wording, structure, table data, media, context, or other elements**, and upstream API responses are not guaranteed to cover or reproduce all data shown on the official Web interface. Furthermore, because retrieved articles, replies, HoYoWiki entries, and other information are unverified third-party content that may contain inaccuracies, outdated information, malicious links, adversarial instructions targeting AI systems, or other risks, **verifying the authenticity and safety of retrieved information and implementing privilege controls and safeguards in connected MCP clients and AI agents are the user's sole responsibility**.
>
> &emsp;&emsp;This project and all retrieved or converted information are **provided "as is" and "as available" without warranty of any kind**, express or implied, including completeness, accuracy, reliability, usefulness, timeliness, merchantability, fitness for a particular purpose, non-infringement, security, or continuous and error-free availability. To the maximum extent permitted by applicable law, under no circumstances and under no legal theory—whether in contract, tort, negligence, strict liability, or otherwise—shall **the developers, copyright holders, or contributors of this project be liable for any direct, indirect, incidental, special, punitive, or consequential damages** arising out of or in connection with the use of or inability to use this project or the information obtained through it, including account or IP address suspensions or blocks, access or rate restrictions, data loss or corruption, system failures, AI misbehavior or inaccurate outputs, or disputes and claims involving third parties, even if advised of the possibility of such damages.
>
> &emsp;&emsp;All specific items, content types, rights, policies, processes, causes, risks, warranty items, and damages mentioned in this disclaimer are illustrative examples only, and **the scope of this disclaimer is not limited to the specified or enumerated contents**. If any part of this disclaimer is held invalid or unenforceable under applicable law, that part shall be enforced to the maximum extent permitted by law, and **the validity and enforceability of the remaining parts shall not be affected**.

## Overview

HoYoLAB MCP lets MCP clients access information on HoYoLAB directly without a browser or account. Beyond full-page reads, clients can use outlines or in-document search to extract only the relevant sections or tables without exhausting context limits.

## Features

- Search and MDX conversion for articles, replies, and HoYoWiki entries
- Partial retrieval via outlines, in-document search, and row range selection
- Granular retrieval of individual HoYoWiki modules and components
- Reply retrieval including emojis, images, and thread structure
- Support for Genshin Impact, Honkai: Star Rail, and Zenless Zone Zero across multiple languages
- Built-in request pacing, concurrency limits, and caching
- No browser or HoYoLAB account required

## Requirements

- Node.js 20 or later (LTS 22 or 24 recommended)

## Installation

1. Install dependencies.
2. Copy [`hoyolab.config.example.yaml`](hoyolab.config.example.yaml) (example configuration) to `hoyolab.config.yaml`.

```bash
npm ci
cp -n hoyolab.config.example.yaml hoyolab.config.yaml
```

## Quick Start

1. Register the server in your MCP client configuration. **Replace `/path/to/hoyolab-mcp` with your actual installation path**.

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

2. Run the verification script.

   ```bash
   npm run mcp:check
   ```

   Expected output:

   ```text
   8 tools are registered and search, article, HoYoWiki, hierarchy, and reply results are displayed.
   ```

## Usage

Start the server directly:

```bash
npm run --silent mcp:server
```

Start with a specific configuration file:

```bash
node scripts/mcp-server.mjs --config /path/to/hoyolab.config.yaml
```

### Workflow

1. `search_hoyolab_posts` / `search_hoyowiki` — Search by keyword to identify article or HoYoWiki IDs.
2. `get_hoyowiki_hierarchy` — Inspect the HoYoWiki hierarchy.
3. `read_hoyolab_article` / `read_hoyowiki_*` — Read the full text or a specific section, module, or table range.
4. `read_hoyolab_replies` — Read replies on an article.

### Tools

| Tool | Description |
|---|---|
| `search_hoyolab_posts` | Search HoYoLAB articles |
| `search_hoyowiki` | Search articles and HoYoWiki entries |
| `read_hoyolab_article` | Fetch an article as MDX (supports outlines, in-document search, and partial reads) |
| `read_hoyowiki_entry` | Fetch a full HoYoWiki entry as MDX |
| `get_hoyowiki_hierarchy` | Retrieve the HoYoWiki hierarchy |
| `read_hoyowiki_module` | Fetch a HoYoWiki module as MDX |
| `read_hoyowiki_component` | Fetch a HoYoWiki component as MDX |
| `read_hoyolab_replies` | Fetch article replies |

See [`docs/mcp-document-access.md`](docs/mcp-document-access.md) (Document Access Guide, in Japanese) for detailed tool arguments, partial retrieval options, pagination, and error codes.

## Configuration

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

| Key | Default | Description |
|---|---|---|
| `language` | `""` | Default language code (`ja-jp`, `en-us`, etc.) |
| `gameId` | `2` | Default game ID (`2`: Genshin Impact, `6`: Honkai: Star Rail, `8`: Zenless Zone Zero) |
| `api.timeoutMs` | `20000` | Request timeout (ms) |
| `api.minRequestIntervalMs` | `100` | Minimum interval between requests (`0`–`10000` ms, `0` disables limit) |
| `api.concurrency` | `4` | Maximum concurrent requests (`1`–`32`) |
| `api.maxQueue` | `24` | Maximum queued requests (`0`–`1000`) |

Rate-limiting example (~1 request/second):

```yaml
language: "ja-jp"            # "" -> "ja-jp"
gameId: 2

api:
  timeoutMs: 30000           # 20000 -> 30000
  minRequestIntervalMs: 1000 # 100 -> 1000
  concurrency: 1             # 4 -> 1
  maxQueue: 24
```

Configuration changes take effect after restarting the server.

## Testing

Offline unit tests:

```bash
npm test
```

Live API verification scripts:

```bash
npm run mcp:check
npm run mcp:check:games
npm run mcp:check:regressions
npm run mcp:check:corpus
```

## Troubleshooting

- MCP client fails to start the server (such as `Cannot find module`): replace `/path/to/...` in your client configuration or `--config` argument with the actual path on your machine.
- Startup fails on configuration load: verify `hoyolab.config.yaml` contains no unknown keys or out-of-range values.
- `429` (`RATE_LIMITED`) returned: increase `api.minRequestIntervalMs` (e.g., to `1000`) and lower `api.concurrency` in `hoyolab.config.yaml` to reduce request frequency.
- `TIMEOUT` or `BUSY` returned: increase `api.timeoutMs` and `api.maxQueue` when using a larger `api.minRequestIntervalMs`.
- `BUDGET_TOO_SMALL` returned: increase `max_chars` or request a narrower section or table row range.
- Reply pagination does not advance: pass `next_page` (including `last_id`) instead of only incrementing `page`.

## AI Usage

- AI used: GPT-5.6 Luna, Gemini 4 Argon
- Usage scope: API research, implementation design, code generation and fixes, test design and verification, documentation structure and wording
- Human review: tool schemas, configuration rules, and runtime behavior verified against source code and tests

## Contributing

Issues and pull requests are welcome.

### Issues

You may write in any language (such as English or Japanese). Include as many of the following items as you know:

- `Summary`: brief overview of the issue
- `Environment`: Node.js version, OS, `gameId`, and language setting
- `Reproduction`: tool name and arguments
- `Behavior`: observed behavior or error output

<details>
<summary>Issue description example</summary>

````markdown
## Summary

`read_hoyowiki_component` returns `BUDGET_TOO_SMALL` on a single-row table when the header contains multiline cells.

## Environment

- Node.js: v22.14.0
- OS: Ubuntu 24.04
- `gameId`: `2` (`language: "ja-jp"`)

## Reproduction

Call `read_hoyowiki_component` with:

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

Fails with `BUDGET_TOO_SMALL` before emitting any table rows.
````

</details>

### Pull Requests

Please include:

- `Summary`: brief overview of the change
- `Problem`: problem and root cause
- `Change`: implementation and resulting behavior
- `Testing`: verification steps performed and any out-of-scope items

<details>
<summary>PR description example</summary>

````markdown
Related to #12.

## Summary

Fix table header budget accounting and continuation cursor generation in partial HoYoWiki table reads.

## Problem

Header rows were counted twice when slicing a table by `row_start` / `row_end`. Tables with wide headers exceeded the minimum budget check on single-row reads, and consecutive continuation calls repeated the last row of the previous slice.

## Change

Compute header overhead once per slice in `src/document/hoyolab-document.mjs`, clamp the minimum row budget to a single data row plus header, and advance `continuation.row_start` past the last emitted row index.

On entries with wide headers, single-row slices now succeed under the default budget and continuation calls resume without duplicate rows.

## Testing

- Added unit and boundary regression tests in `test/hoyolab-document.test.mjs` (`npm test`).
- Verified live HoYoWiki table slicing and continuation across Genshin Impact, Honkai: Star Rail, and Zenless Zone Zero (`npm run mcp:check:regressions`).

Nested HTML tables inside custom collapsible blocks remain outside this PR.
````

</details>

## License

This project is provided under the terms of the [GNU AGPLv3 or later](LICENSE). If you wish to use this project under a different license (such as the MIT License), please open an [Issue](https://github.com/cyrne1-7208/HoYoLAB-MCP/issues) in this repository.

## Support

Open an [Issue](https://github.com/cyrne1-7208/HoYoLAB-MCP/issues) in this repository for bug reports or questions.
