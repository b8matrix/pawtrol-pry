@echo off
setlocal
echo ===================================================
echo   Launching Pawtrol (Chrome MV3 Extension)
echo ===================================================

set CHROME_PATH=
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
    set "CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe"
) else if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" (
    set "CHROME_PATH=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
) else if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" (
    set "CHROME_PATH=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
)

if "%CHROME_PATH%"=="" (
    echo [ERROR] Google Chrome was not found in standard paths.
    echo Please open Chrome manually and navigate to chrome://extensions
    pause
    exit /b 1
)

set "EXT_DIR=%~dp0"
:: Remove trailing backslash if present
if "%EXT_DIR:~-1%"=="\" set "EXT_DIR=%EXT_DIR:~0,-1%"

echo Found Chrome: "%CHROME_PATH%"
echo Extension path: "%EXT_DIR%"
echo.
echo Opening Chrome with extension loaded...
start "" "%CHROME_PATH%" --load-extension="%EXT_DIR%" "chrome://extensions"
echo Done! You can now use Pawtrol from Chrome's extensions toolbar or side panel.
