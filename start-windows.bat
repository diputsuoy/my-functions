@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js not found. Install Node.js 22+ from https://nodejs.org & pause & exit /b 1)
node src/index.js %*
pause
