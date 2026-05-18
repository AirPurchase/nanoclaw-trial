---
name: host-executor
description: Run and manage processes on the host machine via tmux sessions.
---

# Host Executor

You have access to host-side process management tools. These run commands directly on the host machine (outside your container) in tmux sessions.

## Available Tools

- `host_run_command` — Run a one-shot command and get stdout/stderr/exit code
- `host_start_process` — Start a named long-running process in a tmux session
- `host_stop_process` — Stop a named process
- `host_restart_process` — Restart a named process (stop + start)
- `host_list_processes` — List all managed host processes
- `host_capture_terminal` — Capture current terminal output from a process
- `host_wait_for_output` — Wait for specific text to appear in process output
- `host_get_process_logs` — Get recent log output from a process
- `host_open_dashboard` — Create a tmux dashboard showing all processes
- `host_stop_all` — Stop ALL running service processes at once
- `host_start_all` — Start multiple processes in one batch call

## Batch Operations (PREFERRED)

When starting or stopping multiple services, ALWAYS use batch tools:

- `host_stop_all` — kills all running nanoclaw-* tmux sessions in one call
- `host_start_all` — starts multiple processes in one call with an `entries` array

These are **much faster** than calling individual start/stop for each process. Each individual tool call has ~2-3s of round-trip overhead. Batch operations do everything in a single round-trip.

Example `host_start_all` entries:
```json
{ "entries": [
  { "name": "stock-engine", "command": "yarn develop", "cwd": "/path/to/stock-engine", "readyPattern": "listening on" },
  { "name": "stock-portal", "command": "yarn start", "cwd": "/path/to/stock-portal", "readyPattern": "Compiled successfully" }
]}
```

## Behavior

All tools are **fire-and-forget**. They submit a request to the host and the result arrives as a chat message from the system. Do not expect an immediate return value — wait for the system message with the result.

## Process Naming

Use descriptive, short names for processes (e.g., `stock-engine`, `stock-portal`, `tenant-man-engine`). Names are used as tmux session identifiers.
