# Windows version of deploy.sh: sends the code to the home server and rebuilds wxboard there.
# Usage (from ~\repos\wxboard in PowerShell):
#   powershell -ExecutionPolicy Bypass -File .\deploy.ps1
# Sends the last git COMMIT (not unsaved edits), so commit first. Uses ssh, scp and git, which Windows 10/11 and
# Git for Windows provide. Like deploy.sh, it leaves the server's own config/, data/ and .env alone (those are
# never in git) and skips the tests.
param([string]$Server = $(if ($env:WX_SERVER) { $env:WX_SERVER } else { 'joe@192.168.1.215' }))

$Dir = '/opt/wxboard'
$Tmp = Join-Path $env:TEMP 'wxboard-deploy.tar.gz'
Set-Location $PSScriptRoot

foreach ($t in 'git', 'ssh', 'scp') {
  if (-not (Get-Command $t -ErrorAction SilentlyContinue)) { Write-Host "Can't find '$t'. Install it and try again." -ForegroundColor Red; exit 1 }
}

# Only committed code is sent. Stop if there are edits that would be left out.
$dirty = git status --porcelain
if ($dirty) {
  Write-Host 'You have changes that are not committed yet, so they would NOT be deployed:' -ForegroundColor Yellow
  $dirty | ForEach-Object { Write-Host "  $_" }
  Write-Host 'Commit them first (git add -A; git commit -m "..."), then run this again.'
  exit 1
}

# Package the last commit with Unix line endings (core.autocrlf=false gives the files exactly as stored in git).
git -c core.autocrlf=false archive --format=tar.gz -o $Tmp HEAD -- . ':(exclude)test' ':(exclude)deploy.sh' ':(exclude)deploy.ps1'
if ($LASTEXITCODE) { Write-Host 'Packaging the code failed.' -ForegroundColor Red; exit 1 }

Write-Host "Copying to $Server ..."
scp $Tmp "${Server}:/tmp/wxboard-deploy.tar.gz"
if ($LASTEXITCODE) { Write-Host 'Copy to the server failed.' -ForegroundColor Red; exit 1 }
Remove-Item $Tmp -ErrorAction SilentlyContinue

Write-Host 'Unpacking and rebuilding on the server ...'
ssh $Server "tar -xzf /tmp/wxboard-deploy.tar.gz -C $Dir && rm /tmp/wxboard-deploy.tar.gz && cd $Dir && docker compose up -d --build && docker compose ps"
if ($LASTEXITCODE) { Write-Host 'The rebuild on the server failed. Read the messages above.' -ForegroundColor Red; exit 1 }

Write-Host ''
Write-Host 'Deployed. Open https://wxboard.app and reload the page.' -ForegroundColor Green
