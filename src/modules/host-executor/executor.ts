import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { log } from '../../log.js';

const TMUX_SESSION_PREFIX = 'nanoclaw-';
const LOGS_DIR = path.join(DATA_DIR, 'host-exec', 'logs');
const MAX_LOG_SIZE = 10 * 1024 * 1024;

const TMUX_BIN = (() => {
  const candidates = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'tmux';
})();

function ensureLogsDir(): void {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function ensureTmuxServer(): void {
  try {
    execSync(`${TMUX_BIN} has-session 2>/dev/null`, { stdio: 'pipe' });
  } catch {
    // No tmux server running — start one with a detached session
    execSync(`${TMUX_BIN} new-session -d -s nanoclaw-init`, { stdio: 'pipe' });
    log.info('Started tmux server');
  }
}

function sessionName(name: string): string {
  return `${TMUX_SESSION_PREFIX}${name}`;
}

function logPath(name: string): string {
  return path.join(LOGS_DIR, `${name}.log`);
}

export interface ProcessInfo {
  name: string;
  pid: number;
  status: 'running' | 'stopped';
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export function startProcess(opts: {
  name: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  port?: number;
}): { pid: number } {
  ensureLogsDir();
  ensureTmuxServer();
  const sess = sessionName(opts.name);
  const cwd = opts.cwd || process.cwd();
  const logFile = logPath(opts.name);

  // Kill existing session if any
  try {
    execSync(`${TMUX_BIN} kill-session -t ${sess}`, { stdio: 'pipe' });
  } catch {
    /* not running */
  }

  // Kill port if specified
  if (opts.port) {
    try {
      execSync(`lsof -ti :${opts.port} | xargs kill -9`, { stdio: 'pipe' });
    } catch {
      /* nothing on port */
    }
  }

  // Build env string for tmux
  const envPrefix = opts.env
    ? Object.entries(opts.env)
        .map(([k, v]) => `export ${k}=${JSON.stringify(v)};`)
        .join(' ')
    : '';

  const script = `cd ${JSON.stringify(cwd)} && ${envPrefix} ${opts.command}`;
  execSync(`${TMUX_BIN} new-session -d -s ${sess} -x 200 -y 50 'bash -c ${JSON.stringify(script)}'`, { stdio: 'pipe' });

  // Pipe output to log file
  execSync(`${TMUX_BIN} pipe-pane -t ${sess} -o 'cat >> ${logFile}'`, { stdio: 'pipe' });

  const pidStr = execSync(`${TMUX_BIN} list-panes -t ${sess} -F '#{pane_pid}'`, {
    encoding: 'utf-8',
  }).trim();
  const pid = parseInt(pidStr, 10) || 0;

  log.info('Host process started', { name: opts.name, pid, command: opts.command, cwd });
  return { pid };
}

export function stopProcess(name: string): void {
  const sess = sessionName(name);
  try {
    execSync(`${TMUX_BIN} kill-session -t ${sess}`, { stdio: 'pipe' });
    log.info('Host process stopped', { name });
  } catch {
    log.warn('Host process not found for stop', { name });
  }
}

export function restartProcess(opts: {
  name: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  port?: number;
}): { pid: number } {
  stopProcess(opts.name);
  return startProcess(opts);
}

export function listProcesses(): ProcessInfo[] {
  ensureTmuxServer();
  try {
    const output = execSync(`${TMUX_BIN} list-sessions -F '#{session_name}'`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output
      .trim()
      .split('\n')
      .filter((s) => s.startsWith(TMUX_SESSION_PREFIX))
      .map((sess) => {
        const name = sess.replace(TMUX_SESSION_PREFIX, '');
        let pid = 0;
        try {
          pid = parseInt(
            execSync(`${TMUX_BIN} list-panes -t ${sess} -F '#{pane_pid}'`, { encoding: 'utf-8' }).trim(),
            10,
          );
        } catch {
          /* session may have died */
        }
        return { name, pid, status: 'running' as const };
      });
  } catch {
    return [];
  }
}

export function runCommand(command: string, opts?: { cwd?: string; timeout?: number }): CommandResult {
  const start = Date.now();
  const timeout = opts?.timeout || 60_000;
  const cwd = opts?.cwd || process.cwd();

  const result = spawnSync('bash', ['-c', command], {
    cwd,
    timeout,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024,
  });

  return {
    stdout: (result.stdout || '').slice(-10000),
    stderr: (result.stderr || '').slice(-5000),
    exitCode: result.status ?? 1,
    durationMs: Date.now() - start,
  };
}

export function captureTerminal(name: string, lines?: number): string {
  ensureTmuxServer();
  const sess = sessionName(name);
  const lineCount = lines || 100;
  try {
    return execSync(`${TMUX_BIN} capture-pane -t ${sess} -p -S -${lineCount}`, {
      encoding: 'utf-8',
    });
  } catch {
    return `[session "${name}" not found]`;
  }
}

export function waitForOutput(name: string, pattern: string, timeoutMs?: number): { found: boolean; output: string } {
  const timeout = timeoutMs || 30_000;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const output = captureTerminal(name, 200);
    if (output.includes(pattern)) return { found: true, output };
    spawnSync('sleep', ['0.5']);
  }
  return { found: false, output: captureTerminal(name, 200) };
}

export function getProcessLogs(name: string, lines?: number): string {
  const file = logPath(name);
  if (!fs.existsSync(file)) return captureTerminal(name, lines);
  try {
    const content = fs.readFileSync(file, 'utf-8');
    const allLines = content.split('\n');
    const count = lines || 100;
    return allLines.slice(-count).join('\n');
  } catch {
    return captureTerminal(name, lines);
  }
}

export function openDashboard(): string {
  ensureTmuxServer();
  const processes = listProcesses();
  if (processes.length === 0) return 'No running processes to display.';

  const dashSess = `${TMUX_SESSION_PREFIX}dashboard`;
  try {
    execSync(`${TMUX_BIN} kill-session -t ${dashSess}`, { stdio: 'pipe' });
  } catch {
    /* ok */
  }

  const first = processes[0];
  execSync(`${TMUX_BIN} new-session -d -s ${dashSess} 'tail -f ${logPath(first.name)} 2>/dev/null || echo "no logs"'`, {
    stdio: 'pipe',
  });

  for (const proc of processes.slice(1)) {
    execSync(`${TMUX_BIN} split-window -t ${dashSess} 'tail -f ${logPath(proc.name)} 2>/dev/null || echo "no logs"'`, {
      stdio: 'pipe',
    });
  }

  execSync(`${TMUX_BIN} select-layout -t ${dashSess} tiled`, { stdio: 'pipe' });
  return `Dashboard created: tmux attach -t ${dashSess}`;
}
