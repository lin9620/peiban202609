@echo off
rem 重启 Warm Paws dev 服务器：先杀掉 5173 监听进程，再后台重启（读取最新 .env）
cd /d "%~dp0.."
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :5173 ^| findstr LISTENING') do taskkill /PID %%a /F >nul 2>&1
timeout /t 1 /nobreak >nul
start "warm-paws-dev" /min cmd /c "npm.cmd run dev > dev-cloud.log 2>&1"
echo RESTART_ISSUED
