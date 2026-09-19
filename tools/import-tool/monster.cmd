@echo off
rem TuRu - CONTINUOUS MONSTER local cycle (pilot on the admin machine). One bounded cycle per scheduled run:
rem the orchestrator refuses to overlap itself (logs\monster.lock) and every job is bounded and isolated.
rem Task Scheduler: see `node monster.js install-task`. Pause: `node monster.js pause`.
cd /d %~dp0
echo ===== %date% %time% ===== >> logs\monster.log
node monster.js cycle >> logs\monster.log 2>&1
