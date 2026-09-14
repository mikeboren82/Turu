@echo off
rem TuRu - THE CLEANER unattended pilot (2026-09-14): one bounded batch per scheduled run.
rem The Cleaner's own run guard refuses to overlap a live run; leases/backoff do the rest.
cd /d C:\Users\mbore\KidsApp\tools\import-tool
echo ===== %date% %time% ===== >> logs\cleaner-pilot.log
node cleaner.js --max=40 >> logs\cleaner-pilot.log 2>&1
