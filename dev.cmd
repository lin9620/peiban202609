@echo off
cd /d "%~dp0"
title Warm Paws Dev Server
set "npm_config_cache=%TEMP%\npm-cache"
npm run dev
