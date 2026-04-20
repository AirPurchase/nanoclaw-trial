/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import {
  query,
  HookCallback,
  PreCompactHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_MESSAGES_DIR = '/workspace/ipc/messages';
const IPC_POLL_MS = 500;

function sendIpcMessage(containerInput: ContainerInput, text: string): void {
  try {
    fs.mkdirSync(IPC_MESSAGES_DIR, { recursive: true });
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
    const filepath = path.join(IPC_MESSAGES_DIR, filename);
    const tmpPath = filepath + '.tmp';
    fs.writeFileSync(
      tmpPath,
      JSON.stringify(
        {
          type: 'message',
          chatJid: containerInput.chatJid,
          text,
          groupFolder: containerInput.groupFolder,
          timestamp: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    fs.renameSync(tmpPath, filepath);
  } catch (err) {
    log(
      `Failed to send IPC message: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(
  sessionId: string,
  transcriptPath: string,
): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(
      fs.readFileSync(indexPath, 'utf-8'),
    );
    const entry = index.entries.find((e) => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(
      `Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(
        messages,
        summary,
        assistantName,
      );
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(
        `Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {};
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content
                .map((c: { text?: string }) => c.text || '')
                .join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {}
  }

  return messages;
}

function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title?: string | null,
  assistantName?: string,
): string {
  const now = new Date();
  const formatDateTime = (d: Date) =>
    d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content =
      msg.content.length > 2000
        ? msg.content.slice(0, 2000) + '...'
        : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
  skipPlaywrightSSE = false,
): Promise<{
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
}> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;

  // Heartbeat: track last output time and nudge agent if silent for 3 minutes
  const HEARTBEAT_INTERVAL_MS = 180_000; // 3 minutes
  let lastOutputTime = Date.now();
  let heartbeatCount = 0;
  let heartbeatActive = true;

  const resetHeartbeat = () => {
    lastOutputTime = Date.now();
  };
  const stopHeartbeat = () => {
    heartbeatActive = false;
  };

  const heartbeatCheck = () => {
    if (!ipcPolling || !heartbeatActive) return;
    const silentMs = Date.now() - lastOutputTime;
    if (silentMs >= HEARTBEAT_INTERVAL_MS) {
      heartbeatCount++;
      log(
        `Heartbeat #${heartbeatCount}: no output for ${Math.round(silentMs / 1000)}s, nudging agent`,
      );
      // Inject a user-level nudge into the agent's stream
      stream.push(
        '[SYSTEM REMINDER] You have not sent a progress update to the user for over 3 minutes. Use mcp__nanoclaw__send_message NOW to update the user on what you are currently doing, what progress has been made, and what remains. This is mandatory — do not skip it.',
      );
      // Also send a heartbeat to the user so they know the agent is alive
      sendIpcMessage(
        containerInput,
        `⏳ _Agent is still working (${Math.round(silentMs / 60000)} min since last update)..._`,
      );
      resetHeartbeat();
    }
    setTimeout(heartbeatCheck, 30_000); // check every 30s
  };
  setTimeout(heartbeatCheck, HEARTBEAT_INTERVAL_MS);

  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      stream.push(
        `[NEW MESSAGE FROM USER — RESPOND IMMEDIATELY]\nThe user just sent a new message while you are working. You MUST acknowledge this message RIGHT NOW using mcp__nanoclaw__send_message before continuing your current work. If the user is giving new instructions, steering, or asking you to stop/change direction, follow their instructions immediately.\n\n${text}`,
      );
      // Restart heartbeat — agent has new work
      heartbeatActive = true;
      resetHeartbeat();
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: '/workspace/group',
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: globalClaudeMd
        ? {
            type: 'preset' as const,
            preset: 'claude_code' as const,
            append: globalClaudeMd,
          }
        : undefined,
      allowedTools: [
        'Bash',
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
        'WebSearch',
        'WebFetch',
        'Task',
        'TaskOutput',
        'TaskStop',
        'TeamCreate',
        'TeamDelete',
        'SendMessage',
        'TodoWrite',
        'ToolSearch',
        'Skill',
        'NotebookEdit',
        'mcp__nanoclaw__*',
        'mcp__playwright__*',
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: await (async () => {
        const servers: Record<string, any> = {
          nanoclaw: {
            command: 'node',
            args: [mcpServerPath],
            env: {
              NANOCLAW_CHAT_JID: containerInput.chatJid,
              NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
              NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
              ...(process.env.NANOCLAW_EXTRA_MOUNTS
                ? { NANOCLAW_EXTRA_MOUNTS: process.env.NANOCLAW_EXTRA_MOUNTS }
                : {}),
            },
          },
        };
        const playwrightUrl = process.env.NANOCLAW_PLAYWRIGHT_URL;
        if (playwrightUrl && !skipPlaywrightSSE) {
          // Only connect if the host-headed server is already running — don't auto-start it.
          // The agent calls start_playwright_browser explicitly when it needs a headed browser.
          try {
            const probe = await fetch(playwrightUrl.replace('/mcp', '/'), {
              signal: AbortSignal.timeout(2000),
            });
            if (probe.ok || probe.status === 405) {
              servers.playwright = { url: playwrightUrl };
              process.stderr.write(
                `[agent-runner] Playwright MCP: connected to host-headed browser at ${playwrightUrl}\n`,
              );
            }
          } catch {
            /* not running — will use in-container headless */
          }
        }
        if (!servers.playwright) {
          process.stderr.write(
            `[agent-runner] Playwright MCP: using in-container headless (call start_playwright_browser for headed mode)\n`,
          );
        }
        if (!servers.playwright) {
          servers.playwright = {
            command: 'npx',
            args: [
              '@playwright/mcp',
              '--headless',
              '--no-sandbox',
              '--executable-path',
              '/usr/bin/chromium',
              '--viewport-size',
              '1280x720',
              '--ignore-https-errors',
              '--proxy-bypass',
              'localhost,127.0.0.1',
            ],
          };
        }
        return servers;
      })(),
      hooks: {
        PreCompact: [
          { hooks: [createPreCompactHook(containerInput.assistantName)] },
        ],
      },
    },
  })) {
    messageCount++;
    const msgType =
      message.type === 'system'
        ? `system/${(message as { subtype?: string }).subtype}`
        : message.type;

    // Log assistant messages with content summary for observability
    if (message.type === 'assistant' && 'message' in message) {
      const msg = (message as { message: { content: any[] } }).message;
      const parts: string[] = [];
      for (const block of msg.content || []) {
        if (block.type === 'text' && block.text) {
          parts.push(
            `text(${block.text.length}): ${block.text.slice(0, 120).replace(/\n/g, ' ')}`,
          );
        } else if (block.type === 'tool_use') {
          parts.push(
            `tool: ${block.name}(${JSON.stringify(block.input || {}).slice(0, 100)})`,
          );
        } else if (block.type === 'tool_result') {
          parts.push(`tool_result(${JSON.stringify(block).slice(0, 80)})`);
        }
      }
      log(`[msg #${messageCount}] type=${msgType} ${parts.join(' | ')}`);
    } else {
      log(`[msg #${messageCount}] type=${msgType}`);
    }

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (
      message.type === 'system' &&
      (message as { subtype?: string }).subtype === 'task_notification'
    ) {
      const tn = message as {
        task_id: string;
        status: string;
        summary: string;
      };
      log(
        `Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`,
      );
    }

    if (message.type === 'result') {
      resultCount++;
      // Task completed — stop heartbeat so the agent can rest without
      // sending unnecessary 3-min progress messages to the user.
      // Heartbeat restarts when a new user message arrives (see pollIpcDuringQuery).
      stopHeartbeat();
      const textResult =
        'result' in message ? (message as { result?: string }).result : null;
      log(
        `Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`,
      );
      writeOutput({
        status: 'success',
        result: textResult || null,
        newSessionId,
      });
    }
  }

  ipcPolling = false;
  log(
    `Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`,
  );
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
}

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

const SCRIPT_TIMEOUT_MS = 30_000;

async function runScript(script: string): Promise<ScriptResult | null> {
  const scriptPath = '/tmp/task-script.sh';
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile(
      'bash',
      [scriptPath],
      {
        timeout: SCRIPT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (stderr) {
          log(`Script stderr: ${stderr.slice(0, 500)}`);
        }

        if (error) {
          log(`Script error: ${error.message}`);
          return resolve(null);
        }

        // Parse last non-empty line of stdout as JSON
        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        if (!lastLine) {
          log('Script produced no output');
          return resolve(null);
        }

        try {
          const result = JSON.parse(lastLine);
          if (typeof result.wakeAgent !== 'boolean') {
            log(
              `Script output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`,
            );
            return resolve(null);
          }
          resolve(result as ScriptResult);
        } catch {
          log(`Script output is not valid JSON: ${lastLine.slice(0, 200)}`);
          resolve(null);
        }
      },
    );
  });
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      /* may not exist */
    }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // Credentials are injected by the host's credential proxy via ANTHROPIC_BASE_URL.
  // No real secrets exist in the container environment.
  const sdkEnv: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '165000',
  };

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Script phase: run script before waking agent
  if (containerInput.script && containerInput.isScheduledTask) {
    log('Running task script...');
    const scriptResult = await runScript(containerInput.script);

    if (!scriptResult || !scriptResult.wakeAgent) {
      const reason = scriptResult
        ? 'wakeAgent=false'
        : 'script error/no output';
      log(`Script decided not to wake agent: ${reason}`);
      writeOutput({
        status: 'success',
        result: null,
      });
      return;
    }

    // Script says wake agent — enrich prompt with script data
    log(`Script wakeAgent=true, enriching prompt with data`);
    prompt = `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}\n\nInstructions:\n${containerInput.prompt}`;
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  let skipPlaywrightSSE = false;
  try {
    while (true) {
      log(
        `Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`,
      );

      const queryResult = await runQuery(
        prompt,
        sessionId,
        mcpServerPath,
        containerInput,
        sdkEnv,
        resumeAt,
      );
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const playwrightUrl = process.env.NANOCLAW_PLAYWRIGHT_URL;

    // If Playwright SSE was active and the SDK crashed, attempt self-recovery
    if (!skipPlaywrightSSE && playwrightUrl) {
      log(`Agent error with Playwright SSE active: ${errorMessage}`);
      log('Attempting Playwright recovery...');

      // Notify user about the crash
      sendIpcMessage(
        containerInput,
        `⚠️ *Playwright browser crashed*\nError: ${errorMessage.slice(0, 200)}\n\nAttempting recovery — restarting the headed browser on the host...`,
      );

      // Try to restart the host-headed Playwright server via IPC
      const recoveryRequestId = `recovery-${Date.now()}`;
      const taskFile = path.join(
        '/workspace/ipc/tasks',
        `${Date.now()}-recovery.json`,
      );
      const tmpFile = taskFile + '.tmp';
      fs.writeFileSync(
        tmpFile,
        JSON.stringify(
          {
            type: 'host_process_start',
            requestId: recoveryRequestId,
            name: 'playwright-mcp',
            command:
              'npx @playwright/mcp --port 3100 --executable-path "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --viewport-size 1280x720 --ignore-https-errors --proxy-bypass localhost,127.0.0.1',
            cwd: process.env.HOME || '/tmp',
            port: 3100,
            timestamp: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      fs.renameSync(tmpFile, taskFile);
      log('Sent IPC request to restart Playwright MCP server on host');

      // Wait for the server to come up (poll for up to 15 seconds)
      let serverReady = false;
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        try {
          const probe = await fetch(playwrightUrl.replace('/mcp', '/'), {
            signal: AbortSignal.timeout(1500),
          });
          if (probe.ok || probe.status === 405) {
            serverReady = true;
            break;
          }
        } catch {
          /* not ready yet */
        }
      }

      if (serverReady) {
        log('Playwright MCP server recovered — retrying with headed browser');
        sendIpcMessage(
          containerInput,
          '✅ *Playwright browser recovered* — headed browser restarted successfully. Resuming work...',
        );

        // Retry with headed Playwright (skipPlaywrightSSE = false)
        try {
          while (true) {
            log(
              `Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'}, playwright=recovered-headed)...`,
            );
            const queryResult = await runQuery(
              prompt,
              sessionId,
              mcpServerPath,
              containerInput,
              sdkEnv,
              resumeAt,
              false,
            );
            if (queryResult.newSessionId) sessionId = queryResult.newSessionId;
            if (queryResult.lastAssistantUuid)
              resumeAt = queryResult.lastAssistantUuid;
            if (queryResult.closedDuringQuery) {
              log('Close sentinel consumed during recovery query, exiting');
              break;
            }
            writeOutput({
              status: 'success',
              result: null,
              newSessionId: sessionId,
            });
            log('Query ended, waiting for next IPC message...');
            const nextMessage = await waitForIpcMessage();
            if (nextMessage === null) {
              log('Close sentinel received, exiting');
              break;
            }
            log(
              `Got new message (${nextMessage.length} chars), starting new query`,
            );
            prompt = nextMessage;
          }
          return;
        } catch (retryErr) {
          const retryMsg =
            retryErr instanceof Error ? retryErr.message : String(retryErr);
          log(`Agent error after Playwright recovery: ${retryMsg}`);
          sendIpcMessage(
            containerInput,
            `❌ *Recovery failed* — headed browser crashed again: ${retryMsg.slice(0, 200)}\n\nPlease check the Playwright MCP server on the host.`,
          );
          writeOutput({
            status: 'error',
            result: null,
            newSessionId: sessionId,
            error: retryMsg,
          });
          process.exit(1);
        }
      } else {
        log(
          'Playwright MCP server did not recover — cannot restart headed browser',
        );
        sendIpcMessage(
          containerInput,
          '❌ *Playwright recovery failed* — could not restart the headed browser on the host.\n\nPlease check if Chrome is available and port 3100 is free. You can manually run:\n`npx @playwright/mcp --port 3100`',
        );
        writeOutput({
          status: 'error',
          result: null,
          newSessionId: sessionId,
          error: 'Playwright recovery failed: host server did not start',
        });
        process.exit(1);
      }
    }

    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
