#Requires -Version 5.1
# start-all.ps1 - AgentX Server launcher & dev utilities
# Usage:
#   .\start-all.ps1              # Interactive menu
#   .\start-all.ps1 -Server      # Start server only
#   .\start-all.ps1 -Build       # Build project
#   .\start-all.ps1 -Test        # Run tests
#   .\start-all.ps1 -All         # Build + Server + Chat
#   .\start-all.ps1 -OpenChat    # Start server and open chat page
#   .\start-all.ps1 -OpenAdmin   # Start server and open admin page
#   .\start-all.ps1 -NoAuth      # Start with HTTP auth disabled

param(
  [string]$ListenHost = '127.0.0.1',
  [int]$Port          = 3000,
  [switch]$Restart,
  [switch]$Server,
  [switch]$Build,
  [switch]$Test,
  [switch]$All,
  [switch]$OpenChat,
  [switch]$OpenAdmin,
  [switch]$NoAuth
)

$ErrorActionPreference = 'Stop'
$ProjectDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$HealthUrl  = "http://${ListenHost}:${Port}"
$ChatUrl    = "http://${ListenHost}:${Port}/chat"
$AdminUrl   = "http://${ListenHost}:${Port}/admin"
$LoginUrl   = "http://${ListenHost}:${Port}/"

function Write-Banner {
  param([string]$Text, [string]$Color = 'Cyan')
  $line = '=' * 48
  Write-Host ''
  Write-Host $line -ForegroundColor $Color
  Write-Host "  $Text" -ForegroundColor $Color
  Write-Host $line -ForegroundColor $Color
  Write-Host ''
}

function Test-Prerequisites {
  Write-Host '[check] Node.js...' -ForegroundColor Gray -NoNewline
  try {
    $nodeVer = & node --version 2>&1
    Write-Host " $nodeVer" -ForegroundColor Green
  } catch {
    Write-Host ' NOT FOUND' -ForegroundColor Red
    Write-Host '[ERROR] Install Node.js >= 20 from https://nodejs.org' -ForegroundColor Red
    exit 1
  }

  Write-Host '[check] dist/cli/index.js...' -ForegroundColor Gray -NoNewline
  $distPath = Join-Path $ProjectDir 'dist\cli\index.js'
  if (Test-Path $distPath) {
    Write-Host ' OK' -ForegroundColor Green
  } else {
    Write-Host ' MISSING (run Build first)' -ForegroundColor Yellow
  }
}

function Test-EnvFileHasKey {
  param([string]$Path, [string]$Key)

  if (-not (Test-Path $Path)) {
    return $false
  }

  $pattern = "^\s*$([regex]::Escape($Key))\s*="
  return [bool](Select-String -Path $Path -Pattern $pattern -Quiet)
}

function New-DevJwtSecret {
  $bytes = New-Object byte[] 48
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }
  return [Convert]::ToBase64String($bytes)
}

function New-DevAdminPasswordHash {
  $script = "import('bcryptjs').then(async b => console.log(await b.hash('change-me', 10))).catch(e => { console.error(e); process.exit(1); })"
  $output = & node -e $script 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to generate ADMIN_PASSWORD_HASH: $output"
  }

  $hash = ($output | Select-Object -Last 1).ToString().Trim()
  if ($hash -notmatch '^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$') {
    throw "Generated ADMIN_PASSWORD_HASH is invalid"
  }

  return $hash
}

function Ensure-AuthEnv {
  $envPath = Join-Path $ProjectDir '.env'
  $requiredKeys = @('JWT_SECRET', 'ADMIN_USER', 'ADMIN_PASSWORD_HASH')
  $missingKeys = @($requiredKeys | Where-Object { -not (Test-EnvFileHasKey -Path $envPath -Key $_) })

  if ((Test-Path $envPath) -and $missingKeys.Count -eq 0) {
    return
  }

  $lines = @()
  if (-not (Test-Path $envPath)) {
    Write-Host '[auth] .env not found; creating local development credentials...' -ForegroundColor Yellow
    $lines += '# Auto-created by start-all.ps1 for local development.'
  } else {
    Write-Host "[auth] .env is missing: $($missingKeys -join ', '); appending local development values..." -ForegroundColor Yellow
    $lines += ''
    $lines += '# Added by start-all.ps1 for local development.'
  }

  if ($missingKeys -contains 'JWT_SECRET') {
    $lines += "JWT_SECRET=$(New-DevJwtSecret)"
  }
  if ($missingKeys -contains 'ADMIN_USER') {
    $lines += 'ADMIN_USER=admin'
  }
  if ($missingKeys -contains 'ADMIN_PASSWORD_HASH') {
    $lines += "ADMIN_PASSWORD_HASH=$(New-DevAdminPasswordHash)"
  }

  if (-not (Test-EnvFileHasKey -Path $envPath -Key 'JWT_EXPIRES_IN')) {
    $lines += 'JWT_EXPIRES_IN=24h'
  }
  if (-not (Test-EnvFileHasKey -Path $envPath -Key 'DATA_DIR')) {
    $lines += 'DATA_DIR=./data'
  }
  if (-not (Test-EnvFileHasKey -Path $envPath -Key 'MCP_API_KEY')) {
    $lines += 'MCP_API_KEY=local-dev-mcp-key'
  }

  Add-Content -Path $envPath -Value $lines -Encoding ASCII
  Write-Host '[auth] Login user: admin' -ForegroundColor Green
  Write-Host '[auth] Login password: change-me' -ForegroundColor Green
  Write-Host '[auth] Change these values in .env before using this outside local development.' -ForegroundColor Yellow
}

function Invoke-Build {
  Write-Banner 'Build'
  Push-Location $ProjectDir
  try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "Build failed with exit code $LASTEXITCODE" }
    Write-Host ''
    Write-Host '[OK] Build complete' -ForegroundColor Green
  } finally {
    Pop-Location
  }
}

function Get-ServerPid {
  try {
    $conns = Get-NetTCPConnection -LocalAddress $ListenHost -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($conns) { return $conns[0].OwningProcess }
  } catch {}
  try {
    $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($conns) { return $conns[0].OwningProcess }
  } catch {}
  try {
    $nodes = Get-CimInstance Win32_Process -Filter "name = 'node.exe'" -ErrorAction SilentlyContinue
    foreach ($p in $nodes) {
      $cmd = ($p.CommandLine -replace '"', '' -replace "'", '')
      if ($cmd -match "agentx.*server" -and $cmd -match "--port\s+$Port") {
        return $p.ProcessId
      }
    }
  } catch {}
  return $null
}

function Stop-Server {
  $serverPid = Get-ServerPid
  if (-not $serverPid) {
    Write-Host "[stop] no server on $ListenHost`:$Port" -ForegroundColor Cyan
    return
  }
  Write-Host "[stop] killing PID $serverPid..." -ForegroundColor Yellow
  Stop-Process -Id $serverPid -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  if ((Get-ServerPid) -eq $null) {
    Write-Host '[stop] done' -ForegroundColor Green
  } else {
    Write-Host '[stop] failed - port still in use' -ForegroundColor Red
    exit 1
  }
}

function Start-Server {
  Write-Banner "AgentX Server"
  Write-Host "  Host  : $ListenHost"
  Write-Host "  Port  : $Port"
  Write-Host "  Health: $HealthUrl"
  Write-Host "  Dir   : $ProjectDir"
  Write-Host ''

  $distPath = Join-Path $ProjectDir 'dist\cli\index.js'
  if (-not (Test-Path $distPath)) {
    Write-Host '[ERROR] dist/cli/index.js not found. Run: .\start-all.ps1 -Build' -ForegroundColor Red
    exit 1
  }

  if ($Restart -or (Get-ServerPid)) {
    Stop-Server
  }

  if ($NoAuth) {
    Write-Host '[auth] HTTP authentication disabled by -NoAuth' -ForegroundColor Yellow
  } else {
    Ensure-AuthEnv
  }

  $windowTitle = "AgentX Server ($ListenHost`:$Port)"
  $cmdLine = "node `"$ProjectDir\bin\agentx`" server --host $ListenHost --port $Port"
  if ($NoAuth) {
    $cmdLine += ' --no-auth'
  }
  Write-Host "[start] $cmdLine" -ForegroundColor Gray

  $pinfo = New-Object System.Diagnostics.ProcessStartInfo
  $pinfo.FileName   = 'cmd.exe'
  $pinfo.Arguments  = "/k title `"$windowTitle`" && cd /d `"$ProjectDir`" && $cmdLine"
  $pinfo.UseShellExecute = $true
  $process = [System.Diagnostics.Process]::Start($pinfo)

  Write-Host '[wait] checking health...' -ForegroundColor Gray
  $up = $false
  for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Milliseconds 1000
    try {
      $r = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
      if ($r.StatusCode -lt 500) { $up = $true; break }
    } catch {}
  }

  Write-Host ''
  if ($up) {
    $srvPid = Get-ServerPid
    Write-Host '  Server is running' -ForegroundColor Green
    if ($srvPid) {
      Write-Host "  PID   : $srvPid"
      Write-Host "  Stop  : taskkill /PID $srvPid /F" -ForegroundColor Yellow
    } else {
      Write-Host "  PID   : not detected (launcher: $($process.Id))" -ForegroundColor Yellow
    }
    Write-Host "  Health: $HealthUrl"
    Write-Host ''
  } else {
    Write-Host '[WARN] Server may not have started. Check the window.' -ForegroundColor Yellow
  }
}

function Open-Url {
  param([string]$Url, [string]$Name)
  try {
    Start-Process $Url
    Write-Host "[open] $Name opened: $Url" -ForegroundColor Gray
  } catch {
    Write-Host "[open] Failed to open $Name" -ForegroundColor Red
  }
}

function Invoke-Tests {
  Write-Banner 'Tests'
  Push-Location $ProjectDir
  try {
    npm test
    if ($LASTEXITCODE -ne 0) {
      Write-Host ''
      Write-Host '[WARN] Some tests failed. Check output above.' -ForegroundColor Yellow
    } else {
      Write-Host ''
      Write-Host '[OK] All tests passed' -ForegroundColor Green
    }
  } finally {
    Pop-Location
  }
}

function Show-Status {
  $serverPid = Get-ServerPid
  if ($serverPid) {
    Write-Host "  [RUNNING] PID $serverPid on $ListenHost`:$Port" -ForegroundColor Green
    try {
      $r = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
      Write-Host "  [HEALTHY] HTTP $($r.StatusCode)" -ForegroundColor Green
    } catch {
      Write-Host "  [ERROR] Health check failed" -ForegroundColor Red
    }
  } else {
    Write-Host "  [STOPPED] No server on $ListenHost`:$Port" -ForegroundColor Red
  }
}

function Show-Menu {
  Write-Host ''
  Write-Host '  +---------------------------------------------+' -ForegroundColor Cyan
  Write-Host '  |           AgentX Quick Launcher              |' -ForegroundColor Cyan
  Write-Host '  +---------------------------------------------+' -ForegroundColor Cyan
  Write-Host '  |  1) Build & Start Server + Chat           |' -ForegroundColor White
  Write-Host '  |  2) Build & Start Server + Admin          |' -ForegroundColor White
  Write-Host '  |  3) Start Server + Chat       (no build)  |' -ForegroundColor White
  Write-Host '  |  4) Start Server + Admin      (no build)  |' -ForegroundColor White
  Write-Host '  |  5) Build only                             |' -ForegroundColor White
  Write-Host '  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~' -ForegroundColor DarkGray
  Write-Host '  |  6) Open Chat in Browser                  |' -ForegroundColor Gray
  Write-Host '  |  7) Open Admin in Browser                 |' -ForegroundColor Gray
  Write-Host '  |  8) Open Login Page in Browser            |' -ForegroundColor Gray
  Write-Host '  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~' -ForegroundColor DarkGray
  Write-Host '  |  9) Restart Server (kill + start)         |' -ForegroundColor White
  Write-Host '  | 10) Stop Server                          |' -ForegroundColor White
  Write-Host '  | 11) Status / Health Check                 |' -ForegroundColor White
  Write-Host '  |  R) Run Tests                             |' -ForegroundColor White
  Write-Host '  |  Q) Quit                                 |' -ForegroundColor Yellow
  Write-Host '  +---------------------------------------------+' -ForegroundColor Cyan
  Write-Host ''
}

# Main
Test-Prerequisites

if ($All) {
  Invoke-Build
  Start-Server
  Open-Url -Url $ChatUrl -Name "Chat"
  exit 0
}

if ($OpenChat) {
  if (-not (Get-ServerPid)) {
    Start-Server
  }
  Open-Url -Url $ChatUrl -Name "Chat"
  exit 0
}

if ($OpenAdmin) {
  if (-not (Get-ServerPid)) {
    Start-Server
  }
  Open-Url -Url $AdminUrl -Name "Admin"
  exit 0
}

if ($Build -and $Server) {
  Invoke-Build
  Start-Server
  exit 0
}

if ($Server) {
  Start-Server
  exit 0
}

if ($Build) {
  Invoke-Build
  exit 0
}

if ($Test) {
  Invoke-Tests
  exit 0
}

# Interactive mode
while ($true) {
  Write-Banner 'AgentX Launcher'
  Write-Host "  Host   : $ListenHost`:$Port"
  Write-Host "  Health : $HealthUrl"
  Write-Host "  Chat   : $ChatUrl"
  Write-Host "  Admin  : $AdminUrl"
  Write-Host ''
  Show-Status
  Show-Menu

  $choice = Read-Host '  Select option'
  switch ($choice) {
    '1' {
      Invoke-Build
      Start-Server
      Open-Url -Url $ChatUrl -Name "Chat"
    }
    '2' {
      Invoke-Build
      Start-Server
      Open-Url -Url $AdminUrl -Name "Admin"
    }
    '3' {
      Start-Server
      Open-Url -Url $ChatUrl -Name "Chat"
    }
    '4' {
      Start-Server
      Open-Url -Url $AdminUrl -Name "Admin"
    }
    '5' {
      Invoke-Build
    }
    '6' {
      if (-not (Get-ServerPid)) {
        Write-Host '[open] Server not running. Starting...' -ForegroundColor Yellow
        Start-Server
      }
      Open-Url -Url $ChatUrl -Name "Chat"
    }
    '7' {
      if (-not (Get-ServerPid)) {
        Write-Host '[open] Server not running. Starting...' -ForegroundColor Yellow
        Start-Server
      }
      Open-Url -Url $AdminUrl -Name "Admin"
    }
    '8' {
      if (-not (Get-ServerPid)) {
        Write-Host '[open] Server not running. Starting...' -ForegroundColor Yellow
        Start-Server
      }
      Open-Url -Url $LoginUrl -Name "Login"
    }
    '9' {
      $Restart = $true
      Start-Server
    }
    '10' {
      Stop-Server
    }
    '11' {
      Write-Banner 'Status'
      Show-Status
      Write-Host ''
      Write-Host 'Press Enter to continue...' -ForegroundColor Gray
      Read-Host
    }
    { $_ -in 'r', 'R' } {
      Invoke-Tests
      Write-Host ''
      Write-Host 'Press Enter to continue...' -ForegroundColor Gray
      Read-Host
    }
    { $_ -in 'q', 'Q' } {
      Write-Host ''
      Write-Host '  Goodbye!' -ForegroundColor Cyan
      break
    }
    default {
      Write-Host "  Unknown option: $_" -ForegroundColor Red
      Start-Sleep -Seconds 1
    }
  }
}
