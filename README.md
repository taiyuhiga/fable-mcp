# fable-mcp

[![CI](https://github.com/taiyuhiga/fable-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/taiyuhiga/fable-mcp/actions/workflows/ci.yml)

**Claude Fable 5 を「設計・深い推論役」として OpenAI Codex から使うための MCP サーバー。**

English README: [README.en.md](README.en.md)

## 初心者向け: Codex に GitHub URL を貼るだけ

一番簡単なセットアップ方法は、Codex に次の文章をそのまま貼ることです。GitHub を clone したり、MCP を手入力したりする必要はありません。

```text
https://github.com/taiyuhiga/fable-mcp をセットアップして。

READMEの初心者向け手順に従って、次を最後までやって:
1. Node.js 18+ があるか確認
2. Claude Code CLI がなければ npm i -g @anthropic-ai/claude-code でインストール
3. fable-mcp の Codex Plugin をインストール
4. ANTHROPIC_API_KEY が必要なところだけ私に聞く
5. codex mcp list で fable が出るか確認
6. 最後に「Fableの状態を確認して」と試せる状態にする
```

ターミナルで自分で実行したい場合は、OS に合わせてどちらか1つを使います。

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/taiyuhiga/fable-mcp/v0.6.1/install.sh | bash
```

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/taiyuhiga/fable-mcp/v0.6.1/install.ps1 | iex
```

installer は Node.js / Codex CLI / Claude Code CLI を確認し、Codex Plugin を追加します。API キーは対話で聞かれたときだけ貼ってください。終わったら Codex アプリを再起動し、`Fableの状態を確認して` と送ります。

Codex (実装役) の上に Fable 5 (アーキテクト役) を乗せる2エージェント構成を、Codex デスクトップアプリ / CLI 上で実現します。

```
あなた ──> Codex アプリ (実装役・ChatGPTサブスク定額)
              │  設計が必要なとき MCP ツールを呼ぶ
              ▼
          fable-mcp ──> claude -p --model claude-fable-5 (読み取り専用プランモード)
                            │  リポジトリを探索して深く推論
                            ▼
                        実装プランを Codex に返す → Codex が実装
```

## Claude Code 側で何が起きるか

fable-mcp は Fable 5 を直接実装役にしません。MCP ツールが呼ばれるたびに、裏で次の形の Claude Code headless プロセスを起動します:

```sh
claude -p --model claude-fable-5 --permission-mode plan --output-format stream-json --verbose
```

- `--permission-mode plan` なので、Fable はローカルプロジェクトを読んで設計・レビューできますが、ファイル編集はできません。
- 実装、テスト、コミット、リリースは Codex 側が行います。
- 各呼び出しは基本的に新しい `claude` プロセスです。続きの壁打ちは応答末尾の `session_id` を次回の `session_id` に渡すと、Claude Code の `--resume` で同じ会話として続けます。
- `ANTHROPIC_API_KEY` があれば Anthropic API の従量課金、なければ `claude` CLI の現在のログイン認証を使います。

## 重要: Claude のサブスクリプションは不要です

- Claude Code CLI は**無料のツール**です。課金は「どの認証情報で動かすか」で決まります。
- `ANTHROPIC_API_KEY` を設定すれば、Fable 5 の呼び出しはすべて **Anthropic API の従量課金**（入力 $10 / 出力 $50 per 100万トークン）になります。サブスクに入ったことがない人でも使えます。
- `ANTHROPIC_API_KEY` を設定しない場合は、`claude` CLI の現在のログイン認証で動きます。どちらの認証で課金されているかは `fable_status` で確認できます。
- コスト目安: 設計プラン1回 = リポジトリ探索込みで **$1〜5 程度**。軽い質問なら数十セント。実費は [Anthropic Console](https://console.anthropic.com) の Usage 画面で確認してください。
- 安く試すなら `FABLE_EFFORT=medium`、本気の設計だけ `effort=max` / `xhigh` を呼び出しごとに指定する運用が安全です。

対応OS: **macOS / Linux / Windows**

## セットアップ (推奨: Codex Plugin)

v0.6 以降は **Codex plugin として入れるのが推奨**です。MCP 定義、品質ループの Stop hook、SessionStart でのルーティング指示注入を plugin に同梱しています。

### 1. 前提

- Node.js 18+
- Claude Code CLI（無料）: `npm i -g @anthropic-ai/claude-code`
- [Anthropic Console](https://console.anthropic.com) で API キーを作成し、**クレジットをチャージ**

API キーは次のどちらかで渡します:

```sh
export ANTHROPIC_API_KEY="sk-ant-..."
# 任意: low / medium / high / xhigh / max。安く試すなら medium、本気の設計だけ max。
export FABLE_EFFORT="medium"
```

または Codex の plugin MCP override で `ANTHROPIC_API_KEY` を設定します:

```toml
[plugins."fable-mcp@fable-mcp".mcp_servers.fable.env]
ANTHROPIC_API_KEY = "sk-ant-..."
FABLE_EFFORT = "medium"   # 任意。未指定ならサーバーのデフォルト
```

未設定の場合は、`claude` CLI の現在のログイン認証で動きます。

### 2. Plugin marketplace を追加してインストール

```sh
codex plugin marketplace add taiyuhiga/fable-mcp --ref v0.6.1
codex plugin add fable-mcp@fable-mcp
```

その後 Codex アプリを再起動してください。初回に同梱 Stop hook の信頼確認が出たら承認します。

最新版を追いかけたい開発用途では `--ref main` または `--ref` なしでも入れられますが、他ユーザーに配る手順はタグ固定を推奨します。

> うまく marketplace から入らない場合は、このリポジトリを clone して `codex plugin marketplace add /ABSOLUTE/PATH/TO/fable-mcp` → `codex plugin add fable-mcp@fable-mcp` を使ってください。

### 3. 動作確認

Codex アプリで新規スレッドを開き、次を試します:

```text
Fableの状態を確認して
```

`fable_status` がローカル診断を返せば、MCP の接続は成功です。これは Fable 本体を呼ばないため API コストは発生しません。

次に、実際の Fable 呼び出しを試します:

```text
Fable5に聞いて: このリポジトリは何をするもの?
```

Plan mode では、Fable と明示しなくても `fable_plan` が起動します。「Fableなしで」と言えば Codex だけでプランします。

`fable_plan` は、Codex の Plan UI が要約・再構成してしまう場合に備えて、Fable のプラン原文を常にプロジェクト内の `.fable/last-plan.md` に保存します。このファイルが正本です。

## 詳細セットアップ / 手動MCPフォールバック

### 楽な方法: AIエージェントに任せる

Codex や Claude Code などのAIエージェントに、以下をそのまま貼ってください：

> https://github.com/taiyuhiga/fable-mcp をセットアップして。
> README の初心者向け手順に従って、Node.js 18+ 確認、Claude Code CLI 確認/インストール、Codex Plugin install、`codex mcp list` 確認までやって。
> ANTHROPIC_API_KEY が必要なところだけ私に聞いて。
> 終わったら Codex を再起動し、「Fableの状態を確認して」と試せる状態にして。

エージェントの作業が終わったら、人間がやるのは2つだけです：
1. [Anthropic Console](https://console.anthropic.com) でAPIキーを作成・チャージし、聞かれたときだけ貼る（これだけはエージェントにはできません）
2. Codex アプリを再起動して「Fableの状態を確認して」で動作確認

### 手動MCPでやる場合

### 1. 前提のインストール

- Node.js 18+
- Claude Code CLI（無料）: `npm i -g @anthropic-ai/claude-code`
- [Anthropic Console](https://console.anthropic.com) で API キーを作成し、**クレジットをチャージ**（未チャージだと課金エラーになります）

### 2. このリポジトリを取得して依存を入れる

```sh
git clone https://github.com/taiyuhiga/fable-mcp.git
cd fable-mcp
npm install
```

### 3. Codex に登録 — `~/.codex/config.toml` に追記

```toml
[mcp_servers.fable]
command = "node"                        # nvm 利用時は node のフルパス推奨
args = ["/ABSOLUTE/PATH/TO/fable-mcp/server.mjs"]
startup_timeout_sec = 60
tool_timeout_sec = 1200                 # Fable の深い推論は数分かかるため長めに

[mcp_servers.fable.env]
ANTHROPIC_API_KEY = "sk-ant-..."        # あなたの API キー（従量課金）
```

> 注意: プロジェクト単位の `.codex/config.toml` は Codex デスクトップアプリで無視される既知バグがあるため、グローバルの `~/.codex/config.toml` に書いてください。

> Windows の場合: `command = "node"`、`args` は `C:/Users/you/fable-mcp/server.mjs` のように指定してください。claude CLI は node と同じディレクトリの `claude.cmd` を自動解決します（見つからない場合のみ `FABLE_CLAUDE_BIN` を設定）。

### 4. Codex に「いつ Fable を呼ぶか」を教える — `~/.codex/AGENTS.md` に追記

```markdown
# Fable 5 オーケストレーション (fable-mcp)

Claude Fable 5 は「設計・深い推論」の外部ブレーン。

- **セットアップ確認・不具合調査**: 「Fableの状態を確認して」「Fable MCP動いてる？」などのときは、まず fable_status を呼ぶ。これはローカル診断だけで API コストは発生しない。
- **Plan モードでは常に Fable がプランを作る**: Plan モードに入ったら、
  ユーザーが Fable に言及していなくても必ず fable_plan を呼ぶ。
  「Fable なしで」と言われたときだけ自分でプランする。
- **Plan モードの提示方法 (最重要)**: proposed_plan / プラン本文には
  Summary・Key Changes のような自分の再構成を一切書かず、Fable のプラン
  全文を一字一句そのままコピーして入れる ([fable-mcp] フッターは除いてよい)。
  要約は原文の劣化コピー。補足は原文の後に「Fableプランからの変更点」として
  別記する。
- 通常モードでは、ユーザーが「Fable」「Fable5」「フェイブル」に言及したら
  (例:「Fable5に聞いて」「Fableでプラン作って」「Fableにレビューさせて」)、
  内容に応じて fable_ask (質問・相談) / fable_plan (設計依頼) /
  fable_review (実装レビュー) を呼ぶ。言及がなければ自分だけで進め、
  Fable を勝手に呼ばない。
- **品質ループ**: ユーザーが「合格まで回して」「◯点まで仕上げて」「ループで」
  等と言ったら、fable_plan に loop_threshold (指定なければ 90) を付けて呼ぶ。
  実装後に fable_review を呼ぶと採点され、未達ならターン終了時に Stop フックが
  差し戻すので、feedback に従って修正し再度 fable_review を呼ぶ。
  .fable-loop/ 配下のファイルは絶対に直接編集しない (採点の改竄に当たる)。
- 「maxで」「じっくり」→ effort: "max" (または xhigh)、「軽く」→ "medium"
  をツール引数に渡す。指定がなければ渡さない。
- Fable の出力 (プラン・回答・レビュー結果) は要約・言い換えせず全文を
  そのまま提示する。プランとして使うときは Fable のプランが正で、変更が
  必要な場合のみ「Fable プランからの変更点」として差分と理由を別記する。
- 続きの質問は応答末尾の session_id を付けて同じ会話として呼ぶ。
- Fable の応答には数分かかることがある。待つこと。
```

> 逆に「設計級のタスクでは自動で Fable に設計を任せたい」場合は、上記に
> 「複数ファイルにまたがる実装・新機能・アーキテクチャ判断を伴うタスクは、
> 実装前に必ず fable_plan を呼び、返ってきたプランに従って実装する」という
> 一行を足してください (自動委譲モード)。

### 5. 動作確認

```sh
# CLI 単体で Fable 5 が API 経由で呼べるか
ANTHROPIC_API_KEY=sk-ant-... claude -p "Reply with OK" --model claude-fable-5

# Codex がサーバーを認識しているか
codex mcp list
```

Codex アプリでプロジェクトを開き、「**Fable5にこのプロジェクトの構造を聞いて**」と話しかけて `fable_ask` が発火すれば成功です。

## 提供ツール

| ツール | 用途 |
|---|---|
| `fable_status` | ローカル診断。Claude Code CLI、認証/課金モード、推論設定、最後のプラン、品質ループ状態を確認。Fable 本体は呼ばないので無料 |
| `fable_plan` | 実装前の設計。Fable がリポジトリを読み取り専用で探索し、実装プランを返す。`loop_threshold` を渡すと受け入れ基準付きプラン＋品質ループ初期化 |
| `fable_ask` | 深い推論が必要な質問・相談。「Fable5に聞いて」のルーティング先 |
| `fable_review` | 実装後のレビュー。git diff を読んでバグ・設計乖離・簡素化を指摘。品質ループ中は採点係になり、スコアが state.json に機械記録される |

`fable_plan` / `fable_ask` / `fable_review` の応答末尾には `session_id` が付き、次回それを渡すと同じ会話の続きとしてフォローアップできます。

## 環境変数

| 変数 | デフォルト | 説明 |
|---|---|---|
| `ANTHROPIC_API_KEY` | (なし) | API 従量課金で動かすためのキー。未設定なら claude CLI の現在のログイン認証で動く |
| `FABLE_MODEL` | `claude-fable-5` | 使うモデル。コストを抑えたければ `claude-opus-4-8` 等に変更可 |
| `FABLE_EFFORT` | (モデルのデフォルト = high 相当) | 推論の深さのデフォルト: `low` / `medium` / `high` / `xhigh` / `max`。安く試すなら `medium`。本気の設計だけ各ツールの `effort` 引数で `max` / `xhigh` に上書きするのが安全 |
| `FABLE_MAX_TURNS` | `60` | 1回の呼び出しで Fable が使える探索ターン数の上限（コスト暴走防止）。`0` で無制限。上限に達すると途中結果と続行方法が返る |
| `FABLE_TIMEOUT_MS` | `1200000` (20分) | 1回の呼び出しのタイムアウト |
| `FABLE_CLAUDE_BIN` | 自動解決 | claude CLI のフルパス (自動解決に失敗する場合のみ) |

## 品質ループ (eval-loop) — 合格点まで自動で仕上げる

「◯点まで仕上げて」「合格まで回して」という依頼を、**採点と続行判定から人とAIの気分を排除した形**で回すモードです。

```
fable_plan (loop_threshold: 90)
   → Fable がプラン + 受け入れ基準 (採点表) を出し、.fable-loop/ が初期化される
Codex が実装
   → fable_review を呼ぶ
Fable (採点係) が基準に照らして絶対評価
   → スコアは server が機械パースして state.json に直接記録 (Codex の手を通らない)
ターン終了 → Stop フック (進行係) が整数比較
   ├─ score < 合格点 かつ 周回 < 上限 → decision:block で差し戻し (feedback を読んで修正→再採点)
   └─ 合格 or 上限 → 静かに終了
```

### セットアップ (フック登録・1回だけ)

`~/.codex/hooks.json` に進行係を登録します:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "node /ABSOLUTE/PATH/TO/fable-mcp/hooks/fable-loop-stop.mjs", "timeout": 30 }
        ]
      }
    ]
  }
}
```

初回実行時に Codex が「このフックを信頼しますか」と確認してきます (承認すると config.toml の hooks.state にハッシュが記録されます)。

### 状態ファイル

ループの状態は会話ではなく `.fable-loop/` ディレクトリが持ちます (プロジェクトの .gitignore への追加推奨):

```
.fable-loop/
├── state.json    周回数・スコア・合格点・ベスト (進行係が読む司令室)
├── task.md       元の依頼文 (毎周読み直して目標ドリフトを防ぐ)
├── criteria.md   受け入れ基準 (採点軸は周回をまたいで固定)
└── turns/        周回ごとの採点記録 turn-XXX-eval.json
```

### 設計上の性質 (なぜズルできないか)

- **採点係は毎回まっさら**: fable-mcp は呼び出しごとに新プロセスなので、採点係は実装時の会話・言い訳を一切見ない
- **スコアは実装役の手を通らない**: Fable の採点JSON → server の機械パース → state.json。実装役 (Codex) がスコアを書く経路がない
- **続行判定は整数比較**: Stop フックは `score >= threshold || iteration >= max` を比べるだけ。「もう十分でしょう」が介在しない
- **採点軸は固定**: 基準はプラン時に確定し、採点係にも実装役にも変更権限がない
- 制約: 採点係は読み取り専用モードで動くため、状態を変えるテストコマンドは実行できないことがある (その場合はコードとテスト定義を読んで判定し、feedback に明記される)

## 実行中の挙動

- **進捗が見える**: Fable がファイルを読んだりコマンドを実行するたびに MCP 進捗通知が流れます（対応クライアントの場合）。長い推論中も20秒ごとに生存確認が届きます
- **キャンセルで課金も止まる**: クライアント側でツール呼び出しを中断すると、裏の Fable プロセスも即座に停止します
- **コスト上限**: `FABLE_MAX_TURNS`（デフォルト60ターン）で1回あたりの探索量に上限がかかります

## コスト安全

- まず `FABLE_EFFORT=medium` で試し、重要な設計だけ「Fable5に max で」などと明示して呼び出しごとの `effort` を上げるのが現実的です。
- `FABLE_MAX_TURNS=60` が1回の探索量のブレーキです。途中で上限に達した場合は、返ってきた `session_id` で続きを依頼できます。
- ツール呼び出しをキャンセルすると裏の `claude` プロセスも止まります。止めずに放置すると、その呼び出し分の探索は課金対象になります。
- `fable_status` はローカル診断だけなので無料です。セットアップ確認にはまずこれを使ってください。
- 実費は Fable 応答末尾の `cost` と Anthropic Console の Usage 画面で確認してください。

## プライバシーと安全性

Fable は常に Claude Code の**プランモード（読み取り専用）**で起動されるため、リポジトリの探索はできますが、ファイルの作成・変更・削除や状態を変えるコマンドの実行はできません。コードを変更するのは常にホスト側 (Codex) です。

ただし「読み取り専用」は「秘密情報を読まない」という意味ではありません。Fable は設計に必要だと判断したローカルファイルを読めるため、`.env`、秘密鍵、顧客データ、未公開資料が同じプロジェクト内や参照可能な場所にある場合は、利用前に除外・移動・権限設定をしてください。

`ANTHROPIC_API_KEY` を使う場合、プロンプト、読まれたファイル内容、Fable の出力は Anthropic API に送信されます。Fable 5 は通常の API データ保持ポリシーに従います。Zero Data Retention 契約や組織ポリシーが必要な環境では、導入前に Anthropic Console / 契約条件を確認してください。

この MCP は `claude -p --permission-mode plan` を起動するだけで、独自にファイル内容を外部へ送信したり保存したりしません。ローカルに保存するのは `.fable/last-plan.md` と `.fable-loop/` の状態ファイルだけです。
