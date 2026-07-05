param(
  [switch]$DryRun,
  [string]$Ref = "v0.7.7",
  [switch]$NoClaudeInstall,
  [switch]$NoApiKey
)

$ErrorActionPreference = "Stop"
$Repo = "taiyuhiga/fable-mcp"
$Plugin = "fable-mcp@fable-mcp"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message"
}

function Test-Command {
  param([string]$Name)
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Invoke-Step {
  param(
    [string]$File,
    [string[]]$Arguments
  )

  if ($DryRun) {
    Write-Host ("+ {0} {1}" -f $File, ($Arguments -join " "))
    return
  }

  & $File @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$File exited with code $LASTEXITCODE"
  }
}

function Write-PreflightWarnings {
  Write-Step "Preflight warnings"
  Write-Warning "Close the Codex desktop app before running this installer. If Codex is open, it may overwrite config.toml when it exits."

  $codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
  $config = Join-Path $codexHome "config.toml"
  $hooks = Join-Path $codexHome "hooks.json"
  $agents = Join-Path $codexHome "AGENTS.md"

  if ((Test-Path $config) -and ((Get-Content -Raw -Path $config) -match '(?m)^\s*\[mcp_servers\.fable\]\s*$')) {
    Write-Warning "Manual [mcp_servers.fable] already exists in $config. Remove it after plugin install to avoid double MCP registration."
  }
  if ((Test-Path $hooks) -and ((Get-Content -Raw -Path $hooks).Contains("fable-loop-stop.mjs"))) {
    Write-Warning "Manual fable-loop Stop hook already exists in $hooks. Remove it after plugin install to avoid double hook execution."
  }
  if ((Test-Path $agents) -and ((Get-Content -Raw -Path $agents) -match 'Fable 5 Orchestration|Fable 5 オーケストレーション|fable_plan|fable_review')) {
    Write-Warning "Global AGENTS.md appears to contain Fable routing rules. Prefer the plugin-bundled rules to avoid stale or duplicated instructions."
  }
}

function ConvertTo-PlainText {
  param([securestring]$Secure)
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
}

function Escape-TomlString {
  param([string]$Value)
  return $Value.Replace("\", "\\").Replace('"', '\"')
}

function Ensure-Node {
  Write-Step "Checking Node.js"
  if (-not (Test-Command "node")) {
    throw "Node.js 18+ is required. Install it from https://nodejs.org, then run this installer again."
  }

  $major = [int](& node -p "Number(process.versions.node.split('.')[0])")
  if ($major -lt 18) {
    $version = & node --version
    throw "Node.js 18+ is required. Current: $version"
  }
  Write-Host "Node.js OK: $(& node --version)"
}

function Ensure-Codex {
  Write-Step "Checking Codex CLI"
  if (-not (Test-Command "codex")) {
    throw "The codex CLI was not found on PATH. Install/open Codex first, then run this installer from a terminal where 'codex' works."
  }
  try {
    Write-Host "Codex CLI OK: $(& codex --version)"
  } catch {
    Write-Host "Codex CLI OK"
  }
}

function Ensure-Claude {
  Write-Step "Checking Claude Code CLI"
  if (Test-Command "claude") {
    try {
      Write-Host "Claude Code CLI OK: $(& claude --version)"
    } catch {
      Write-Host "Claude Code CLI OK"
    }
    return
  }

  if ($NoClaudeInstall) {
    Write-Warning "claude CLI not found. Install later with: npm i -g @anthropic-ai/claude-code"
    return
  }

  if (-not (Test-Command "npm")) {
    Write-Warning "npm not found, so Claude Code CLI cannot be installed automatically. Install it later with: npm i -g @anthropic-ai/claude-code"
    return
  }

  Write-Step "Installing Claude Code CLI"
  try {
    Invoke-Step "npm" @("install", "-g", "@anthropic-ai/claude-code")
    if (Test-Command "claude") {
      Write-Host "Claude Code CLI OK: $(& claude --version)"
    } else {
      Write-Warning "npm install finished, but 'claude' is still not on PATH. Open a new terminal or set FABLE_CLAUDE_BIN."
    }
  } catch {
    Write-Warning "Claude Code CLI install failed. Install manually with: npm i -g @anthropic-ai/claude-code"
  }
}

function Install-Plugin {
  Write-Step "Installing fable-mcp Codex plugin from $Repo@$Ref"
  try {
    Invoke-Step "codex" @("plugin", "marketplace", "add", $Repo, "--ref", $Ref)
  } catch {
    Write-Warning "marketplace add failed, trying marketplace upgrade for existing source"
    try {
      Invoke-Step "codex" @("plugin", "marketplace", "upgrade", "fable-mcp")
    } catch {
      Write-Warning "marketplace upgrade also failed; continuing to plugin install"
    }
  }
  Invoke-Step "codex" @("plugin", "add", $Plugin)
}

function Configure-ApiKey {
  if ($NoApiKey -or $DryRun) {
    return
  }

  Write-Step "Optional Anthropic API key setup"
  $secure = Read-Host "Paste ANTHROPIC_API_KEY (leave blank to use your current claude CLI login/session)" -AsSecureString
  $apiKey = ConvertTo-PlainText $secure
  if ([string]::IsNullOrWhiteSpace($apiKey)) {
    Write-Host "No API key written. If needed, run 'claude' login or add ANTHROPIC_API_KEY later."
    return
  }

  $codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
  $config = Join-Path $codexHome "config.toml"
  $table = '[plugins."fable-mcp@fable-mcp".mcp_servers.fable.env]'

  New-Item -ItemType Directory -Force -Path $codexHome | Out-Null
  if (-not (Test-Path $config)) {
    New-Item -ItemType File -Path $config | Out-Null
  }

  $content = Get-Content -Raw -Path $config
  if ($content -split "`r?`n" | Where-Object { $_ -eq $table }) {
    Write-Warning "fable-mcp plugin env table already exists in $config. Not overwriting it."
    Write-Host "Make sure it contains ANTHROPIC_API_KEY and optionally FABLE_EFFORT."
    return
  }

  Copy-Item $config "$config.bak.$(Get-Date -Format yyyyMMddHHmmss)"
  $escaped = Escape-TomlString $apiKey
  Add-Content -Path $config -Value @"

$table
ANTHROPIC_API_KEY = "$escaped"
FABLE_EFFORT = "medium"
"@
  Write-Host "Wrote plugin env to $config"
}

function Print-NextSteps {
  Write-Step "Done"
  try {
    Invoke-Step "codex" @("mcp", "list")
  } catch {
    Write-Warning "Could not run 'codex mcp list'. Restart Codex and check from the app."
  }

  Write-Host @"

Next steps:
Installed/checked:
- Claude Code CLI: used by fable-mcp to start Fable 5 in headless plan mode.
- Codex Plugin/MCP: registers the fable MCP server for Codex.

1. Restart the Codex app.
2. If Codex asks whether to trust the bundled Stop hook, approve it.
3. In a new Codex thread, ask:

   Fableの状態を確認して

If the status says ANTHROPIC_API_KEY is missing, either add it to ~/.codex/config.toml
or log in/configure the claude CLI.
"@
}

Write-PreflightWarnings
Ensure-Node
Ensure-Codex
Ensure-Claude
Install-Plugin
Configure-ApiKey
Print-NextSteps
