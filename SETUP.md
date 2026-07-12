# fable-mcp セットアップ早見表

使いたいAIエージェント本人に、この1行を貼ってください。

```text
https://github.com/sam-mountainman/fable-mcp をセットアップして。
```

## 重要なルール

- Codexに貼ったら、Codexだけをセットアップします。
- Cursorに貼ったら、Cursorだけをセットアップします。
- Antigravityに貼ったら、Antigravityだけをセットアップします。
- Claude Code CLIはFableを呼ぶためのランタイムです。Claude Codeという別エージェントをセットアップするものではありません。
- `claude` CLIがなければセットアップ中に自動インストールします。
- AskUserQuestionで、1番目の **Claudeアカウントログイン（推奨）** または2番目の **Anthropic APIキー（従量課金）** を選び、認証とFableの最小応答確認まで成功した場合だけセットアップ完了になります。

## 手動で実行する場合

### Codexだけ

macOS / Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/sam-mountainman/fable-mcp/v0.9.1/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/sam-mountainman/fable-mcp/v0.9.1/install.ps1 | iex
```

### Cursorだけ

```sh
git clone https://github.com/sam-mountainman/fable-mcp.git
cd fable-mcp
npm install
npm run build
node scripts/run-python.mjs scripts/setup-current-agent.py --client cursor
```

### Antigravityだけ

```sh
git clone https://github.com/sam-mountainman/fable-mcp.git
cd fable-mcp
npm install
npm run build
node scripts/run-python.mjs scripts/setup-current-agent.py --client antigravity
```

## 動作確認

セットアップしたAIエージェントを再起動して、新しいスレッドで送ります。

```text
Fableの状態を確認して
```

`fable_status` が呼ばれれば接続成功です。これはローカル診断だけなのでAPIコストは発生しません。

実際にFableを呼ぶ確認:

```text
Fable5に聞いて: このリポジトリは何をするもの？
```

## 必要なもの

- Node.js 18+
- Claude Code CLIランタイム（なければインストーラーが自動導入）
- API課金で使う場合だけ `ANTHROPIC_API_KEY`

`ANTHROPIC_API_KEY` を設定しない場合は、`claude` CLIの現在のログイン認証を使います。
