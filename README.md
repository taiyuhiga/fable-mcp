# fable-mcp

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

## セットアップ

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

### 4. Codex に「いつ Fable を呼ぶか」を教える — `~/.codex/AGENTS.md` に追記

```markdown
# Fable 5 オーケストレーション (fable-mcp)

- 複数ファイルにまたがる実装・新機能・アーキテクチャ判断を伴うタスクは、
  実装を始める前に必ず `fable_plan` ツールにタスクの完全な仕様とプロジェクト
  ルート (cwd) を渡し、返ってきたプランに従って実装する。
- プランに疑問があれば、応答末尾の session_id を付けて追加質問する。
- ユーザーが「Fable」「Fable5」「フェイブル」に言及したら
  (例:「Fable5に聞いて」)、その内容を fable_ask / fable_plan に渡す。
- 大きな実装が完了したら fable_review でレビューを受ける (任意)。
- タイポ修正や1ファイルの小さな変更は Fable を呼ばず直接実装する。
- Fable の応答には数分かかることがある。待つこと。
```

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
| `fable_plan` | 実装前の設計。Fable がリポジトリを読み取り専用で探索し、実装プランを返す |
| `fable_ask` | 深い推論が必要な質問・相談。「Fable5に聞いて」のルーティング先 |
| `fable_review` | 実装後のレビュー。git diff を読んでバグ・設計乖離・簡素化を指摘 |

3ツールとも応答末尾に `session_id` が付き、次回それを渡すと同じ会話の続きとしてフォローアップできます。

## 環境変数

| 変数 | デフォルト | 説明 |
|---|---|---|
| `ANTHROPIC_API_KEY` | (なし) | API 従量課金で動かすためのキー。未設定なら claude CLI の現在のログイン認証で動く |
| `FABLE_MODEL` | `claude-fable-5` | 使うモデル。コストを抑えたければ `claude-opus-4-8` 等に変更可 |
| `FABLE_TIMEOUT_MS` | `1200000` (20分) | 1回の呼び出しのタイムアウト |
| `FABLE_CLAUDE_BIN` | 自動解決 | claude CLI のフルパス (PATH で見つからない場合) |

## 安全性

Fable は常に Claude Code の**プランモード（読み取り専用）**で起動されるため、リポジトリの探索はできますが、ファイルの作成・変更・削除や状態を変えるコマンドの実行はできません。コードを変更するのは常にホスト側 (Codex) です。
