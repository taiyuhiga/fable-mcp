# fable-mcp

[![CI](https://github.com/taiyuhiga/fable-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/taiyuhiga/fable-mcp/actions/workflows/ci.yml)

**Claude Fable 5 を「設計・深い推論役」として Codex / Cursor / Antigravity から使うための MCP サーバー。**

English README: [README.en.md](README.en.md)

短いセットアップ手順だけ見たい場合: [SETUP.md](SETUP.md)

## 初心者向け: この一文だけでセットアップ

一番簡単なセットアップ方法は、使いたいAIエージェント本人に次の一文だけ貼ることです。GitHub を clone したり、MCP を手入力したりする必要はありません。

```text
https://github.com/taiyuhiga/fable-mcp をセットアップして。
```

この一文を受け取ったAIエージェントは、このREADMEとリポジトリ内の `AGENTS.md` をセットアップ契約として読み、**自分自身のクライアントだけ**をセットアップしてください。Codexで受け取ったならCodexだけ、Cursorで受け取ったならCursorだけ、Antigravityで受け取ったならAntigravityだけです。

1. Node.js 18+ があるか確認
2. 依頼を受けたクライアント用の fable-mcp plugin/MCP だけをインストール
3. Claude Code CLI (`claude`) は Fable を呼ぶランタイムとして存在確認だけ行う。ユーザーが明示しない限り自動インストールしない
4. ANTHROPIC_API_KEY が必要なところだけ私に聞く
5. 最後に「Fableの状態を確認して」と試せる状態にする

このリポジトリは Codex Plugin、Cursor Plugin、Antigravity Plugin を同梱します。ただし、セットアップ時に他クライアントへ勝手に横展開しません。Claude Code CLI は Fable を headless で呼ぶための任意ランタイムであり、Claude Codeという別エージェントをセットアップするものではありません。

Codex をターミナルで自分でセットアップしたい場合は、OS に合わせてどちらか1つを使います。

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/taiyuhiga/fable-mcp/v0.8.2/install.sh | bash
```

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/taiyuhiga/fable-mcp/v0.8.2/install.ps1 | iex
```

installer は Node.js / Codex CLI / Claude Code CLIランタイムを確認し、Codex Plugin を追加します。Claude Code CLIは、明示フラグを渡さない限り自動インストールしません。API キーは対話で聞かれたときだけ貼ってください。**Codex アプリを閉じてから installer を実行**し、終わったら Codex アプリを再起動して `Fableの状態を確認して` と送ります。

Cursor / Antigravity で手動実行する場合:

```sh
git clone https://github.com/taiyuhiga/fable-mcp.git
cd fable-mcp
npm install
npm run build

# Cursorだけをセットアップ
node scripts/run-python.mjs scripts/setup-current-agent.py --client cursor

# Antigravityだけをセットアップ
node scripts/run-python.mjs scripts/setup-current-agent.py --client antigravity
```

ホストAIエージェント (実装役) の上に Fable 5 (アーキテクト役) を乗せる2エージェント構成を、Codex / Cursor / Antigravity 上で実現します。

```
あなた ──> Codex / Cursor / Antigravity (実装役)
              │  設計が必要なとき MCP ツールを呼ぶ
              ▼
          fable-mcp ──> claude -p --model claude-fable-5 (読み取り専用プランモード)
                            │  リポジトリを探索して深く推論
                            ▼
                        実装プランをホストAIに返す → ホストAIが実装
```

## Claude Code 側で何が起きるか

fable-mcp は Fable 5 を直接実装役にしません。MCP ツールが呼ばれるたびに、裏で次の形の Claude Code headless プロセスを起動します:

```sh
claude -p --model claude-fable-5 --permission-mode plan --output-format stream-json --verbose
```

- `--permission-mode plan` なので、Fable はローカルプロジェクトを読んで設計・レビューできますが、ファイル編集はできません。
- 実装、テスト、コミット、リリースはホストAIエージェント側が行います。
- 各呼び出しは基本的に新しい `claude` プロセスです。続きの壁打ちは応答末尾の `session_id` を次回の `session_id` に渡すと、Claude Code の `--resume` で同じ会話として続けます。
- `ANTHROPIC_API_KEY` があれば Anthropic API の従量課金、なければ `claude` CLI の現在のログイン認証を使います。

## 重要: Claude のサブスクリプションは不要です

- Claude Code CLI は**無料のツール**です。課金は「どの認証情報で動かすか」で決まります。
- `ANTHROPIC_API_KEY` を設定すれば、Fable 5 の呼び出しはすべて **Anthropic API の従量課金**（入力 $10 / 出力 $50 per 100万トークン）になります。サブスクに入ったことがない人でも使えます。
- `ANTHROPIC_API_KEY` を設定しない場合は、`claude` CLI の現在のログイン認証で動きます。どちらの認証で課金されているかは `fable_status` で確認できます。
- コスト目安: 設計プラン1回 = リポジトリ探索込みで **$1〜5 程度**。軽い質問なら数十セント。実費は [Anthropic Console](https://console.anthropic.com) の Usage 画面で確認してください。
- 安く試すなら `FABLE_EFFORT=medium`、本気の設計だけ `effort=max` / `xhigh` を呼び出しごとに指定する運用が安全です。

対応OS: **macOS / Linux / Windows**

## セットアップ

依頼を受けたクライアントだけをセットアップしてください。Codex用、Cursor用、Antigravity用の配布物は分かれています。

### 1. 前提

- Node.js 18+
- Claude Code CLI（Fable呼び出し用ランタイム・任意）: `npm i -g @anthropic-ai/claude-code`
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

### 2. Codex に入れる場合

```sh
codex plugin marketplace add taiyuhiga/fable-mcp --ref v0.8.2
codex plugin add fable-mcp@fable-mcp
```

その後 Codex アプリを再起動してください。初回に同梱 Stop hook の信頼確認が出たら承認します。

最新版を追いかけたい開発用途では `--ref main` または `--ref` なしでも入れられますが、他ユーザーに配る手順はタグ固定を推奨します。

> うまく marketplace から入らない場合は、このリポジトリを clone して `codex plugin marketplace add /ABSOLUTE/PATH/TO/fable-mcp` → `codex plugin add fable-mcp@fable-mcp` を使ってください。

### 3. Cursor に入れる場合

Cursor Plugin 用の配布物は `.cursor-plugin/marketplace.json` と `plugins/fable-mcp-cursor/` にあります。CursorでこのURLを渡してセットアップを頼んだ場合、Cursorだけを対象に次を実行します:

```sh
node scripts/run-python.mjs scripts/setup-current-agent.py --client cursor
```

このスクリプトは `~/.cursor/plugins/local/fable-mcp` にCursor用pluginを配置し、Cursor用の `~/.cursor/mcp.json` に `fable` だけを追加/更新します。CodexやAntigravityの設定には触りません。

### 4. Antigravity に入れる場合

Antigravity Plugin 用の配布物は `plugins/fable-mcp-antigravity/` にあります。AntigravityでこのURLを渡してセットアップを頼んだ場合、Antigravityだけを対象に次を実行します:

```sh
node scripts/run-python.mjs scripts/setup-current-agent.py --client antigravity
```

このスクリプトは `~/.gemini/config/plugins/fable-mcp` にAntigravity用pluginを配置し、plugin内の `mcp_config.json` を絶対パスに更新します。CodexやCursorの設定には触りません。

### Codexの手動設定から plugin へ移行する場合

Codexで過去に手動MCPで入れていた場合は、plugin 導入後に重複登録を消してください。残っていると **MCPサーバー二重起動** や **Stop hook 二重発火** が起きます。

- `~/.codex/config.toml` の `[mcp_servers.fable]`
- `~/.codex/hooks.json` の `fable-loop-stop.mjs`
- `~/.codex/AGENTS.md` に手で貼った古い Fable ルーティング指示

`fable_status` はこれらの重複候補をローカル診断で表示します。

### 5. 動作確認

セットアップしたAIエージェントで新規スレッドを開き、次を試します:

```text
Fableの状態を確認して
```

`fable_status` がローカル診断を返せば、MCP の接続は成功です。これは Fable 本体を呼ばないため API コストは発生しません。

次に、実際の Fable 呼び出しを試します:

```text
Fable5に聞いて: このリポジトリは何をするもの?
```

Codex Plan mode では、Fable と明示しなくても `fable_plan` が起動します。「Fableなしで」と言えば Codex だけでプランします。

`fable_plan` は、Codex の Plan UI が要約・再構成してしまう場合に備えて、Fable のプラン原文を常にプロジェクト内の `.fable/last-plan.md` に保存します。このファイルが正本です。

## 詳細セットアップ / 手動MCPフォールバック

### 楽な方法: 使いたいAIエージェント本人に任せる

Codex / Cursor / Antigravity のうち、使いたいAIエージェント本人に以下をそのまま貼ってください：

> https://github.com/taiyuhiga/fable-mcp をセットアップして。

この一文だけで、README冒頭と `AGENTS.md` の自動セットアップ契約に従って、依頼を受けたクライアントだけを設定します。

- Codexで依頼した場合: Codex Plugin だけを入れる
- Cursorで依頼した場合: Cursor Plugin / Cursor MCP だけを入れる
- Antigravityで依頼した場合: Antigravity Plugin だけを入れる

Claude Code CLI は Fable呼び出し用ランタイムとして存在確認だけ行います。ユーザーが明示しない限り、自動インストールしません。

エージェントの作業が終わったら、人間がやるのは2つだけです：
1. [Anthropic Console](https://console.anthropic.com) でAPIキーを作成・チャージし、聞かれたときだけ貼る（これだけはエージェントにはできません）
2. セットアップしたAIエージェントを再起動して「Fableの状態を確認して」で動作確認

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
  Fable が作った受け入れ基準をユーザーに見せ、承認されたら fable_loop_approve
  を呼ぶ。実装後に fable_review を呼ぶと採点され、未達ならターン終了時に
  Stop フックが差し戻すので、feedback に従って修正し再度 fable_review を呼ぶ。
  中断は fable_loop_abort、best版への復元は fable_loop_restore_best を使う。
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
| `fable_plan` | 実装前の設計。Fable がリポジトリを読み取り専用で探索し、実装プランを返す。`loop_threshold` を渡すと受け入れ基準付きプラン＋承認待ち品質ループを初期化 |
| `fable_ask` | 深い推論が必要な質問・相談。「Fable5に聞いて」のルーティング先 |
| `fable_review` | 実装後のレビュー。git diff を読んでバグ・設計乖離・簡素化を指摘。品質ループ中は採点係になり、スコア・累計コスト・best snapshot が state.json に機械記録される |
| `fable_loop_approve` | 品質ループの受け入れ基準をユーザー承認後に implementing phase で active 化する。無料 |
| `fable_loop_abort` | 品質ループを安全に中断する。state.json を直接編集しないための正式手段。無料 |
| `fable_loop_restore_best` | 最高スコア時点の git snapshot を write_targets または指定 paths に限定して復元する。無料 |

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
   → Fable がプラン + 受け入れ基準 (採点表) を出し、承認待ちループを作る
Codex が受け入れ基準をユーザーに提示
   → ユーザー承認後に fable_loop_approve
Codex が実装
   → fable_review を呼ぶ
Fable (採点係) が基準に照らして絶対評価
   → スコア・累計コスト・best snapshot は server が機械記録 (Codex の手を通らない)
ターン終了 → Stop フック (進行係) が整数比較
   ├─ score < 合格点 かつ 周回 < 上限 → decision:block で差し戻し (feedback を読んで修正→再採点)
   └─ 合格 or 上限 → 静かに終了
```

Stop hook は通常 `phase="eval"` のときだけ続行/終了を判定します。基準承認直後は差し戻しませんが、実装変更が入った後に `fable_review` を呼ばずターンを終えようとした場合だけ「レビューが必要」として差し戻します。

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
├── current.json
└── sessions/
    └── <loop_id>/
        ├── state.json    周回数・スコア・合格点・累計コスト・best snapshot
        ├── task.md       元の依頼文 (毎周読み直して目標ドリフトを防ぐ)
        ├── criteria.md   受け入れ基準 (ユーザー承認後に固定)
        └── turns/        周回ごとの採点記録 turn-XXX-eval.json
```

v0.6 以前の `.fable-loop/state.json` 形式も互換で読みます。新規ループは `loop_id` ごとの session に分かれるため、同じリポジトリ内で複数ループの状態を分離できます。Stop hook は通常 `current.json` のループを進行対象にします。

### 設計上の性質 (なぜズルできないか)

- **採点係は毎回まっさら**: fable-mcp は呼び出しごとに新プロセスなので、採点係は実装時の会話・言い訳を一切見ない
- **スコアは実装役の手を通らない**: Fable の採点JSON → server の機械パース → state.json。実装役 (Codex) がスコアを書く経路がない
- **続行判定は整数比較**: Stop フックは `score >= threshold || iteration >= max` を比べるだけ。「もう十分でしょう」が介在しない
- **phase gate**: Stop hook は採点直後の `phase="eval"` 以外では動かない。承認直後や実装修正中の早すぎる差し戻しを防ぐ
- **レビュー呼び忘れを検出**: `phase="implementing"` でも、承認時/前回差し戻し時の作業ツリーから実装ファイルが変わっているのに `fable_review` が未実行なら、Stop hook が `fable_review` を要求して品質ループの静かな停止を防ぐ
- **採点軸は人間承認後に固定**: 基準は Fable が作り、ユーザー承認後に固定する。基準のズレに忠実に収束する Goodhart 問題を減らす
- **中断は正式ツールで行う**: `fable_loop_abort` が active=false と理由を記録する。state.json を直接編集しない
- **best版を保全**: git リポジトリでは各採点時に hidden ref (`refs/fable-loop/<loop_id>/...`) へ snapshot を取り、最高スコア版は `fable_loop_restore_best` で復元できる
- **重要な採点は合議可能**: `fable_review` に `evaluator_mode: "ensemble"` と `review_repeats` (最大3) を渡すと独立採点の中央値で判定する。コストが増えるのでデフォルトは1回
- **停滞と衝突を警告**: UserPromptSubmit hook が active loop の stale 状態や write_targets 衝突をローカルで警告する
- 制約: 採点係は読み取り専用モードで動くため、状態を変えるテストコマンドは実行できないことがある (その場合はコードとテスト定義を読んで判定し、feedback に明記される)

## 実行中の挙動

- **進捗が見える**: Fable がファイルを読んだりコマンドを実行するたびに MCP 進捗通知が流れます（対応クライアントの場合）。長い推論中も20秒ごとに生存確認が届き、rate limit event が来た場合は「レート制限中」と表示します
- **キャンセルで課金も止まる**: クライアント側でツール呼び出しを中断すると、裏の Fable プロセスも即座に停止します
- **コスト上限**: `FABLE_MAX_TURNS`（デフォルト60ターン）で1回あたりの探索量に上限がかかります

## 受け入れ検証

Fable API を使わず、MCP ツール・phase gate・Stop hook・UserPromptSubmit watchdog を検証する smoke harness を同梱しています:

```sh
npm run smoke
npm run codex-smoke
```

`npm run codex-smoke` は隔離した `CODEX_HOME` で `marketplace add → plugin add → codex mcp list` を確認します。Codex CLI がない環境では skip します。

Codex 本体まで含めた実走確認は、必要なときだけ次を実行してください。デフォルトでは Codex モデルも Fable も呼びません。

```sh
npm run live-trial
npm run live-trial -- --allow-model-call
```

`--allow-model-call` は Codex に `fable_status` だけを呼ばせる検証です。Fable API は使いませんが、Codex/OpenAI 側のモデル呼び出しは発生します。リリース前のフル実走確認では、Codexの新規スレッドで `fable_plan → criteria提示 → fable_loop_approve → 実装 → fable_review → Stop hook` を1回通してください。これは実Fable呼び出しなので API コストが発生します。

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
