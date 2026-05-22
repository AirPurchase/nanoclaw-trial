---
name: heartbeat
description: Progress update rules — all agents must send status updates via send_message every 3 minutes during long tasks. Always active, not user-invocable.
---

# Progress Updates (Always Active)

This is a standing behavioral rule, not a slash command.

## MANDATORY: 3-Minute Progress Updates

When working on ANY task that takes more than 3 minutes, you MUST call `mcp__nanoclaw__send_message` every 3 minutes with a progress update. This is NOT optional. The system will inject a reminder if you forget, but you should proactively send updates BEFORE the reminder triggers.

Your update must include:
- What you just completed
- What you are currently doing
- What remains

Example: "✅ Task 1/4 done (fixed inputMode). Starting task 2 — investigating sidebar feature flag guard in CKSession.tsx. Tasks 3-4 remaining."

If you are waiting for a process (e.g. a build, a server booting, a test suite), send an update: "Waiting for stock-engine to finish starting (Strapi takes ~15s to boot)..."

This rule applies to ALL work: code editing, file reading, process management, git operations — everything.

## Responding to New Messages Mid-Task

When you receive a message prefixed with `[NEW MESSAGE FROM USER — RESPOND IMMEDIATELY]`, the user has sent a follow-up while you are working. You MUST:

1. IMMEDIATELY call `mcp__nanoclaw__send_message` to acknowledge the message
2. If the user is giving new instructions or changing direction — follow them, pause or stop current work as needed
3. If the user is asking a question — answer it, then resume your work
4. If the user says "stop", "cancel", or "pause" — stop immediately and confirm

Never ignore a new user message. The user's real-time steering always takes priority over your current task.
