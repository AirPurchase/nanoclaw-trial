---
name: telegram-add-bot
description: Add an additional Telegram bot agent to NanoClaw. Creates a new bot identity with its own personality, memory, and isolated container. Requires the base Telegram channel to already be installed.
---

# Add Telegram Bot Agent

This skill adds a new Telegram bot agent to an existing NanoClaw installation that already has Telegram configured. Each bot is a separate agent with its own personality, memory, and container.

## Prerequisites

- Telegram channel already installed (`src/channels/telegram.ts` exists)
- Multi-bot support code applied (the `TELEGRAM_BOT_TOKEN_<NAME>` pattern in telegram.ts)
- NanoClaw running on `ap-custom-v1` branch or later with multi-bot patch

## Phase 1: Collect Information

### Step-by-step prompts

Ask the user ONE question at a time using `AskUserQuestion`. Wait for each answer before asking the next. This ensures a guided, interactive experience.

**Step 1 — Agent name:**

Ask: "What's the agent's name? This is the persona name (e.g., Tom, Emma, Max). It will be used for the trigger pattern and folder name."

**Step 2 — Agent role:**

Ask: "What role does [name] play? Describe briefly what this agent does (e.g., 'code reviewer', 'development team lead', 'E2E tester'). This will be used to generate the personality."

**Step 3 — Bot token:**

Ask: "What's the bot token for [name]? Paste the token from @BotFather (looks like `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`). If you don't have one yet, create it first: Telegram → @BotFather → /newbot → copy the token."

### Chat ID is NOT needed

For DM bots, the Telegram chat ID is the user's Telegram ID — it's the same for ALL bots talking to the same user. The `telegram-add-bot.mjs` script constructs the unique JID automatically: `tg:<botname>:<user_chat_id>`.

The user's chat ID is already known from the existing main bot registration. Look it up:

```bash
sqlite3 store/messages.db "SELECT jid FROM registered_groups WHERE is_main = 1 AND jid LIKE 'tg:%'"
```

Extract the numeric portion (last segment after `:`). For example, if the main bot's JID is `tg:670226680`, the chat ID is `670226680`.

### Fallback: if no existing registration exists

If this is the very first bot (no main registration to look up), add a 4th step:

**Step 4 (only if needed) — Chat ID:**

Configure the token, build & restart so the bot connects, then ask: "Send `/chatid` to your new bot in Telegram. What numeric chat ID did it reply with?"

IMPORTANT: Never stop silently waiting for input. Always explicitly ask the user what you need with `AskUserQuestion`.

## Phase 2: Configure Environment

Add the bot token to `.env` using the naming convention:

```bash
# The suffix after TELEGRAM_BOT_TOKEN_ becomes the channel name (lowercased)
# e.g., TELEGRAM_BOT_TOKEN_TOM → channel "telegram:tom"
# IMPORTANT: ensure trailing newline before appending to avoid corrupting the last line
sed -i '' -e '$a\' .env 2>/dev/null; echo 'TELEGRAM_BOT_TOKEN_<NAME>=<token>' >> .env
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

## Phase 3: Look Up Chat ID

The chat ID is the same for all DM bots (it's the user's Telegram ID). Look it up from the existing registration:

```bash
sqlite3 store/messages.db "SELECT jid FROM registered_groups WHERE jid LIKE 'tg:%' LIMIT 1"
```

Extract the numeric portion (last segment after the final `:`). For example:
- `tg:670226680` → chat ID is `670226680`
- `tg:tom:670226680` → chat ID is `670226680`

If no existing registration exists (first bot ever), build & restart first, then ask the user to send `/chatid` to the bot and provide the numeric ID.

## Phase 4: Register the Group

Register the new bot's chat in the SQLite database:

```bash
sqlite3 store/messages.db "INSERT OR REPLACE INTO registered_groups 
  (jid, name, folder, trigger_pattern, added_at, requires_trigger, is_main, channel)
  VALUES (
    '<jid>',
    '<Agent Name>',
    'telegram_<name>',
    '@<AgentName>',
    '$(date -u +%Y-%m-%dT%H:%M:%SZ)',
    0,
    0,
    'telegram:<name>'
  );"
```

Field mapping:
- `jid` — The chat ID from step 4 (e.g., `tg:123456789`)
- `name` — Display name (e.g., "Tom Review")
- `folder` — Group folder name, convention: `telegram_<name>` (e.g., `telegram_tom`)
- `trigger_pattern` — Trigger word (e.g., `@Tom`). Set `requires_trigger=0` for DM bots (responds to all messages)
- `channel` — Must match the env var suffix: `telegram:<name>` (e.g., `telegram:tom`)

## Phase 5: Create Agent Folder & Personality

Create the group folder with a CLAUDE.md:

```bash
mkdir -p groups/telegram_<name>
```

Write `groups/telegram_<name>/CLAUDE.md` with the agent's personality. Use the role description from Phase 1 to craft appropriate instructions. Example structure:

```markdown
# <Agent Name>

You are <Name>, a <role description>. <Brief personality/approach summary>.

## What You Can Do

- <capability 1>
- <capability 2>
- ...

## Communication

Your output is sent to the user via Telegram.
Use `mcp__nanoclaw__send_message` for immediate acknowledgments during long tasks.

### Formatting (Telegram)

- `*bold*` (single asterisks, NEVER **double**)
- `_italic_` (underscores)
- `•` bullet points
- ` ``` ` code blocks

No `##` headings. No `[links](url)`. No `**double stars**`.

## Your Role

<Detailed instructions about what this agent should do, how it should behave,
what standards it should apply, etc.>
```

## Phase 6: Build & Restart

```bash
pnpm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 7: Verify

Tell the user:

> Send a message to your new bot in Telegram. Since it's a DM bot with `requires_trigger=0`, any message should get a response.
>
> Try: "Hello, who are you?"
>
> The bot should respond with its persona within a few seconds.

### Check logs if needed

```bash
tail -20 logs/nanoclaw.log | grep -i "<name>"
```

## Troubleshooting

### Bot not responding

1. Check token is in `.env` AND `data/env/env`: `grep TELEGRAM_BOT_TOKEN_ .env`
2. Check registration: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE channel LIKE 'telegram:%'"`
3. Check the channel field matches: the `channel` column must equal `telegram:<name>` (lowercase)
4. Check logs: `tail -50 logs/nanoclaw.log | grep -i telegram`
5. Verify bot connected: look for `Telegram bot connected` with the bot's username in logs

### Bot responds but with wrong personality

Check that `groups/telegram_<name>/CLAUDE.md` exists and has the correct content. The folder name must match the `folder` column in the DB exactly.

### Multiple bots claiming same chat

The `channel` field in `registered_groups` determines which bot instance handles a JID. Ensure each registered group has the correct `channel` value. The default `telegram` channel only handles JIDs without an explicit `channel` override.

## Example: Adding "Tom" as a Code Reviewer

```bash
# 1. Add token to .env (ensure trailing newline first)
sed -i '' -e '$a\' .env 2>/dev/null; echo 'TELEGRAM_BOT_TOKEN_TOM=123456:ABC-token-here' >> .env
mkdir -p data/env && cp .env data/env/env

# 2. Build & restart so the bot connects and /chatid works
pnpm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# 3. Send /chatid to the new bot in Telegram — it replies with "tg:tom:987654321"

# 4. Register using the script (accepts raw numeric ID or full JID)
node scripts/telegram-add-bot.mjs --jid "987654321" --name "Tom Review" --agent-name tom

# 5. Edit the generated CLAUDE.md personality
#    groups/telegram_tom/CLAUDE.md

# 6. Restart to pick up the registration
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Or register manually with sqlite3:

```bash
sqlite3 store/messages.db "INSERT OR REPLACE INTO registered_groups 
  (jid, name, folder, trigger_pattern, added_at, requires_trigger, is_main, channel)
  VALUES ('tg:tom:987654321', 'Tom Review', 'telegram_tom', '@Tom', '2026-05-19T00:00:00Z', 0, 0, 'telegram:tom');"

# 3. Create personality
mkdir -p groups/telegram_tom
cat > groups/telegram_tom/CLAUDE.md << 'EOF'
# Tom

You are Tom, a senior code reviewer. You review code changes with a focus on correctness, maintainability, and security.

## Communication

Your output is sent to the user via Telegram.

### Formatting (Telegram)
- `*bold*` (single asterisks)
- `_italic_` (underscores)  
- `•` bullet points

## Your Role

When the user shares code or asks for a review:
1. Read the code carefully
2. Check for bugs, security issues, and maintainability concerns
3. Suggest improvements with clear explanations
4. Be constructive — explain the "why" behind each suggestion
EOF

# 4. Build & restart
pnpm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```
