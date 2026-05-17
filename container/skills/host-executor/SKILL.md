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

## Behavior

All tools are **fire-and-forget**. They submit a request to the host and the result arrives as a chat message from the system. Do not expect an immediate return value — wait for the system message with the result.

## When to Use

- Starting dev servers, databases, or build processes
- Running host commands that need access to the host filesystem or network
- Monitoring long-running services (capture terminal, wait for output)
- Managing multiple services for a project (start, stop, restart, dashboard)

## Process Naming

Use descriptive, short names for processes (e.g., `frontend`, `api`, `db`, `worker`). Names are used as tmux session identifiers.
