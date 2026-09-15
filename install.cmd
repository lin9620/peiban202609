@echo off
cd /d "%~dp0"
title Warm Paws Install
set "npm_config_cache=%TEMP%\npm-cache"
npm install naive-ui lottie-web @iconify/vue
