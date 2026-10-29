param([Parameter(Mandatory = $true)][ValidateSet('start', 'stop', 'restart', 'unfollow', 'firstrun')][string]$Action)
# The tutorial instance of Krypto Mirror: --profile=tutorial, CDP on 9333,
# loaded from dist (run `npx vite build` first). See README.md.
#
#   start     launch it and wait for the debug port
#   stop      close it (only electron processes started with --profile=tutorial)
#   restart
#   unfollow  closed → no follows, no Helius key → started   (before api-keys … discover-check)
#   firstrun  closed → back to the first run (onboarding)    (before quickstart)
#
# The profile folder is only ever %APPDATA%\Krypto Copy Profiles\tutorial;
# nothing here touches the default profile.

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$prof = Join-Path $env:APPDATA 'Krypto Copy Profiles\tutorial'
$port = 9333

function Stop-Tut {
  $procs = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -match 'profile=tutorial' -and $_.CommandLine -notmatch '--type=' }
  foreach ($p in $procs) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {} }
  Start-Sleep -Seconds 2
  Write-Output "stopped $(@($procs).Count)"
}

function Start-Tut {
  Remove-Item Env:\VITE_DEV_SERVER_URL -ErrorAction SilentlyContinue
  $env:KRYPT_DEBUG_PORT = "$port"
  $exe = Join-Path $repo 'node_modules\electron\dist\electron.exe'
  Start-Process $exe -ArgumentList '.', '--profile=tutorial', '--no-sandbox', '--disable-features=CalculateNativeWinOcclusion', '--disable-renderer-backgrounding' -WorkingDirectory $repo
  $up = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 1
    try {
      $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/json/list" -TimeoutSec 2 -ErrorAction Stop
      if ($r.Content -match 'index\.html') { $up = $true; break }
    } catch {}
  }
  if ($up) { Start-Sleep -Seconds 4; Write-Output "up after $($i + 1)s" } else { Write-Output "NOT UP after 40s"; exit 1 }
}

# JSON edits go through node: PowerShell 5.1's ConvertTo-Json reshapes deep
# settings, and its Set-Content writes a BOM the app's parsers refuse.
function Edit-Settings([string]$js) {
  $settings = Join-Path $prof 'settings.json'
  if (-not (Test-Path $settings)) { Write-Output 'no settings.json yet'; return }
  $prelude = "const fs=require('fs');const f=process.argv[1];const s=JSON.parse(fs.readFileSync(f,'utf8').replace(/^﻿/,''));"
  $coda = "fs.writeFileSync(f,JSON.stringify(s,null,2));"
  & node -e ($prelude + $js + $coda) $settings
}

function Remove-Follows {
  Remove-Item (Join-Path $prof 'copytrade.json') -Force -ErrorAction SilentlyContinue
  Write-Output 'follows removed'
}

function Remove-Key {
  Edit-Settings "if(s.rpc&&s.rpc.heliusApiKey){delete s.rpc.heliusApiKey;console.log('helius key removed');}"
}

function Set-FirstRun {
  Remove-Item (Join-Path $prof 'legal-acceptance.jsonl') -Force -ErrorAction SilentlyContinue
  Remove-Follows
  foreach ($f in @('wallet.json', 'wallets.json', 'evm-wallets.json')) { Remove-Item (Join-Path $prof $f) -Force -ErrorAction SilentlyContinue }
  Edit-Settings "s.onboarded=false;console.log('onboarded=false');"
}

switch ($Action) {
  'stop' { Stop-Tut }
  'start' { Start-Tut }
  'restart' { Stop-Tut; Start-Tut }
  'unfollow' { Stop-Tut; Remove-Follows; Remove-Key; Start-Tut }
  'firstrun' { Stop-Tut; Set-FirstRun; Remove-Key; Start-Tut }
}
