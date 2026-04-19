# Host Executor — Give NanoClaw Full Developer Autonomy

## Context

The user has 5 projects in `/Users/dragonlung/pro_coding` that NanoClaw already has read-write access to:

| Folder | Type | Start Command | Port | Runtime |
|--------|------|---------------|------|---------|
| `stock-portal` | React (CRA) | `lsof -ti :3008 \| xargs kill 2>/dev/null; yarn start` | 3008 | Node 18 |
| `stock-tenant-man-portal` | React (CRA) | `lsof -ti :3000 \| xargs kill 2>/dev/null; yarn start` | 3000 | Node 18 |
| `stock-engine` | Strapi v4.11.5 | `lsof -ti :1337 \| xargs kill 2>/dev/null; yarn develop` | 1337 | Node 18 |
| `stock-tenant-man-engine` | Strapi v4.17.1 | `lsof -ti :1330 \| xargs kill 2>/dev/null; yarn develop` | 1330 | Node 18 |
| `psql-cluster` | PostgreSQL 16 (Docker Compose) | `docker compose up` | 5433, 3200 | Docker |

NanoClaw's container agent can already edit files via `/workspace/extra/pro_coding`, but cannot start dev servers, monitor output, or manage processes on the host. This adds a **host executor** — new IPC task types that let the container agent run commands and manage long-running processes directly on the host machine.

## Architecture

```
Container Agent                    Host Process (NanoClaw)
─────────────────                  ────────────────────────
MCP tool: run_command  ──JSON──►   ipc.ts: case 'host_exec'
MCP tool: start_process ──JSON──►       │
MCP tool: stop_process  ──JSON──►       ▼
MCP tool: process_logs  ──JSON──►   host-executor.ts
MCP tool: list_processes ──JSON──►  (spawns/manages processes)
                                        │
reads /workspace/host-exec/             ▼
  ├── results/{id}.json            data/host-exec/
  └── logs/{name}.log              ├── results/{id}.json
                                   └── logs/{name}.log
```

Agent writes IPC task files → host processes them via `host-executor.ts` → results and logs written to `data/host-exec/` → mounted read-only into container at `/workspace/host-exec/`.

## Files to Create/Modify

### 1. `src/host-executor.ts` — NEW: Host-side process manager

Two execution modes:
- **One-shot commands**: `run_command` — run, wait, return result
- **Long-running processes**: `start_process` — spawn, stream logs to file, persist across container sessions

#### Data Structures

```typescript
interface ManagedProcess {
  name: string;           // e.g. "stock-portal"
  command: string;        // e.g. "yarn start"
  cwd: string;            // e.g. "/Users/dragonlung/pro_coding/stock-portal"
  pid: number;
  status: 'running' | 'stopped' | 'crashed';
  startedAt: string;
  exitCode?: number | null;
  env?: Record<string, string>;
}

interface CommandResult {
  id: string;
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;         // last 500 lines
  stderr: string;         // last 500 lines
  durationMs: number;
}
```

#### Functions

- `runCommand(id, command, cwd, timeout?)` → executes via `spawn('bash', ['-c', command])`, writes result to `data/host-exec/results/{id}.json`
- `startProcess(name, command, cwd, env?)` → **kills any existing process on the target port first** via `lsof -ti :{port} | xargs kill`, then spawns child with `spawn('bash', ['-c', command])`, pipes stdout/stderr to `data/host-exec/logs/{name}.log`
- `stopProcess(name)` → SIGTERM, then SIGKILL after 5s
- `restartProcess(name)` → stop + start with same config (including port-kill)
- `listProcesses()` → returns all managed processes with status, writes to `data/host-exec/results/{id}.json`
- `getProcessLogs(name, lines?)` → reads tail of log file, writes to `data/host-exec/results/{id}.json`

#### Process Lifecycle

- State stored in-memory `Map<string, ManagedProcess>` + JSON snapshot at `data/host-exec/processes.json`
- On NanoClaw restart: reload snapshot, check PIDs with `process.kill(pid, 0)`, mark dead ones as `crashed`
- Log files: append mode, rotated at 10MB (`.log` → `.log.1`)
- Child processes spawned detached (`detached: true`) so they survive if NanoClaw restarts
- Port cleanup before start: `lsof -ti :{PORT} | xargs kill` ensures clean startup

### 2. `src/ipc.ts` — MODIFY: Add host executor IPC handlers

Add to `processTaskIpc` switch (all main-group-only):

| IPC Type | Handler |
|----------|---------|
| `host_exec` | `hostExecutor.runCommand(data.requestId, data.command, data.cwd, data.timeout)` |
| `host_process_start` | `hostExecutor.startProcess(data.name, data.command, data.cwd, data.env)` |
| `host_process_stop` | `hostExecutor.stopProcess(data.name)` |
| `host_process_restart` | `hostExecutor.restartProcess(data.name)` |
| `host_process_list` | `hostExecutor.listProcesses()` → write result |
| `host_process_logs` | `hostExecutor.getProcessLogs(data.name, data.lines)` → write result |

Add `requestId` to the `processTaskIpc` data type. Each handler writes its result to `data/host-exec/results/{requestId}.json`.

### 3. `container/agent-runner/src/ipc-mcp-stdio.ts` — MODIFY: Add MCP tools

New tools exposed to the container agent:

| Tool | Parameters | Behavior |
|------|-----------|----------|
| `run_command` | `command`, `cwd?`, `timeout?` | Write IPC task, poll result file, return output |
| `start_process` | `name`, `command`, `cwd`, `env?` | Write IPC task, poll result file, return status |
| `stop_process` | `name` | Write IPC task, poll result file |
| `restart_process` | `name` | Write IPC task, poll result file |
| `list_processes` | — | Write IPC task, poll result file, return process table |
| `read_process_logs` | `name`, `lines?` (default 100) | Read `/workspace/host-exec/logs/{name}.log` directly (no IPC needed) |

**Polling**: tools write task file, then poll `/workspace/host-exec/results/{requestId}.json` every 500ms with a 30s timeout (configurable for `run_command`).

**Path translation**: MCP tool translates container paths (`/workspace/extra/pro_coding/...`) to host paths using `NANOCLAW_EXTRA_MOUNTS` env var (JSON map of container→host paths).

### 4. `src/container-runner.ts` — MODIFY: Mount host-exec directory

Add mount for main group containers (after IPC mount, ~line 203):
```typescript
// Host executor results and logs (read-only for container)
const hostExecDir = path.join(DATA_DIR, 'host-exec');
fs.mkdirSync(path.join(hostExecDir, 'results'), { recursive: true });
fs.mkdirSync(path.join(hostExecDir, 'logs'), { recursive: true });
mounts.push({
  hostPath: hostExecDir,
  containerPath: '/workspace/host-exec',
  readonly: true,
});
```

Also pass `NANOCLAW_EXTRA_MOUNTS` env var to MCP server with the mount mapping JSON.

### 5. `src/index.ts` — MODIFY: Initialize host executor

Import and initialize `hostExecutor` at startup. Pass it to IPC deps or import directly in `ipc.ts`.

### 6. `groups/telegram_main/CLAUDE.md` — MODIFY: Document capabilities

Add section:
```markdown
## Host Execution

You can run commands and manage processes on the host machine.

### MCP Tools
- `run_command(command, cwd?, timeout?)` — run a one-shot command
- `start_process(name, command, cwd, env?)` — start a long-running process
- `stop_process(name)` — stop a managed process
- `restart_process(name)` — restart a managed process
- `list_processes()` — list all managed processes
- `read_process_logs(name, lines?)` — read recent log output

### Development Projects

| Name | Path | Start | Port |
|------|------|-------|------|
| stock-portal | /workspace/extra/pro_coding/stock-portal | yarn start | 3008 |
| stock-tenant-man-portal | /workspace/extra/pro_coding/stock-tenant-man-portal | yarn start | 3000 |
| stock-engine | /workspace/extra/pro_coding/stock-engine | yarn develop | 1337 |
| stock-tenant-man-engine | /workspace/extra/pro_coding/stock-tenant-man-engine | yarn develop | 1330 |
| psql-cluster | /workspace/extra/pro_coding/psql-cluster | docker compose up | 5433, 3200 |

### Process logs
Read directly: `cat /workspace/host-exec/logs/{name}.log`
Or via tool: `read_process_logs(name, lines)`
```

## IPC Flow Example

**Start stock-portal:**

1. Agent calls `start_process(name: "stock-portal", command: "lsof -ti :3008 | xargs kill 2>/dev/null; yarn start", cwd: "/workspace/extra/pro_coding/stock-portal", port: 3008)`
2. MCP tool translates path, writes IPC task:
   ```json
   {"type": "host_process_start", "requestId": "req-1234", "name": "stock-portal",
    "command": "lsof -ti :3008 | xargs kill 2>/dev/null; yarn start",
    "cwd": "/Users/dragonlung/pro_coding/stock-portal", "port": 3008}
   ```
3. Host picks up file → `hostExecutor.startProcess()` spawns process
4. stdout/stderr piped to `data/host-exec/logs/stock-portal.log`
5. Result written to `data/host-exec/results/req-1234.json`
6. Agent polls and reads result

**Check logs:**

Agent reads `/workspace/host-exec/logs/stock-portal.log` directly — no IPC round-trip needed.

## Verification

1. `npm run build` succeeds
2. `./container/build.sh` rebuilds container image
3. `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` restarts service
4. Message to bot: "Start the PostgreSQL cluster" → `docker ps` shows containers
5. Message: "Start stock-portal on port 3008" → `curl localhost:3008` responds
6. Message: "Show me the stock-portal logs" → agent returns log output
7. Message: "List all running processes" → agent returns process table
8. Message: "Stop stock-engine" → process stops, confirmed via `list_processes`
