@echo off
cd /d "%~dp0"
set "npm_config_cache=%TEMP%\npm-cache"
npm run build
