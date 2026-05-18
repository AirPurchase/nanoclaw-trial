import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

const hostRunCommand: McpToolDefinition = {
  tool: {
    name: 'host_run_command',
    description: 'Run a one-shot command on the host machine. Returns stdout, stderr, and exit code.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        cwd: { type: 'string', description: 'Working directory (optional)' },
        timeout: { type: 'number', description: 'Timeout in ms (default 60000)' },
      },
      required: ['command'],
    },
  },
  async handler(args) {
    if (!args.command) return err('command is required');
    writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({ action: 'host_run_command', ...args }),
    });
    return ok('Command submitted. Result will arrive as a message.');
  },
};

const hostStartProcess: McpToolDefinition = {
  tool: {
    name: 'host_start_process',
    description: 'Start a named long-running process on the host in a tmux session. Optionally waits for a ready pattern in the output before returning.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Unique process name' },
        command: { type: 'string', description: 'Shell command to run' },
        cwd: { type: 'string', description: 'Working directory' },
        env: { type: 'object', description: 'Environment variables (key-value pairs)' },
        port: { type: 'number', description: 'Port to kill before starting (optional)' },
        readyPattern: { type: 'string', description: 'Wait for this text in output before reporting ready (e.g. "Compiled successfully", "listening on")' },
        readyTimeout: { type: 'number', description: 'Max ms to wait for readyPattern (default 15000)' },
      },
      required: ['name', 'command'],
    },
  },
  async handler(args) {
    if (!args.name || !args.command) return err('name and command are required');
    writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({ action: 'host_start_process', ...args }),
    });
    return ok(`Process "${args.name}" start request submitted.`);
  },
};

const hostStopProcess: McpToolDefinition = {
  tool: {
    name: 'host_stop_process',
    description: 'Stop a named host process.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Process name to stop' },
      },
      required: ['name'],
    },
  },
  async handler(args) {
    if (!args.name) return err('name is required');
    writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({ action: 'host_stop_process', ...args }),
    });
    return ok(`Process "${args.name}" stop request submitted.`);
  },
};

const hostRestartProcess: McpToolDefinition = {
  tool: {
    name: 'host_restart_process',
    description: 'Restart a named host process (stop + start with same config).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Process name' },
        command: { type: 'string', description: 'Shell command to run' },
        cwd: { type: 'string', description: 'Working directory' },
        env: { type: 'object', description: 'Environment variables' },
        port: { type: 'number', description: 'Port to kill before starting' },
      },
      required: ['name', 'command'],
    },
  },
  async handler(args) {
    if (!args.name || !args.command) return err('name and command are required');
    writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({ action: 'host_restart_process', ...args }),
    });
    return ok(`Process "${args.name}" restart request submitted.`);
  },
};

const hostListProcesses: McpToolDefinition = {
  tool: {
    name: 'host_list_processes',
    description: 'List all managed host processes.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  async handler() {
    writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({ action: 'host_list_processes' }),
    });
    return ok('Process list request submitted. Result will arrive as a message.');
  },
};

const hostCaptureTerminal: McpToolDefinition = {
  tool: {
    name: 'host_capture_terminal',
    description: 'Capture current terminal output from a named host process.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Process name' },
        lines: { type: 'number', description: 'Number of lines to capture (default 100)' },
      },
      required: ['name'],
    },
  },
  async handler(args) {
    if (!args.name) return err('name is required');
    writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({ action: 'host_capture_terminal', ...args }),
    });
    return ok('Terminal capture request submitted. Result will arrive as a message.');
  },
};

const hostWaitForOutput: McpToolDefinition = {
  tool: {
    name: 'host_wait_for_output',
    description: 'Wait for a specific pattern to appear in a host process terminal output.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Process name' },
        pattern: { type: 'string', description: 'Text pattern to wait for' },
        timeout: { type: 'number', description: 'Timeout in ms (default 30000)' },
      },
      required: ['name', 'pattern'],
    },
  },
  async handler(args) {
    if (!args.name || !args.pattern) return err('name and pattern are required');
    writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({ action: 'host_wait_for_output', ...args }),
    });
    return ok('Wait-for-output request submitted. Result will arrive as a message.');
  },
};

const hostGetProcessLogs: McpToolDefinition = {
  tool: {
    name: 'host_get_process_logs',
    description: 'Get recent log output from a named host process.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Process name' },
        lines: { type: 'number', description: 'Number of lines (default 100)' },
      },
      required: ['name'],
    },
  },
  async handler(args) {
    if (!args.name) return err('name is required');
    writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({ action: 'host_get_process_logs', ...args }),
    });
    return ok('Log request submitted. Result will arrive as a message.');
  },
};

const hostOpenDashboard: McpToolDefinition = {
  tool: {
    name: 'host_open_dashboard',
    description: 'Open a tmux dashboard showing all running host processes.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  async handler() {
    writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({ action: 'host_open_dashboard' }),
    });
    return ok('Dashboard request submitted. Result will arrive as a message.');
  },
};

const hostStopAll: McpToolDefinition = {
  tool: {
    name: 'host_stop_all',
    description: 'Stop ALL running nanoclaw service processes at once. Much faster than stopping individually.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  async handler() {
    writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({ action: 'host_stop_all' }),
    });
    return ok('Stop-all request submitted. Result will arrive as a message.');
  },
};

const hostStartAll: McpToolDefinition = {
  tool: {
    name: 'host_start_all',
    description: 'Start multiple named processes in one batch. Much faster than starting individually. Each entry needs name, command, and optionally cwd, port, readyPattern.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entries: {
          type: 'array',
          description: 'Array of process configs to start',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Process name' },
              command: { type: 'string', description: 'Shell command' },
              cwd: { type: 'string', description: 'Working directory' },
              port: { type: 'number', description: 'Port to kill before starting' },
              readyPattern: { type: 'string', description: 'Wait for this output before reporting ready' },
              readyTimeout: { type: 'number', description: 'Max ms to wait for readyPattern (default 15000)' },
            },
            required: ['name', 'command'],
          },
        },
      },
      required: ['entries'],
    },
  },
  async handler(args) {
    const entries = args.entries as unknown[];
    if (!entries || !Array.isArray(entries) || entries.length === 0) return err('entries array is required');
    writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({ action: 'host_start_all', entries }),
    });
    return ok(`Start-all request submitted for ${entries.length} processes. Result will arrive as a message.`);
  },
};

registerTools([
  hostRunCommand,
  hostStartProcess,
  hostStopProcess,
  hostRestartProcess,
  hostListProcesses,
  hostCaptureTerminal,
  hostWaitForOutput,
  hostGetProcessLogs,
  hostOpenDashboard,
  hostStopAll,
  hostStartAll,
]);
