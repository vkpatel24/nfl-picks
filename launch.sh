#!/bin/bash
# Serve the site on localhost:8765 (if it isn't already) and open it in Chrome.
# serve.py exits on its own once the last tab is closed.
cd "$(dirname "$0")"
PORT=8765
if ! lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  nohup /usr/bin/python3 serve.py $PORT >/dev/null 2>&1 &
  for _ in {1..20}; do
    lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1 && break
    sleep 0.1
  done
fi
open -a "Google Chrome" "http://localhost:$PORT"
