import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgentQuiet } from '../approvals/index.js';
import * as executor from './executor.js';

export async function handleRunCommand(content: Record<string, unknown>, session: Session): Promise<void> {
  const command = content.command as string;
  if (!command) {
    notifyAgentQuiet(session, 'host_run_command failed: command is required.');
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
  notifyAgentQuiet(session, output);
}

export async function handleStartProcess(content: Record<string, unknown>, session: Session): Promise<void> {
  const name = content.name as string;
  const command = content.command as string;
  if (!name || !command) {
    notifyAgentQuiet(session, 'host_start_process failed: name and command are required.');
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
      notifyAgentQuiet(
        session,
        `Process "${name}" started (PID ${result.pid}). Ready: ${result.ready}\n${result.output}`,
      );
    } else {
      notifyAgentQuiet(session, `Process "${name}" started. PID: ${result.pid}`);
    }
  } catch (err) {
    notifyAgentQuiet(session, `host_start_process failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function handleStopProcess(content: Record<string, unknown>, session: Session): Promise<void> {
  const name = content.name as string;
  if (!name) {
    notifyAgentQuiet(session, 'host_stop_process failed: name is required.');
    return;
  }
  log.info('Host stop_process', { sessionId: session.id, name });
  executor.stopProcess(name);
  notifyAgentQuiet(session, `Process "${name}" stopped.`);
}

export async function handleRestartProcess(content: Record<string, unknown>, session: Session): Promise<void> {
  const name = content.name as string;
  const command = content.command as string;
  if (!name || !command) {
    notifyAgentQuiet(session, 'host_restart_process failed: name and command are required.');
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
    notifyAgentQuiet(session, `Process "${name}" restarted. PID: ${result.pid}`);
  } catch (err) {
    notifyAgentQuiet(session, `host_restart_process failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function handleListProcesses(_content: Record<string, unknown>, session: Session): Promise<void> {
  const processes = executor.listProcesses();
  if (processes.length === 0) {
    notifyAgentQuiet(session, 'No managed host processes running.');
    return;
  }
  const lines = processes.map((p) => `• ${p.name} (PID ${p.pid}) — ${p.status}`);
  notifyAgentQuiet(session, `Host processes:\n${lines.join('\n')}`);
}

export async function handleCaptureTerminal(content: Record<string, unknown>, session: Session): Promise<void> {
  const name = content.name as string;
  if (!name) {
    notifyAgentQuiet(session, 'host_capture_terminal failed: name is required.');
    return;
  }
  const lines = content.lines as number | undefined;
  const output = executor.captureTerminal(name, lines);
  notifyAgentQuiet(session, `Terminal capture for "${name}":\n${output}`);
}

export async function handleWaitForOutput(content: Record<string, unknown>, session: Session): Promise<void> {
  const name = content.name as string;
  const pattern = content.pattern as string;
  if (!name || !pattern) {
    notifyAgentQuiet(session, 'host_wait_for_output failed: name and pattern are required.');
    return;
  }
  const timeout = content.timeout as number | undefined;
  log.info('Host wait_for_output', { sessionId: session.id, name, pattern });
  const result = executor.waitForOutput(name, pattern, timeout);
  if (result.found) {
    notifyAgentQuiet(session, `Pattern "${pattern}" found in "${name}":\n${result.output.slice(-3000)}`);
  } else {
    notifyAgentQuiet(
      session,
      `Timeout waiting for "${pattern}" in "${name}". Last output:\n${result.output.slice(-3000)}`,
    );
  }
}

export async function handleGetProcessLogs(content: Record<string, unknown>, session: Session): Promise<void> {
  const name = content.name as string;
  if (!name) {
    notifyAgentQuiet(session, 'host_get_process_logs failed: name is required.');
    return;
  }
  const lines = content.lines as number | undefined;
  const output = executor.getProcessLogs(name, lines);
  notifyAgentQuiet(session, `Logs for "${name}":\n${output}`);
}

export async function handleOpenDashboard(_content: Record<string, unknown>, session: Session): Promise<void> {
  const result = executor.openDashboard();
  notifyAgentQuiet(session, result);
}

export async function handleStopAll(_content: Record<string, unknown>, session: Session): Promise<void> {
  log.info('Host stop_all', { sessionId: session.id });
  const stopped = executor.stopAll();
  if (stopped.length === 0) {
    notifyAgentQuiet(session, 'No running processes to stop.');
  } else {
    notifyAgentQuiet(session, `Stopped ${stopped.length} processes: ${stopped.join(', ')}`);
  }
}

export async function handleStartAll(content: Record<string, unknown>, session: Session): Promise<void> {
  const entries = content.entries as executor.BatchStartEntry[];
  if (!entries || !Array.isArray(entries) || entries.length === 0) {
    notifyAgentQuiet(session, 'host_start_all failed: entries array is required.');
    return;
  }
  log.info('Host start_all', { sessionId: session.id, count: entries.length });
  try {
    const results = executor.startAll(entries);
    const lines = results.map((r) => `• ${r.name} (PID ${r.pid}) — ${r.ready ? 'ready' : 'started'}`);
    notifyAgentQuiet(session, `Started ${results.length} processes:\n${lines.join('\n')}`);
  } catch (err) {
    notifyAgentQuiet(session, `host_start_all failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
