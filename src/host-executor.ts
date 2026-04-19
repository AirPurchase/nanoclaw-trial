import { spawn, ChildProcess, execSync } from 'child_process';
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
const KILL_GRACE_MS = 5_000;

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
const childRefs = new Map<string, ChildProcess>();

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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
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
  // Reload state from previous run
  if (fs.existsSync(STATE_FILE)) {
    try {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      for (const [name, proc] of Object.entries(state) as [
        string,
        ManagedProcess,
      ][]) {
        if (proc.status === 'running' && isProcessAlive(proc.pid)) {
          processes.set(name, proc);
          logger.info(
            { name, pid: proc.pid },
            'Reconnected to running process',
          );
        } else if (proc.status === 'running') {
          proc.status = 'crashed';
          processes.set(name, proc);
          logger.warn(
            { name, pid: proc.pid },
            'Process died while NanoClaw was down',
          );
        }
      }
      saveState();
    } catch (err) {
      logger.error({ err }, 'Failed to reload host-executor state');
    }
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

  // Validate cwd exists before spawning
  if (!fs.existsSync(cwd)) {
    const result: CommandResult = {
      id,
      command,
      cwd,
      exitCode: 1,
      stdout: '',
      stderr: `Working directory does not exist: ${cwd}`,
      durationMs: Date.now() - start,
    };
    writeResult(id, result);
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
      const result: CommandResult = {
        id,
        command,
        cwd,
        exitCode: 1,
        stdout: '',
        stderr: `Spawn error: ${err.message}`,
        durationMs: Date.now() - start,
      };
      writeResult(id, result);
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
      const result: CommandResult = {
        id,
        command,
        cwd,
        exitCode: code,
        stdout: stdoutChunks.join('').split('\n').slice(-500).join('\n'),
        stderr: stderrChunks.join('').split('\n').slice(-500).join('\n'),
        durationMs: Date.now() - start,
      };
      writeResult(id, result);
      logger.info(
        { id, exitCode: code, durationMs: result.durationMs },
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

  // Validate cwd exists
  if (!fs.existsSync(cwd)) {
    writeResult(requestId, {
      name,
      error: `Working directory does not exist: ${cwd}`,
    });
    logger.warn({ name, cwd }, 'Start process failed: cwd does not exist');
    return;
  }

  // Stop existing process with same name
  const existing = processes.get(name);
  if (
    existing &&
    existing.status === 'running' &&
    isProcessAlive(existing.pid)
  ) {
    logger.info(
      { name, pid: existing.pid },
      'Stopping existing process before restart',
    );
    try {
      process.kill(existing.pid, 'SIGTERM');
    } catch {
      /* already dead */
    }
    childRefs.delete(name);
  }

  // Kill anything on the target port
  if (port) killPort(port);

  const logPath = path.join(LOGS_DIR, `${name}.log`);
  rotateLogIfNeeded(logPath);
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  const header = `\n--- ${name} started at ${new Date().toISOString()} ---\n--- command: ${command} ---\n--- cwd: ${cwd} ---\n\n`;
  logStream.write(header);

  const childEnv = { ...process.env, ...env };
  const child = spawn('bash', ['-c', command], {
    cwd,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  child.on('error', (err) => {
    logger.error({ name, err: err.message }, 'Start process spawn error');
    writeResult(requestId, { name, error: `Spawn error: ${err.message}` });
    logStream.write(`\n--- SPAWN ERROR: ${err.message} ---\n`);
    logStream.end();
    return;
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
  childRefs.set(name, child);
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
    childRefs.delete(name);
  });

  logger.info({ name, pid: child.pid, port }, 'Started host process');
  writeResult(requestId, { name, pid: child.pid, status: 'running', port });
}

export function stopProcess(requestId: string, name: string): void {
  ensureDirs();
  const proc = processes.get(name);
  if (!proc) {
    writeResult(requestId, { error: `No process named "${name}"` });
    return;
  }
  if (proc.status !== 'running' || !isProcessAlive(proc.pid)) {
    proc.status = 'stopped';
    saveState();
    writeResult(requestId, {
      name,
      status: 'stopped',
      message: 'Process was not running',
    });
    return;
  }

  try {
    process.kill(proc.pid, 'SIGTERM');
  } catch {
    /* already dead */
  }

  // Grace period then SIGKILL
  setTimeout(() => {
    if (isProcessAlive(proc.pid)) {
      try {
        process.kill(proc.pid, 'SIGKILL');
      } catch {
        /* ok */
      }
    }
  }, KILL_GRACE_MS);

  proc.status = 'stopped';
  saveState();
  if (proc.port) killPort(proc.port);
  logger.info({ name, pid: proc.pid }, 'Stopped host process');
  writeResult(requestId, { name, status: 'stopped' });
}

export function restartProcess(requestId: string, name: string): void {
  const proc = processes.get(name);
  if (!proc) {
    writeResult(requestId, { error: `No process named "${name}"` });
    return;
  }

  // Stop first
  if (proc.status === 'running' && isProcessAlive(proc.pid)) {
    try {
      process.kill(proc.pid, 'SIGTERM');
    } catch {
      /* ok */
    }
    if (proc.port) killPort(proc.port);
  }

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

export function listProcesses(requestId: string): void {
  ensureDirs();
  const list: ManagedProcess[] = [];
  for (const [, proc] of processes) {
    if (proc.status === 'running' && !isProcessAlive(proc.pid)) {
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
