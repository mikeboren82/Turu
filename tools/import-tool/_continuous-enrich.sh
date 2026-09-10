#!/bin/bash
LOG="_continuous-enrich.log"
> "$LOG"
ROUND=1
while true; do
  echo "=== ROUND $ROUND ===" >> "$LOG"
  node enrich-playground-addresses.js --limit=250 >> "$LOG" 2>&1
  REMAINING=$(grep "נותרו לסבבים הבאים" "$LOG" | tail -1 | grep -oE "[0-9]+")
  echo "Round $ROUND done, remaining: $REMAINING" >> "$LOG"
  if [ -z "$REMAINING" ] || [ "$REMAINING" -le 0 ]; then
    echo "ALL DONE - no more recoverable candidates" >> "$LOG"
    break
  fi
  ROUND=$((ROUND+1))
done
