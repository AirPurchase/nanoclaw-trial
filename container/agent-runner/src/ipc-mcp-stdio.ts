/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z
      .string()
      .optional()
      .describe(
        'Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.',
      ),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z
      .string()
      .describe(
        'What the agent should do when the task runs. For isolated mode, include all necessary context here.',
      ),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .describe(
        'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time',
      ),
    schedule_value: z
      .string()
      .describe(
        'cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)',
      ),
    context_mode: z
      .enum(['group', 'isolated'])
      .default('group')
      .describe(
        'group=runs with chat history and memory, isolated=fresh session (include context in prompt)',
      ),
    target_group_jid: z
      .string()
      .optional()
      .describe(
        '(Main group only) JID of the group to schedule the task for. Defaults to the current group.',
      ),
    script: z
      .string()
      .optional()
      .describe(
        'Optional bash script to run before waking the agent. Script must output JSON on the last line of stdout: { "wakeAgent": boolean, "data"?: any }. If wakeAgent is false, the agent is not called. Test your script with bash -c "..." before scheduling.',
      ),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (
        /[Zz]$/.test(args.schedule_value) ||
        /[+-]\d{2}:\d{2}$/.test(args.schedule_value)
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid =
      isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      script: args.script || undefined,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}`,
        },
      ],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter(
            (t: { groupFolder: string }) => t.groupFolder === groupFolder,
          );

      if (tasks.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const formatted = tasks
        .map(
          (t: {
            id: string;
            prompt: string;
            schedule_type: string;
            schedule_value: string;
            status: string;
            next_run: string;
          }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return {
        content: [
          { type: 'text' as const, text: `Scheduled tasks:\n${formatted}` },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} pause requested.`,
        },
      ],
    };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} resume requested.`,
        },
      ],
    };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} cancellation requested.`,
        },
      ],
    };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .optional()
      .describe('New schedule type'),
    schedule_value: z
      .string()
      .optional()
      .describe('New schedule value (see schedule_task for format)'),
    script: z
      .string()
      .optional()
      .describe(
        'New script for the task. Set to empty string to remove the script.',
      ),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (
      args.schedule_type === 'cron' ||
      (!args.schedule_type && args.schedule_value)
    ) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Invalid cron: "${args.schedule_value}".`,
              },
            ],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}".`,
            },
          ],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.script !== undefined) data.script = args.script;
    if (args.schedule_type !== undefined)
      data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined)
      data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} update requested.`,
        },
      ],
    };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z
      .string()
      .describe(
        'The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")',
      ),
    name: z.string().describe('Display name for the group'),
    folder: z
      .string()
      .describe(
        'Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")',
      ),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
    requiresTrigger: z
      .boolean()
      .optional()
      .describe(
        'Whether messages must start with the trigger word. Default: false (respond to all messages). Set to true for busy groups with many participants where you only want the agent to respond when explicitly mentioned.',
      ),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can register new groups.',
          },
        ],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      requiresTrigger: args.requiresTrigger ?? false,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Group "${args.name}" registered. It will start receiving messages immediately.`,
        },
      ],
    };
  },
);

const HOST_EXEC_DIR = '/workspace/host-exec';
const RESULTS_DIR = path.join(HOST_EXEC_DIR, 'results');
const LOGS_DIR = path.join(HOST_EXEC_DIR, 'logs');

// Container→host path mapping for additional mounts
const extraMounts: Record<string, string> = (() => {
  try {
    return JSON.parse(process.env.NANOCLAW_EXTRA_MOUNTS || '{}');
  } catch {
    return {};
  }
})();

function toHostPath(containerPath: string): string {
  for (const [cPath, hPath] of Object.entries(extraMounts)) {
    if (containerPath.startsWith(cPath)) {
      return containerPath.replace(cPath, hPath);
    }
  }
  return containerPath;
}

function generateRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function pollForResult(requestId: string, timeoutMs: number): Promise<string> {
  const resultPath = path.join(RESULTS_DIR, `${requestId}.json`);
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (fs.existsSync(resultPath)) {
        try {
          const content = fs.readFileSync(resultPath, 'utf-8');
          resolve(content);
        } catch {
          resolve(JSON.stringify({ error: 'Failed to read result file' }));
        }
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timed out waiting for result (${timeoutMs}ms)`));
        return;
      }
      setTimeout(check, 500);
    };
    check();
  });
}

// --- Host Executor MCP Tools (main group only) ---

server.tool(
  'run_command',
  'Run a one-shot command on the host machine and return its output. Use for quick commands like git status, npm install, docker compose up, etc. The command runs in a bash shell.',
  {
    command: z.string().describe('The bash command to run'),
    cwd: z.string().optional().describe('Working directory (container path like /workspace/extra/..., will be translated to host path)'),
    timeout: z.number().optional().describe('Timeout in milliseconds (default: 60000)'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can run host commands.' }], isError: true };
    }
    const requestId = generateRequestId();
    const hostCwd = args.cwd ? toHostPath(args.cwd) : undefined;
    writeIpcFile(TASKS_DIR, {
      type: 'host_exec',
      requestId,
      command: args.command,
      cwd: hostCwd || '/tmp',
      timeout: args.timeout,
      timestamp: new Date().toISOString(),
    });
    try {
      const result = await pollForResult(requestId, (args.timeout || 60000) + 5000);
      return { content: [{ type: 'text' as const, text: result }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'start_process',
  `Start a long-running dev server process on the host inside a tmux session. This is the ONLY correct way to start services.

What it does automatically:
- Creates a named tmux session (visible to human via Terminal.app)
- Loads nvm with system default Node (v18) and adds /opt/homebrew/bin to PATH
- Kills any existing process on the target port
- Pipes output to log files for capture_terminal and read_process_logs
- Tracks the process for list_processes, stop_process, restart_process

NEVER use run_command with manual tmux commands — always use this tool.`,
  {
    name: z.string().describe('Unique name for the process (e.g. "stock-portal")'),
    command: z.string().describe('The bash command to run (e.g. "yarn start", "yarn develop")'),
    cwd: z.string().describe('Working directory (container path like /workspace/extra/pro_coding/stock-portal)'),
    env_json: z.string().optional().describe('Extra environment variables as JSON string (e.g. \'{"PORT": "3000"}\')'),
    port: z.number().optional().describe('Port the process will listen on — used to kill stale processes before start'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can start host processes.' }], isError: true };
    }
    const requestId = generateRequestId();
    const envParsed = args.env_json ? JSON.parse(args.env_json) : undefined;
    writeIpcFile(TASKS_DIR, {
      type: 'host_process_start',
      requestId,
      name: args.name,
      command: args.command,
      cwd: toHostPath(args.cwd),
      env: envParsed,
      port: args.port,
      timestamp: new Date().toISOString(),
    });
    try {
      const result = await pollForResult(requestId, 15000);
      return { content: [{ type: 'text' as const, text: result }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'stop_process',
  'Stop a managed host process by name.',
  {
    name: z.string().describe('Name of the process to stop'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can stop host processes.' }], isError: true };
    }
    const requestId = generateRequestId();
    writeIpcFile(TASKS_DIR, {
      type: 'host_process_stop',
      requestId,
      name: args.name,
      timestamp: new Date().toISOString(),
    });
    try {
      const result = await pollForResult(requestId, 10000);
      return { content: [{ type: 'text' as const, text: result }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'restart_process',
  'Restart a managed host process by name. Stops it first, then starts with the same configuration.',
  {
    name: z.string().describe('Name of the process to restart'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can restart host processes.' }], isError: true };
    }
    const requestId = generateRequestId();
    writeIpcFile(TASKS_DIR, {
      type: 'host_process_restart',
      requestId,
      name: args.name,
      timestamp: new Date().toISOString(),
    });
    try {
      const result = await pollForResult(requestId, 15000);
      return { content: [{ type: 'text' as const, text: result }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'list_processes',
  'List all managed host processes with their status, PID, port, and start time.',
  {},
  async () => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can list host processes.' }], isError: true };
    }
    const requestId = generateRequestId();
    writeIpcFile(TASKS_DIR, {
      type: 'host_process_list',
      requestId,
      timestamp: new Date().toISOString(),
    });
    try {
      const result = await pollForResult(requestId, 5000);
      return { content: [{ type: 'text' as const, text: result }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'read_process_logs',
  'Read recent log output from a managed host process. Reads directly from the log file.',
  {
    name: z.string().describe('Name of the process'),
    lines: z.number().optional().describe('Number of lines to read from the end (default: 100)'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can read process logs.' }], isError: true };
    }
    const logPath = path.join(LOGS_DIR, `${args.name}.log`);
    if (!fs.existsSync(logPath)) {
      return { content: [{ type: 'text' as const, text: `No logs found for "${args.name}". Available logs: ${fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.log')).map(f => f.replace('.log', '')).join(', ') || 'none'}` }] };
    }
    try {
      const content = fs.readFileSync(logPath, 'utf-8');
      const allLines = content.split('\n');
      const n = args.lines || 100;
      const tail = allLines.slice(-n).join('\n');
      return { content: [{ type: 'text' as const, text: `Last ${Math.min(n, allLines.length)} lines of ${args.name}:\n\n${tail}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error reading logs: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'capture_terminal',
  'Capture the current visible terminal output of a managed host process — exactly what a human developer would see in the terminal. Returns the last N lines of the tmux pane. Use this to check process status, see compilation output, error messages, etc.',
  {
    name: z.string().describe('Name of the process (e.g. "stock-engine")'),
    lines: z.number().optional().describe('Number of lines to capture (default: 50)'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can capture terminal output.' }], isError: true };
    }
    const requestId = generateRequestId();
    writeIpcFile(TASKS_DIR, {
      type: 'host_capture_terminal',
      requestId,
      name: args.name,
      lines: args.lines,
      timestamp: new Date().toISOString(),
    });
    try {
      const result = await pollForResult(requestId, 10000);
      return { content: [{ type: 'text' as const, text: result }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'wait_for_output',
  'Wait for a specific string to appear in a process terminal output. Polls the tmux pane every 2 seconds until the pattern is found or timeout. Use this to wait for services to be ready (e.g. "Welcome back" for Strapi, "Compiled successfully" for React).',
  {
    name: z.string().describe('Name of the process (e.g. "stock-engine")'),
    pattern: z.string().describe('String to wait for (e.g. "Welcome back", "Compiled successfully")'),
    timeout: z.number().optional().describe('Timeout in milliseconds (default: 60000)'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can wait for process output.' }], isError: true };
    }
    const requestId = generateRequestId();
    writeIpcFile(TASKS_DIR, {
      type: 'host_wait_for_output',
      requestId,
      name: args.name,
      pattern: args.pattern,
      timeout: args.timeout,
      timestamp: new Date().toISOString(),
    });
    try {
      const result = await pollForResult(requestId, (args.timeout || 60000) + 5000);
      return { content: [{ type: 'text' as const, text: result }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'open_dashboard',
  'Open a Terminal.app window on the host with a tmux dashboard showing all running service outputs in split panes. The human developer can monitor all services in one window. Call this AFTER all services are confirmed ready.',
  {},
  async () => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can open the dashboard.' }], isError: true };
    }
    const requestId = generateRequestId();
    writeIpcFile(TASKS_DIR, {
      type: 'host_open_dashboard',
      requestId,
      timestamp: new Date().toISOString(),
    });
    try {
      const result = await pollForResult(requestId, 10000);
      return { content: [{ type: 'text' as const, text: result }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'start_playwright_browser',
  'Start a headed Playwright browser on the host machine for visual UI testing and inspection. The browser window is visible to the human developer. Once started, use the mcp__playwright__* tools to navigate, click, fill forms, and take screenshots. The browser persists until you stop it.',
  {},
  async () => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can start the Playwright browser.' }], isError: true };
    }
    const requestId = generateRequestId();
    writeIpcFile(TASKS_DIR, {
      type: 'host_process_start',
      requestId,
      name: 'playwright-mcp',
      command: 'npx @playwright/mcp --port 3100 --executable-path "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --viewport-size 1280x720 --ignore-https-errors --proxy-bypass localhost,127.0.0.1',
      cwd: '/tmp',
      port: 3100,
      timestamp: new Date().toISOString(),
    });
    try {
      const result = await pollForResult(requestId, 10000);
      return { content: [{ type: 'text' as const, text: `Playwright browser started (headed, visible to human).\n${result}\nUse mcp__playwright__* tools to interact with it.` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'stop_playwright_browser',
  'Stop the headed Playwright browser on the host.',
  {},
  async () => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can stop the Playwright browser.' }], isError: true };
    }
    const requestId = generateRequestId();
    writeIpcFile(TASKS_DIR, {
      type: 'host_process_stop',
      requestId,
      name: 'playwright-mcp',
      timestamp: new Date().toISOString(),
    });
    try {
      const result = await pollForResult(requestId, 10000);
      return { content: [{ type: 'text' as const, text: `Playwright browser stopped.\n${result}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
