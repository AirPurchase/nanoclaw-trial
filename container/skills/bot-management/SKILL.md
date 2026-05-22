---
name: bot-management
description: Manage bot agents — list bots, reset sessions, view/edit personas, restart service. Commands: /bots, /reset, /persona, /restart.
---

# Bot Management

Slash commands for managing NanoClaw bot agents. Any bot can use these.

## /bots — List all bot agents

Call `mcp__nanoclaw__bot_list` and format the result as a readable list.

Display for each bot:
- Name
- Channel (e.g., `telegram:tom`)
- Session status: active or none
- Trigger pattern

Example output:

```
*Registered Bots*

• *Andy* — telegram (main)
  Session: active | Trigger: @Andy

• *Tom* — telegram:tom
  Session: active | Trigger: @Tom
```

## /reset [name] — Reset a bot's session

Clears a bot's conversation history so the next message starts fresh. Useful when a bot is behaving strangely or you want it to reload its instructions cleanly.

**Usage:**
- `/reset` — reset your own session
- `/reset tom` — reset Tom's session

**Steps:**
1. If no name given, use your own group folder
2. If a name is given, call `mcp__nanoclaw__bot_list` to find the matching bot's `folder` field
3. Call `mcp__nanoclaw__bot_reset_session` with the `group_folder`
4. Confirm to the user: "Session reset for [name]. Next message will start a fresh conversation."

**Finding your own group folder:** Your group folder is in the path `/workspace/group` — run `basename $(readlink -f /workspace/group)` or check the environment.

## /persona [name] [new content] — View or edit bot personality

View or update a bot's CLAUDE.md personality file.

**Usage:**
- `/persona` — show your own persona
- `/persona tom` — show Tom's persona
- `/persona tom You are Tom, a friendly helper.` — update Tom's persona

**Steps for viewing:**
1. Determine the group folder (same lookup as /reset)
2. Call `mcp__nanoclaw__bot_read_persona` with the `group_folder`
3. Display the content to the user

**Steps for updating:**
1. Determine the group folder
2. Call `mcp__nanoclaw__bot_update_persona` with `group_folder` and `content`
3. Confirm: "Persona updated for [name]. Changes take effect on next session (use /reset to apply immediately)."

**Important:** When updating, the `content` parameter replaces the entire CLAUDE.md file. If the user only wants to change part of it, read the current content first, modify it, then write the full updated version.

## /restart — Restart NanoClaw service

Restarts the entire NanoClaw process. All bots disconnect and reconnect.

**Usage:**
- `/restart`

**Steps:**
1. Warn the user: "Restarting NanoClaw — all bots will disconnect briefly and reconnect within a few seconds."
2. Call `mcp__nanoclaw__send_message` with the warning first
3. Call `mcp__nanoclaw__nanoclaw_restart`

**Note:** After calling restart, your own session will be interrupted. The user will see bots reconnect automatically.
