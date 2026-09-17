# PowerShell helper to launch Google Chrome with the Pawtrol unpacked extension

$chromePaths = @(
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)

$chrome = $chromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $chrome) {
    Write-Host "[ERROR] Google Chrome was not found in standard paths." -ForegroundColor Red
    Write-Host "Please open Chrome manually and navigate to chrome://extensions"
    exit 1
}

$extPath = $PSScriptRoot
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "  Launching Pawtrol (Chrome MV3 Extension)" -ForegroundColor Cyan
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "Chrome Path   : $chrome"
Write-Host "Extension Path: $extPath"
Write-Host ""
Write-Host "Opening Chrome with extension loaded..." -ForegroundColor Green

Start-Process $chrome -ArgumentList "--load-extension=`"$extPath`"", "chrome://extensions"
Write-Host "Done! Pawtrol is ready in Chrome." -ForegroundColor Green
