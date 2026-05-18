import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/index.js';
import * as executor from './executor.js';

export async function handleRunCommand(content: Record<string, unknown>, session: Session): Promise<void> {
  const command = content.command as string;
  if (!command) {
    notifyAgent(session, 'host_run_command failed: command is required.');
    return;
  }
  const cwd = content.cwd as string | undefined;
  const timeout = content.timeout as number | undefined;

  log.info('Host run_command', { sessionId: session.id, command, cwd });
  const result = executor.runCommand(command, { cwd, timeout });
  const output = [
    `Exit code: ${result.exitCode} (${result.durationMs}ms)`,
    result.stdout ? `stdout:\n${result.stdout}` : '',
    result.stderr ? `stderr:\n${result.stderr}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  notifyAgent(session, output);
}

export async function handleStartProcess(content: Record<string, unknown>, session: Session): Promise<void> {
  const name = content.name as string;
  const command = content.command as string;
  if (!name || !command) {
    notifyAgent(session, 'host_start_process failed: name and command are required.');
    return;
  }

  log.info('Host start_process', { sessionId: session.id, name, command });
  try {
    const result = executor.startProcess({
      name,
      command,
      cwd: content.cwd as string | undefined,
      env: content.env as Record<string, string> | undefined,
      port: content.port as number | undefined,
      readyPattern: content.readyPattern as string | undefined,
      readyTimeout: content.readyTimeout as number | undefined,
    });
    if (result.output) {
      notifyAgent(session, `Process "${name}" started (PID ${result.pid}). Ready: ${result.ready}\n${result.output}`);
    } else {
      notifyAgent(session, `Process "${name}" started. PID: ${result.pid}`);
    }
  } catch (err) {
    notifyAgent(session, `host_start_process failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function handleStopProcess(content: Record<string, unknown>, session: Session): Promise<void> {
  const name = content.name as string;
  if (!name) {
    notifyAgent(session, 'host_stop_process failed: name is required.');
    return;
  }
  log.info('Host stop_process', { sessionId: session.id, name });
  executor.stopProcess(name);
  notifyAgent(session, `Process "${name}" stopped.`);
}

export async function handleRestartProcess(content: Record<string, unknown>, session: Session): Promise<void> {
  const name = content.name as string;
  const command = content.command as string;
  if (!name || !command) {
    notifyAgent(session, 'host_restart_process failed: name and command are required.');
    return;
  }
  log.info('Host restart_process', { sessionId: session.id, name });
  try {
    const result = executor.restartProcess({
      name,
      command,
      cwd: content.cwd as string | undefined,
      env: content.env as Record<string, string> | undefined,
      port: content.port as number | undefined,
    });
    notifyAgent(session, `Process "${name}" restarted. PID: ${result.pid}`);
  } catch (err) {
    notifyAgent(session, `host_restart_process failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function handleListProcesses(_content: Record<string, unknown>, session: Session): Promise<void> {
  const processes = executor.listProcesses();
  if (processes.length === 0) {
    notifyAgent(session, 'No managed host processes running.');
    return;
  }
  const lines = processes.map((p) => `• ${p.name} (PID ${p.pid}) — ${p.status}`);
  notifyAgent(session, `Host processes:\n${lines.join('\n')}`);
}

export async function handleCaptureTerminal(content: Record<string, unknown>, session: Session): Promise<void> {
  const name = content.name as string;
  if (!name) {
    notifyAgent(session, 'host_capture_terminal failed: name is required.');
    return;
  }
  const lines = content.lines as number | undefined;
  const output = executor.captureTerminal(name, lines);
  notifyAgent(session, `Terminal capture for "${name}":\n${output}`);
}

export async function handleWaitForOutput(content: Record<string, unknown>, session: Session): Promise<void> {
  const name = content.name as string;
  const pattern = content.pattern as string;
  if (!name || !pattern) {
    notifyAgent(session, 'host_wait_for_output failed: name and pattern are required.');
    return;
  }
  const timeout = content.timeout as number | undefined;
  log.info('Host wait_for_output', { sessionId: session.id, name, pattern });
  const result = executor.waitForOutput(name, pattern, timeout);
  if (result.found) {
    notifyAgent(session, `Pattern "${pattern}" found in "${name}":\n${result.output.slice(-3000)}`);
  } else {
    notifyAgent(session, `Timeout waiting for "${pattern}" in "${name}". Last output:\n${result.output.slice(-3000)}`);
  }
}

export async function handleGetProcessLogs(content: Record<string, unknown>, session: Session): Promise<void> {
  const name = content.name as string;
  if (!name) {
    notifyAgent(session, 'host_get_process_logs failed: name is required.');
    return;
  }
  const lines = content.lines as number | undefined;
  const output = executor.getProcessLogs(name, lines);
  notifyAgent(session, `Logs for "${name}":\n${output}`);
}

export async function handleOpenDashboard(_content: Record<string, unknown>, session: Session): Promise<void> {
  const result = executor.openDashboard();
  notifyAgent(session, result);
}
