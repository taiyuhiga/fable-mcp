param(
  [switch]$DryRun,
  [string]$Ref = "v0.9.1",
  [switch]$NoClaudeInstall,
  [switch]$InstallClaudeRuntime,
  [ValidateSet("auto", "login", "api")][string]$Auth = "auto",
  [switch]$NoApiKey,
  [switch]$SkipAuth,
  [switch]$SkipLiveCheck
)

$ErrorActionPreference = "Stop"
$Repo = "sam-mountainman/fable-mcp"
$Plugin = "fable-mcp@fable-mcp"
$HelperDir = $PSScriptRoot
$HelperTemp = $null

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
    if ($SkipAuth) {
      Write-Warning "claude CLI not found and automatic installation was disabled."
      return
    }
    throw "Fable calls require Claude Code CLI. Re-run without -NoClaudeInstall or use -SkipAuth for an intentionally incomplete setup."
  }

  if (-not (Test-Command "npm")) {
    throw "npm not found, so Claude Code CLI cannot be installed automatically. Install Node.js/npm and retry."
  }

  Write-Step "Installing Claude Code CLI"
  try {
    Invoke-Step "npm" @("install", "-g", "@anthropic-ai/claude-code")
    if (Test-Command "claude") {
      Write-Host "Claude Code CLI OK: $(& claude --version)"
    } else {
      throw "npm install finished, but 'claude' is still not on PATH. Open a new terminal and retry, or set FABLE_CLAUDE_BIN."
    }
  } catch {
    throw "Claude Code CLI install failed: $($_.Exception.Message)"
  }
}

function Prepare-Helpers {
  if ($SkipAuth) { return }
  $verify = if ($PSScriptRoot) { Join-Path $PSScriptRoot "scripts/verify-claude-auth.mjs" } else { "" }
  $configure = if ($PSScriptRoot) { Join-Path $PSScriptRoot "scripts/configure-codex-plugin-env.mjs" } else { "" }
  if ($verify -and (Test-Path $verify) -and (Test-Path $configure)) {
    $script:HelperDir = Join-Path $PSScriptRoot "scripts"
    return
  }

  $script:HelperTemp = Join-Path ([IO.Path]::GetTempPath()) ("fable-mcp-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $script:HelperTemp | Out-Null
  $script:HelperDir = $script:HelperTemp
  Invoke-WebRequest -UseBasicParsing "https://raw.githubusercontent.com/$Repo/$Ref/scripts/verify-claude-auth.mjs" -OutFile (Join-Path $script:HelperDir "verify-claude-auth.mjs")
  Invoke-WebRequest -UseBasicParsing "https://raw.githubusercontent.com/$Repo/$Ref/scripts/configure-codex-plugin-env.mjs" -OutFile (Join-Path $script:HelperDir "configure-codex-plugin-env.mjs")
}

function Install-Plugin {
  Write-Step "Installing fable-mcp Codex plugin from $Repo@$Ref"
  # Marketplace upgrade preserves an old pinned ref. Remove stale registrations
  # first so the requested release is installed even after v0.8.x.
  try {
    Invoke-Step "codex" @("plugin", "remove", $Plugin)
  } catch {
    Write-Host "No existing fable-mcp plugin registration to remove."
  }
  try {
    Invoke-Step "codex" @("plugin", "marketplace", "remove", "fable-mcp")
  } catch {
    Write-Host "No existing fable-mcp marketplace registration to remove."
  }
  Invoke-Step "codex" @("plugin", "marketplace", "add", $Repo, "--ref", $Ref)
  Invoke-Step "codex" @("plugin", "add", $Plugin)
}

function Configure-Auth {
  if ($DryRun) {
    return
  }
  if ($SkipAuth) {
    Write-Warning "Authentication was skipped explicitly. Fable calls are not guaranteed to work."
    return
  }

  $mode = if ($NoApiKey) { "login" } else { $Auth }
  $apiKey = $env:ANTHROPIC_API_KEY
  if ($mode -eq "auto") {
    Write-Step "Choose Claude authentication"
    Write-Host "1) Claude account login (recommended; opens browser)"
    Write-Host "2) Anthropic API key (metered billing; subscription-independent)"
    $choice = Read-Host "Select [1/2, default 1]"
    $mode = if ($choice -eq "2") { "api" } else { "login" }
  }

  $verify = Join-Path $HelperDir "verify-claude-auth.mjs"
  $liveArgs = if ($SkipLiveCheck) { @("--skip-live-check") } else { @() }

  if ($mode -eq "login") {
    Write-Step "Verifying Claude account authentication"
    $previousApiKey = $env:ANTHROPIC_API_KEY
    try {
      Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
      Invoke-Step "node" (@($verify, "--mode", "login") + $liveArgs)
    } finally {
      if ([string]::IsNullOrWhiteSpace($previousApiKey)) {
        Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
      } else {
        $env:ANTHROPIC_API_KEY = $previousApiKey
      }
    }
    $codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
    Invoke-Step "node" @((Join-Path $HelperDir "configure-codex-plugin-env.mjs"), "--config", (Join-Path $codexHome "config.toml"), "--remove-api-key")
    return
  }

  if ($mode -ne "api") { throw "Unsupported authentication mode: $mode" }
  if ([string]::IsNullOrWhiteSpace($apiKey)) {
    $secure = Read-Host "Paste ANTHROPIC_API_KEY (input hidden)" -AsSecureString
    $apiKey = ConvertTo-PlainText $secure
  }
  if ([string]::IsNullOrWhiteSpace($apiKey)) { throw "API key authentication was selected, but no key was provided." }

  Write-Step "Verifying Anthropic API authentication"
  $previous = $env:ANTHROPIC_API_KEY
  try {
    $env:ANTHROPIC_API_KEY = $apiKey
    Invoke-Step "node" (@($verify, "--mode", "api") + $liveArgs)
  } finally {
    $env:ANTHROPIC_API_KEY = $previous
  }

  $codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
  $config = Join-Path $codexHome "config.toml"
  $apiKey | & node (Join-Path $HelperDir "configure-codex-plugin-env.mjs") --config $config --effort medium
  if ($LASTEXITCODE -ne 0) { throw "Could not persist ANTHROPIC_API_KEY in Codex config." }
  $apiKey = $null
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
- Codex Plugin/MCP: registers the fable MCP server for Codex.
- Claude Code CLI runtime: installed automatically if it was missing.
- Authentication: configured and verified unless -SkipAuth was passed.

1. Restart the Codex app.
2. If Codex asks whether to trust the bundled Stop hook, approve it.
3. In a new Codex thread, ask:

   Fableの状態を確認して

The installer only reports success after Claude authentication and a minimal Fable access check,
unless an explicit skip option was used.
"@
}

Write-PreflightWarnings
Ensure-Node
Ensure-Codex
Ensure-Claude
Install-Plugin
Prepare-Helpers
Configure-Auth
Print-NextSteps
if ($HelperTemp -and (Test-Path $HelperTemp)) { Remove-Item -Recurse -Force $HelperTemp }
