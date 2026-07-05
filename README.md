# fable-mcp

[![CI](https://github.com/taiyuhiga/fable-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/taiyuhiga/fable-mcp/actions/workflows/ci.yml)

**Claude Fable 5 を「設計・深い推論役」として OpenAI Codex から使うための MCP サーバー。**

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

## 重要: Claude のサブスクリプションは不要です

- Claude Code CLI は**無料のツール**です。課金は「どの認証情報で動かすか」で決まります。
- `ANTHROPIC_API_KEY` を設定すれば、Fable 5 の呼び出しはすべて **Anthropic API の従量課金**（入力 $10 / 出力 $50 per 100万トークン）になります。サブスクに入ったことがない人でも使えます。
- コスト目安: 設計プラン1回 = リポジトリ探索込みで **$1〜5 程度**。軽い質問なら数十セント。実費は [Anthropic Console](https://console.anthropic.com) の Usage 画面で確認できます。

対応OS: **macOS / Linux / Windows**

## セットアップ

### 楽な方法: AIエージェントに任せる

Codex や Claude Code などのAIエージェントに、以下をそのまま貼ってください：

> https://github.com/taiyuhiga/fable-mcp を README の手順どおりにセットアップして。
> ①Claude Code CLI がなければ `npm i -g @anthropic-ai/claude-code` でインストール、
> ②リポジトリを clone して npm install、
> ③`~/.codex/config.toml` に `[mcp_servers.fable]` を追記（args のパスは clone 先の絶対パス、`tool_timeout_sec = 1200` を忘れずに）、
> ④README の AGENTS.md スニペットを `~/.codex/AGENTS.md` に追記。
> ANTHROPIC_API_KEY は後で自分で入れるので、コメントアウトのまま置いておいて。
> 終わったら `codex mcp list` に fable が出ることを確認して。

エージェントの作業が終わったら、人間がやるのは2つだけです：
1. [Anthropic Console](https://console.anthropic.com) でAPIキーを作成・チャージし、config.toml の `ANTHROPIC_API_KEY` のコメントを外して貼る（これだけはエージェントにはできません）
2. Codex アプリを再起動して「Fable5に聞いて：このリポジトリ何？」で動作確認

### 手動でやる場合

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

- **Plan モードでは常に Fable がプランを作る**: Plan モードに入ったら、
  ユーザーが Fable に言及していなくても必ず fable_plan を呼び、返ってきた
  プラン全文をそのままプランとして提示する (Plan モードに入ること自体が
  「重い設計を頼みたい」という意思表示)。「Fable なしで」と言われたときだけ
  自分でプランする。
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
| `fable_plan` | 実装前の設計。Fable がリポジトリを読み取り専用で探索し、実装プランを返す。`loop_threshold` を渡すと受け入れ基準付きプラン＋品質ループ初期化 |
| `fable_ask` | 深い推論が必要な質問・相談。「Fable5に聞いて」のルーティング先 |
| `fable_review` | 実装後のレビュー。git diff を読んでバグ・設計乖離・簡素化を指摘。品質ループ中は採点係になり、スコアが state.json に機械記録される |

3ツールとも応答末尾に `session_id` が付き、次回それを渡すと同じ会話の続きとしてフォローアップできます。

## 環境変数

| 変数 | デフォルト | 説明 |
|---|---|---|
| `ANTHROPIC_API_KEY` | (なし) | API 従量課金で動かすためのキー。未設定なら claude CLI の現在のログイン認証で動く |
| `FABLE_MODEL` | `claude-fable-5` | 使うモデル。コストを抑えたければ `claude-opus-4-8` 等に変更可 |
| `FABLE_EFFORT` | (モデルのデフォルト = high 相当) | 推論の深さのデフォルト: `low` / `medium` / `high` / `xhigh` / `max`。各ツールの `effort` 引数で呼び出しごとに上書き可（「Fable5にmaxで考えさせて」のように言えば Codex が渡す） |
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

## 安全性

Fable は常に Claude Code の**プランモード（読み取り専用）**で起動されるため、リポジトリの探索はできますが、ファイルの作成・変更・削除や状態を変えるコマンドの実行はできません。コードを変更するのは常にホスト側 (Codex) です。
