import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

const HOST_EXEC_DIR = path.join(DATA_DIR, 'host-exec');
const RESULTS_DIR = path.join(HOST_EXEC_DIR, 'results');
const LOGS_DIR = path.join(HOST_EXEC_DIR, 'logs');
const STATE_FILE = path.join(HOST_EXEC_DIR, 'processes.json');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const COMMAND_TIMEOUT = 60_000;
const TMUX_SESSION_PREFIX = 'nanoclaw-';

// Resolve tmux binary path — needed because launchd PATH may not include /opt/homebrew/bin
const TMUX_BIN = (() => {
  const candidates = [
    '/opt/homebrew/bin/tmux',
    '/usr/local/bin/tmux',
    '/usr/bin/tmux',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'tmux'; // fallback to PATH
})();

export interface ManagedProcess {
  name: string;
  command: string;
  cwd: string;
  pid: number;
  status: 'running' | 'stopped' | 'crashed';
  startedAt: string;
  exitCode?: number | null;
  env?: Record<string, string>;
  port?: number;
}

export interface CommandResult {
  id: string;
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

const processes = new Map<string, ManagedProcess>();

function ensureDirs(): void {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function saveState(): void {
  const state = Object.fromEntries(processes);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function writeResult(id: string, data: object): void {
  const tmp = path.join(RESULTS_DIR, `${id}.json.tmp`);
  const final = path.join(RESULTS_DIR, `${id}.json`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, final);
}

function rotateLogIfNeeded(logPath: string): void {
  try {
    const stat = fs.statSync(logPath);
    if (stat.size > MAX_LOG_SIZE) {
      const rotated = logPath + '.1';
      if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
      fs.renameSync(logPath, rotated);
    }
  } catch {
    // file doesn't exist yet
  }
}

function tmuxSessionName(name: string): string {
  return `${TMUX_SESSION_PREFIX}${name}`;
}

function isTmuxSessionAlive(name: string): boolean {
  try {
    execSync(
      `${TMUX_BIN} has-session -t ${tmuxSessionName(name)} 2>/dev/null`,
      {
        stdio: 'ignore',
      },
    );
    return true;
  } catch {
    return false;
  }
}

function killPort(port: number): void {
  if (!port) return;
  try {
    execSync(`lsof -ti :${port} | xargs kill 2>/dev/null`, {
      timeout: 5000,
      stdio: 'ignore',
    });
  } catch {
    // nothing on that port, fine
  }
}

export function initHostExecutor(): void {
  ensureDirs();
  // Reload state from previous run — check tmux sessions
  if (fs.existsSync(STATE_FILE)) {
    try {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      for (const [name, proc] of Object.entries(state) as [
        string,
        ManagedProcess,
      ][]) {
        if (proc.status === 'running' && isTmuxSessionAlive(name)) {
          // Get current PID from tmux pane
          try {
            const pid = parseInt(
              execSync(
                `${TMUX_BIN} list-panes -t ${tmuxSessionName(name)} -F '#{pane_pid}'`,
                { encoding: 'utf-8' },
              ).trim(),
              10,
            );
            proc.pid = pid;
          } catch {
            /* keep old PID */
          }
          processes.set(name, proc);
          logger.info({ name, pid: proc.pid }, 'Reconnected to tmux session');
        } else if (proc.status === 'running') {
          proc.status = 'crashed';
          processes.set(name, proc);
          logger.warn({ name }, 'tmux session died while NanoClaw was down');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Failed to reload host-executor state');
    }
  }

  // Discover any nanoclaw-* tmux sessions not in the state file
  // (e.g. created by agent's run_command calls or from a previous state wipe)
  try {
    const tmuxOutput = execSync(
      `${TMUX_BIN} ls -F "#{session_name}" 2>/dev/null`,
      {
        encoding: 'utf-8',
      },
    );
    for (const sessionName of tmuxOutput.trim().split('\n')) {
      if (!sessionName.startsWith(TMUX_SESSION_PREFIX)) continue;
      const name = sessionName.slice(TMUX_SESSION_PREFIX.length);
      if (processes.has(name)) continue;
      try {
        const pid = parseInt(
          execSync(
            `${TMUX_BIN} list-panes -t ${sessionName} -F '#{pane_pid}'`,
            { encoding: 'utf-8' },
          ).trim(),
          10,
        );
        const managed: ManagedProcess = {
          name,
          command: '(discovered)',
          cwd: '(unknown)',
          pid,
          status: 'running',
          startedAt: new Date().toISOString(),
        };
        processes.set(name, managed);
        logger.info(
          { name, pid, sessionName },
          'Discovered orphaned tmux session',
        );
      } catch {
        /* skip */
      }
    }
  } catch {
    /* tmux not running or no sessions */
  }

  saveState();

  // Start tmux session monitor — auto-opens dashboard when services are running
  startTmuxMonitor();
}

let dashboardOpen = false;
let monitorRunning = false;

function startTmuxMonitor(): void {
  if (monitorRunning) return;
  monitorRunning = true;

  const check = () => {
    try {
      const tmuxOutput = execSync(
        `${TMUX_BIN} ls -F "#{session_name} #{session_attached}" 2>/dev/null`,
        {
          encoding: 'utf-8',
        },
      );
      const lines = tmuxOutput.trim().split('\n').filter(Boolean);
      const serviceSessions = lines.filter(
        (l) =>
          l.startsWith(TMUX_SESSION_PREFIX) &&
          !l.startsWith('nanoclaw-dashboard') &&
          !l.startsWith('nanoclaw-playwright'),
      );

      // Check if dashboard exists and is attached
      const dashboardLine = lines.find((l) =>
        l.startsWith('nanoclaw-dashboard'),
      );
      const dashboardAttached = dashboardLine && dashboardLine.includes(' 1');

      // Auto-open dashboard when 3+ service sessions exist and dashboard isn't showing
      if (serviceSessions.length >= 3 && !dashboardOpen) {
        dashboardOpen = true; // Set immediately to prevent repeated attempts
        logger.info(
          { sessionCount: serviceSessions.length },
          'Auto-opening tmux dashboard — detected service sessions',
        );
        autoOpenDashboard(
          serviceSessions.map((l) =>
            l.split(' ')[0].slice(TMUX_SESSION_PREFIX.length),
          ),
        );
      }

      // Reset flag if all service sessions are gone
      if (serviceSessions.length === 0) {
        dashboardOpen = false;
      }

      // Reset flag if dashboard was closed by user
      if (
        dashboardOpen &&
        !dashboardAttached &&
        !lines.some((l) => l.startsWith('nanoclaw-dashboard'))
      ) {
        dashboardOpen = false;
      }
    } catch {
      // tmux not running
    }

    setTimeout(check, 10_000);
  };

  setTimeout(check, 10_000);
}

function autoOpenDashboard(serviceNames: string[]): void {
  try {
    // Kill existing dashboard
    try {
      execSync(`${TMUX_BIN} kill-session -t nanoclaw-dashboard 2>/dev/null`, {
        stdio: 'ignore',
      });
    } catch {
      /* ok */
    }

    // Create dashboard with panes tailing each service log
    const firstLog = path.join(LOGS_DIR, `${serviceNames[0]}.log`);
    execSync(
      `${TMUX_BIN} new-session -d -s nanoclaw-dashboard -x 200 -y 60 'tail -f ${JSON.stringify(firstLog)}'`,
      { stdio: 'ignore' },
    );

    for (let i = 1; i < serviceNames.length; i++) {
      const logFile = path.join(LOGS_DIR, `${serviceNames[i]}.log`);
      const splitDir = i % 2 === 1 ? '-v' : '-h';
      execSync(
        `${TMUX_BIN} split-window -t nanoclaw-dashboard ${splitDir} 'tail -f ${JSON.stringify(logFile)}'`,
        { stdio: 'ignore' },
      );
    }

    execSync(`${TMUX_BIN} select-layout -t nanoclaw-dashboard tiled`, {
      stdio: 'ignore',
    });

    // Open Terminal.app attached to the dashboard
    execSync(
      `osascript -e 'tell app "Terminal" to do script "${TMUX_BIN} attach -t nanoclaw-dashboard"'`,
      { stdio: 'ignore' },
    );

    logger.info(
      { services: serviceNames },
      'Auto-opened tmux dashboard in Terminal.app',
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, 'Failed to auto-open dashboard');
  }
}

export async function runCommand(
  id: string,
  command: string,
  cwd: string,
  timeout = COMMAND_TIMEOUT,
): Promise<void> {
  ensureDirs();
  const start = Date.now();
  logger.info({ id, command, cwd }, 'Running host command');

  if (!fs.existsSync(cwd)) {
    writeResult(id, {
      id,
      command,
      cwd,
      exitCode: 1,
      stdout: '',
      stderr: `Working directory does not exist: ${cwd}`,
      durationMs: Date.now() - start,
    });
    logger.warn({ id, cwd }, 'Host command failed: cwd does not exist');
    return;
  }

  return new Promise<void>((resolve) => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const child = spawn('bash', ['-c', command], {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      writeResult(id, {
        id,
        command,
        cwd,
        exitCode: 1,
        stdout: '',
        stderr: `Spawn error: ${err.message}`,
        durationMs: Date.now() - start,
      });
      logger.error({ id, err: err.message }, 'Host command spawn error');
      resolve();
    });

    child.stdout.on('data', (d: Buffer) => stdoutChunks.push(d.toString()));
    child.stderr.on('data', (d: Buffer) => stderrChunks.push(d.toString()));

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      writeResult(id, {
        id,
        command,
        cwd,
        exitCode: code,
        stdout: stdoutChunks.join('').split('\n').slice(-500).join('\n'),
        stderr: stderrChunks.join('').split('\n').slice(-500).join('\n'),
        durationMs: Date.now() - start,
      });
      logger.info(
        { id, exitCode: code, durationMs: Date.now() - start },
        'Host command completed',
      );
      resolve();
    });
  });
}

export function startProcess(
  requestId: string,
  name: string,
  command: string,
  cwd: string,
  env?: Record<string, string>,
  port?: number,
): void {
  ensureDirs();

  if (!fs.existsSync(cwd)) {
    writeResult(requestId, {
      name,
      error: `Working directory does not exist: ${cwd}`,
    });
    logger.warn({ name, cwd }, 'Start process failed: cwd does not exist');
    return;
  }

  // Force-kill any existing tmux session with same name (don't just check — always kill)
  try {
    execSync(
      `${TMUX_BIN} kill-session -t ${tmuxSessionName(name)} 2>/dev/null`,
      { stdio: 'ignore' },
    );
    logger.debug({ name }, 'Killed existing tmux session before restart');
  } catch {
    /* no existing session, fine */
  }

  // Kill anything on the target port
  if (port) killPort(port);

  // Set up log file
  const logPath = path.join(LOGS_DIR, `${name}.log`);
  rotateLogIfNeeded(logPath);
  const header = `\n--- ${name} started at ${new Date().toISOString()} ---\n--- command: ${command} ---\n--- cwd: ${cwd} ---\n\n`;
  fs.appendFileSync(logPath, header);

  // Write command to a script file to avoid shell quoting issues with tmux
  // Auto-setup: load nvm with system default Node (v18), add homebrew to PATH
  const session = tmuxSessionName(name);
  const scriptPath = path.join(HOST_EXEC_DIR, `${name}.sh`);
  const scriptContent = [
    '#!/bin/bash',
    '# Auto-setup: nvm (system default Node v18) + homebrew PATH',
    'export PATH="/opt/homebrew/bin:$PATH"',
    'export NVM_DIR="$HOME/.nvm"',
    '[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"',
    '',
    `cd ${JSON.stringify(cwd)}`,
    ...(env
      ? Object.entries(env).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
      : []),
    command,
  ].join('\n');
  fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });

  // Attempt to start in tmux — retry once if first attempt fails
  let tmuxStarted = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // Force-kill again in case of race condition on retry
      if (attempt > 0) {
        try {
          execSync(`${TMUX_BIN} kill-session -t ${session} 2>/dev/null`, {
            stdio: 'ignore',
          });
        } catch {
          /* ok */
        }
        // Brief pause before retry
        execSync('sleep 1', { stdio: 'ignore' });
      }

      execSync(
        `${TMUX_BIN} new-session -d -s ${session} -x 200 -y 50 'bash ${JSON.stringify(scriptPath)}'`,
        { encoding: 'utf-8', timeout: 10000 },
      );

      // Pipe tmux output to log file for persistence
      execSync(
        `${TMUX_BIN} pipe-pane -t ${session} -o 'cat >> ${JSON.stringify(logPath)}'`,
        { stdio: 'ignore' },
      );

      // Get the PID of the process inside tmux
      const pid = parseInt(
        execSync(`${TMUX_BIN} list-panes -t ${session} -F '#{pane_pid}'`, {
          encoding: 'utf-8',
        }).trim(),
        10,
      );

      const managed: ManagedProcess = {
        name,
        command,
        cwd,
        pid,
        status: 'running',
        startedAt: new Date().toISOString(),
        env,
        port,
      };
      processes.set(name, managed);
      saveState();

      logger.info(
        { name, pid, port, session, attempt },
        'Started host process in tmux session',
      );
      writeResult(requestId, {
        name,
        pid,
        status: 'running',
        port,
        tmuxSession: session,
      });
      tmuxStarted = true;
      break;
    } catch (err) {
      // Extract actual stderr from execSync error
      const execErr = err as { stderr?: string; message?: string };
      const stderr = execErr.stderr || execErr.message || String(err);
      logger.warn(
        { name, attempt, stderr: stderr.slice(0, 300) },
        'tmux new-session failed',
      );
    }
  }

  // Fallback: if tmux completely fails, use raw spawn so the process still starts
  if (!tmuxStarted) {
    logger.warn(
      { name },
      'tmux failed after 2 attempts, falling back to raw spawn',
    );
    try {
      const logStream = fs.createWriteStream(logPath, { flags: 'a' });
      logStream.write(`--- tmux failed, using raw spawn fallback ---\n`);

      const childEnv = { ...process.env, ...env };
      const child = spawn('bash', [scriptPath], {
        cwd,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });

      child.on('error', (spawnErr) => {
        logger.error(
          { name, err: spawnErr.message },
          'Spawn fallback also failed',
        );
        writeResult(requestId, {
          name,
          error: `Both tmux and spawn failed: ${spawnErr.message}`,
        });
        logStream.end();
      });

      child.stdout.pipe(logStream, { end: false });
      child.stderr.pipe(logStream, { end: false });
      child.unref();

      const managed: ManagedProcess = {
        name,
        command,
        cwd,
        pid: child.pid!,
        status: 'running',
        startedAt: new Date().toISOString(),
        env,
        port,
      };
      processes.set(name, managed);
      saveState();

      child.on('close', (code) => {
        const proc = processes.get(name);
        if (proc && proc.pid === child.pid) {
          proc.status = code === 0 ? 'stopped' : 'crashed';
          proc.exitCode = code;
          saveState();
          logStream.write(
            `\n--- ${name} exited with code ${code} at ${new Date().toISOString()} ---\n`,
          );
        }
        logStream.end();
      });

      logger.info(
        { name, pid: child.pid, port },
        'Started host process via spawn fallback',
      );
      writeResult(requestId, {
        name,
        pid: child.pid,
        status: 'running',
        port,
        fallback: 'spawn',
      });
    } catch (spawnErr) {
      const msg =
        spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
      logger.error({ name, err: msg }, 'Spawn fallback failed');
      writeResult(requestId, {
        name,
        error: `All start methods failed: ${msg}`,
      });
    }
  }
}

export function stopProcess(requestId: string, name: string): void {
  ensureDirs();
  const proc = processes.get(name);
  if (!proc) {
    writeResult(requestId, { error: `No process named "${name}"` });
    return;
  }

  // Kill the tmux session
  if (isTmuxSessionAlive(name)) {
    try {
      execSync(
        `${TMUX_BIN} kill-session -t ${tmuxSessionName(name)} 2>/dev/null`,
        {
          stdio: 'ignore',
        },
      );
    } catch {
      /* ok */
    }
  }

  // Also kill the port to be safe
  if (proc.port) killPort(proc.port);

  proc.status = 'stopped';
  saveState();

  const logPath = path.join(LOGS_DIR, `${name}.log`);
  fs.appendFileSync(
    logPath,
    `\n--- ${name} stopped at ${new Date().toISOString()} ---\n`,
  );

  logger.info(
    { name, pid: proc.pid },
    'Stopped host process (tmux session killed)',
  );
  writeResult(requestId, { name, status: 'stopped' });
}

export function restartProcess(requestId: string, name: string): void {
  const proc = processes.get(name);
  if (!proc) {
    writeResult(requestId, { error: `No process named "${name}"` });
    return;
  }

  // Kill existing tmux session
  if (isTmuxSessionAlive(name)) {
    try {
      execSync(
        `${TMUX_BIN} kill-session -t ${tmuxSessionName(name)} 2>/dev/null`,
        {
          stdio: 'ignore',
        },
      );
    } catch {
      /* ok */
    }
  }
  if (proc.port) killPort(proc.port);

  // Brief delay then restart
  setTimeout(() => {
    startProcess(
      requestId,
      proc.name,
      proc.command,
      proc.cwd,
      proc.env,
      proc.port,
    );
  }, 1000);
}

// PLACEHOLDER_NEW_FUNCS

export function captureTerminal(
  requestId: string,
  name: string,
  lines = 50,
): void {
  ensureDirs();
  if (!isTmuxSessionAlive(name)) {
    writeResult(requestId, {
      name,
      error: `No active tmux session for "${name}"`,
      output: '',
    });
    return;
  }
  try {
    const output = execSync(
      `${TMUX_BIN} capture-pane -t ${tmuxSessionName(name)} -p -S -${lines}`,
      { encoding: 'utf-8', timeout: 5000 },
    );
    writeResult(requestId, { name, output });
  } catch (err) {
    writeResult(requestId, {
      name,
      error: `Failed to capture terminal: ${err instanceof Error ? err.message : String(err)}`,
      output: '',
    });
  }
}

export async function waitForOutput(
  requestId: string,
  name: string,
  pattern: string,
  timeoutMs = 60_000,
): Promise<void> {
  ensureDirs();
  const start = Date.now();
  const pollInterval = 2000;

  const check = (): void => {
    if (Date.now() - start > timeoutMs) {
      // Timeout — capture final terminal state for debugging
      let lastOutput = '';
      try {
        lastOutput = execSync(
          `${TMUX_BIN} capture-pane -t ${tmuxSessionName(name)} -p -S -30`,
          { encoding: 'utf-8', timeout: 5000 },
        );
      } catch {
        /* ok */
      }
      writeResult(requestId, {
        name,
        pattern,
        found: false,
        message: `Timed out after ${timeoutMs}ms waiting for "${pattern}"`,
        lastTerminalOutput: lastOutput,
      });
      return;
    }

    if (!isTmuxSessionAlive(name)) {
      writeResult(requestId, {
        name,
        pattern,
        found: false,
        message: `tmux session "${name}" is not running`,
      });
      return;
    }

    try {
      const output = execSync(
        `${TMUX_BIN} capture-pane -t ${tmuxSessionName(name)} -p -S -100`,
        { encoding: 'utf-8', timeout: 5000 },
      );
      if (output.includes(pattern)) {
        writeResult(requestId, {
          name,
          pattern,
          found: true,
          message: `Pattern "${pattern}" found after ${Date.now() - start}ms`,
          terminalOutput: output,
        });
        return;
      }
    } catch {
      /* capture failed, retry */
    }

    setTimeout(check, pollInterval);
  };

  check();
}

export function listProcesses(requestId: string): void {
  ensureDirs();
  const list: ManagedProcess[] = [];
  for (const [name, proc] of processes) {
    // Check tmux session status
    if (proc.status === 'running' && !isTmuxSessionAlive(name)) {
      proc.status = 'crashed';
    }
    list.push(proc);
  }
  saveState();
  writeResult(requestId, { processes: list });
}

export function getProcessLogs(
  requestId: string,
  name: string,
  lines = 100,
): void {
  ensureDirs();
  const logPath = path.join(LOGS_DIR, `${name}.log`);
  if (!fs.existsSync(logPath)) {
    writeResult(requestId, { error: `No logs for "${name}"`, lines: [] });
    return;
  }
  const content = fs.readFileSync(logPath, 'utf-8');
  const allLines = content.split('\n');
  const tail = allLines.slice(-lines).join('\n');
  writeResult(requestId, { name, lineCount: allLines.length, output: tail });
}

export function getLogsDir(): string {
  return LOGS_DIR;
}
export function getResultsDir(): string {
  return RESULTS_DIR;
}
export function getHostExecDir(): string {
  return HOST_EXEC_DIR;
}

export function openDashboard(requestId: string): void {
  ensureDirs();

  // Discover running nanoclaw-* tmux sessions directly (don't rely on processes Map)
  let running: string[] = [];
  try {
    const tmuxOutput = execSync(
      `${TMUX_BIN} ls -F "#{session_name}" 2>/dev/null`,
      { encoding: 'utf-8' },
    );
    running = tmuxOutput
      .trim()
      .split('\n')
      .filter(
        (s) => s.startsWith(TMUX_SESSION_PREFIX) && s !== 'nanoclaw-dashboard',
      )
      .map((s) => s.slice(TMUX_SESSION_PREFIX.length));
  } catch {
    /* no tmux sessions */
  }

  if (running.length === 0) {
    writeResult(requestId, { error: 'No running tmux sessions to display' });
    return;
  }

  try {
    // Kill existing dashboard
    try {
      execSync(`${TMUX_BIN} kill-session -t nanoclaw-dashboard 2>/dev/null`, {
        stdio: 'ignore',
      });
    } catch {
      /* ok */
    }

    // Create dashboard — first pane with the first process log
    const firstLog = path.join(LOGS_DIR, `${running[0]}.log`);
    execSync(
      `${TMUX_BIN} new-session -d -s nanoclaw-dashboard -x 200 -y 60 'tail -f ${JSON.stringify(firstLog)}'`,
      { stdio: 'ignore' },
    );

    // Split panes for remaining processes
    for (let i = 1; i < running.length; i++) {
      const logFile = path.join(LOGS_DIR, `${running[i]}.log`);
      const splitDir = i % 2 === 1 ? '-v' : '-h';
      execSync(
        `${TMUX_BIN} split-window -t nanoclaw-dashboard ${splitDir} 'tail -f ${JSON.stringify(logFile)}'`,
        { stdio: 'ignore' },
      );
    }

    // Tile the layout evenly
    execSync(`${TMUX_BIN} select-layout -t nanoclaw-dashboard tiled`, {
      stdio: 'ignore',
    });

    // Open Terminal.app attached to the dashboard
    execSync(
      `osascript -e 'tell app "Terminal" to do script "${TMUX_BIN} attach -t nanoclaw-dashboard"'`,
      { stdio: 'ignore' },
    );

    logger.info(
      { processes: running },
      'Opened tmux dashboard in Terminal.app',
    );
    writeResult(requestId, {
      status: 'opened',
      processes: running,
      message: `Dashboard opened with ${running.length} panes in Terminal.app`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, 'Failed to open dashboard');
    writeResult(requestId, { error: `Failed to open dashboard: ${msg}` });
  }
}
