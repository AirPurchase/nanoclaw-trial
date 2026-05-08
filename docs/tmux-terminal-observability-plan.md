# Terminal Observability via tmux

## Context

NanoClaw starts dev processes via `spawn('bash', ...)` and pipes stdout/stderr to log files. The agent can only read these logs via `read_process_logs` (file read) or `Bash(grep/tail)` — it cannot observe real-time terminal output. This causes:
- Slow startup detection: agent polls log files with grep hacks to detect "Welcome back" or port listening
- No real-time feedback: agent can't see compilation errors, warnings, or progress as they happen
- Fragile detection: relies on specific strings in logs rather than watching the terminal like a human

## Solution

Run each managed process inside a named tmux session. The agent can then:
- `tmux capture-pane` to get the current visible terminal content (what a human would see)
- `tmux send-keys` to interact with the terminal if needed
- Check real-time output without polling log files

## Files to Modify

### 1. `src/host-executor.ts` — Run processes in tmux sessions

Change `startProcess` to spawn inside a tmux session instead of raw `spawn`:

```bash
tmux new-session -d -s nanoclaw-{name} -x 200 -y 50 'cd {cwd} && {command}'
```

- Session name: `nanoclaw-{name}` (e.g. `nanoclaw-stock-engine`)
- Still pipe output to log files via `tmux pipe-pane` for persistence
- PID tracking: get the PID of the process inside tmux via `tmux list-panes -t nanoclaw-{name} -F '#{pane_pid}'`

Add new function `capturePane(name)`:
```bash
tmux capture-pane -t nanoclaw-{name} -p -S -50
```
Returns the last 50 lines of visible terminal output — exactly what a human would see.

Update `stopProcess` to kill the tmux session:
```bash
tmux kill-session -t nanoclaw-{name}
```

### 2. `container/agent-runner/src/ipc-mcp-stdio.ts` — Add `capture_terminal` MCP tool

New tool: `capture_terminal(name)` — captures the current visible terminal output of a managed process. This is the "look at the terminal" equivalent.

Also add: `wait_for_output(name, pattern, timeout?)` — waits for a specific string to appear in the terminal output. This replaces the grep-polling hacks. The host executor polls `tmux capture-pane` every 2 seconds until the pattern appears or timeout.

### 3. `src/ipc.ts` — Add IPC handlers

- `host_capture_terminal` — calls `hostExecutor.capturePane(name)`, writes result
- `host_wait_for_output` — calls `hostExecutor.waitForOutput(name, pattern, timeout)`, writes result

### 4. `groups/telegram_main/CLAUDE.md` — Update startup instructions

Replace the port-checking startup verification with `wait_for_output`:
- stock-tenant-man-engine: `wait_for_output("stock-tenant-man-engine", "Welcome back", 30)`
- stock-engine: `wait_for_output("stock-engine", "Welcome back", 120)`
- stock-portal: `wait_for_output("stock-portal", "Compiled successfully", 30)`
- stock-tenant-man-portal: `wait_for_output("stock-tenant-man-portal", "Compiled successfully", 30)`

## Key Design Decisions

- tmux sessions persist across NanoClaw container sessions (they run on the host)
- Log files still captured via `tmux pipe-pane` for historical access
- `capture_terminal` returns the current screen (last 50 lines) — lightweight, no file I/O
- `wait_for_output` blocks on the host side (not in the container) — the MCP tool polls the result file
- tmux session names prefixed with `nanoclaw-` to avoid conflicts

## Verification

1. `npm run build` succeeds
2. `./container/build.sh` rebuilds container
3. Restart NanoClaw, send "start all services"
4. Agent uses `wait_for_output` instead of grep hacks
5. `tmux ls` on host shows named sessions for each process
6. `tmux attach -t nanoclaw-stock-engine` shows live terminal output (human can watch)
