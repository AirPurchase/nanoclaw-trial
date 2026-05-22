#!/usr/bin/env node
/**
 * Register a new Telegram bot agent in the NanoClaw database.
 *
 * Usage:
 *   node scripts/telegram-add-bot.mjs --jid "tg:123456" --name "Tom Review" --agent-name tom --trigger "@Tom"
 *
 * Options:
 *   --jid           Chat JID from /chatid command (required)
 *   --name          Display name for the group (required)
 *   --agent-name    Lowercase agent identifier, used for folder and channel (required)
 *   --trigger       Trigger pattern (default: @<AgentName>)
 *   --require-trigger  Require trigger word (default: false for DM bots)
 *   --dry-run       Show what would be done without writing to DB
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return args[idx + 1];
}
function hasFlag(name) {
  return args.includes(`--${name}`);
}

const rawJid = getArg('jid');
const displayName = getArg('name');
const agentName = getArg('agent-name')?.toLowerCase();
const trigger = getArg('trigger') || (agentName ? `@${agentName.charAt(0).toUpperCase() + agentName.slice(1)}` : undefined);
const requireTrigger = hasFlag('require-trigger') ? 1 : 0;
const dryRun = hasFlag('dry-run');

if (!rawJid || !displayName || !agentName) {
  console.error('Usage: node scripts/telegram-add-bot.mjs --jid "tg:tom:123" --name "Tom Review" --agent-name tom');
  console.error('       node scripts/telegram-add-bot.mjs --jid "670226680" --name "Tom Review" --agent-name tom');
  console.error('');
  console.error('The --jid accepts either the full JID from /chatid (e.g., "tg:tom:123")');
  console.error('or a raw numeric Telegram chat ID (e.g., "670226680").');
  console.error('');
  console.error('Required: --jid, --name, --agent-name');
  console.error('Optional: --trigger "@Tom", --require-trigger, --dry-run');
  process.exit(1);
}

// Normalize JID: accept raw numeric ID, tg:ID, or tg:name:ID
let jid;
if (rawJid.startsWith('tg:')) {
  jid = rawJid;
} else {
  // Raw numeric — construct the proper JID with bot name embedded
  jid = `tg:${agentName}:${rawJid}`;
}

const folder = `telegram_${agentName}`;
const channel = `telegram:${agentName}`;
const addedAt = new Date().toISOString();

console.log('');
console.log('Telegram Bot Agent Registration');
console.log('================================');
console.log(`  JID:             ${jid}`);
console.log(`  Display Name:    ${displayName}`);
console.log(`  Agent Name:      ${agentName}`);
console.log(`  Folder:          groups/${folder}/`);
console.log(`  Channel:         ${channel}`);
console.log(`  Trigger:         ${trigger}`);
console.log(`  Require Trigger: ${requireTrigger ? 'yes' : 'no (responds to all messages)'}`);
console.log('');

if (dryRun) {
  console.log('[DRY RUN] No changes made.');
  process.exit(0);
}

// Write to database
const dbPath = path.join(process.cwd(), 'store', 'messages.db');
if (!fs.existsSync(dbPath)) {
  console.error(`Database not found at ${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath);

db.prepare(`INSERT OR REPLACE INTO registered_groups
  (jid, name, folder, trigger_pattern, added_at, requires_trigger, is_main, channel)
  VALUES (?, ?, ?, ?, ?, ?, 0, ?)`).run(
  jid, displayName, folder, trigger, addedAt, requireTrigger, channel
);

console.log(`Registered in database.`);

// Create group folder
const groupDir = path.join(process.cwd(), 'groups', folder);
if (!fs.existsSync(groupDir)) {
  fs.mkdirSync(groupDir, { recursive: true });
  console.log(`Created folder: groups/${folder}/`);
} else {
  console.log(`Folder already exists: groups/${folder}/`);
}

// Create stub CLAUDE.md if not present
const claudeMd = path.join(groupDir, 'CLAUDE.md');
if (!fs.existsSync(claudeMd)) {
  const capitalized = agentName.charAt(0).toUpperCase() + agentName.slice(1);
  fs.writeFileSync(claudeMd, `# ${capitalized}

You are ${capitalized}, a personal assistant.

## Communication

Your output is sent to the user via Telegram.

### Formatting (Telegram)

- \`*bold*\` (single asterisks, NEVER **double**)
- \`_italic_\` (underscores)
- \`•\` bullet points
- \` \`\`\` \` code blocks

No \`##\` headings. No \`[links](url)\`. No \`**double stars**\`.
`);
  console.log(`Created stub: groups/${folder}/CLAUDE.md (edit this to set the agent's personality)`);
} else {
  console.log(`CLAUDE.md already exists — not overwriting.`);
}

db.close();
console.log('');
console.log('Next steps:');
console.log(`  1. Edit groups/${folder}/CLAUDE.md to define the agent's personality`);
console.log(`  2. Add TELEGRAM_BOT_TOKEN_${agentName.toUpperCase()}=<token> to .env`);
console.log(`  3. Run: mkdir -p data/env && cp .env data/env/env`);
console.log(`  4. Run: pnpm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw`);
console.log('');
