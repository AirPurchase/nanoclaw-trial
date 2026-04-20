#!/bin/bash
set -e

# Forward host ports into the container so Playwright's browser can reach
# host services via localhost (React apps call localhost APIs).
# NANOCLAW_PORT_FORWARDS is a comma-separated list of ports, e.g. "1330,1337,3000,3008"
if [ -n "$NANOCLAW_PORT_FORWARDS" ]; then
  IFS=',' read -ra PORTS <<< "$NANOCLAW_PORT_FORWARDS"
  for port in "${PORTS[@]}"; do
    port=$(echo "$port" | tr -d ' ')
    socat TCP-LISTEN:${port},fork,reuseaddr TCP:host.docker.internal:${port} &
  done
  echo "[entrypoint] Port forwards active: ${NANOCLAW_PORT_FORWARDS}" >&2
fi

# Compile TypeScript
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist

# Read container input from stdin, run agent
cat > /tmp/input.json
node /tmp/dist/index.js < /tmp/input.json
