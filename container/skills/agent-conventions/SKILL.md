---
name: agent-conventions
description: Shared behavioral conventions for all agents — internal thoughts, memory usage, sub-agent etiquette, and task tracking. Always active.
---

# Agent Conventions (Always Active)

Standing behavioral rules for all NanoClaw agents. Not a slash command.

## Internal Thoughts

If part of your output is internal reasoning rather than something for the user, wrap it in `<internal>` tags:

```
<internal>Compiled all three reports, ready to summarize.</internal>

Here are the key findings from the research...
```

Text inside `<internal>` tags is logged but not sent to the user. Use this to:
- Keep verbose reasoning out of Telegram messages
- Avoid re-sending information you already delivered via `send_message`
- Separate planning from user-facing output

## Memory

The `conversations/` folder in your workspace contains searchable history of past conversations. Use this to recall context from previous sessions.

When you learn something important:
- Create files for structured data (e.g., `customers.md`, `preferences.md`)
- Split files larger than 500 lines into folders
- Keep an index in your memory for the files you create

## Sub-agents and Teammates

When working as a sub-agent or teammate, only use `send_message` if instructed to by the main agent.

## Development Task Tracking

All non-trivial development work MUST be tracked in `/workspace/extra/pro_coding/tasks/`. This is not optional.

### Folder naming format

`YYYYMM-NN-task_summary` — e.g., `tasks/202605-07-dashboard-price-qty-diff`

- `YYYYMM` — year and month
- `NN` — sequence number for that month (01, 02, 03...)
- `task_summary` — short kebab-case description

### Required files per task

Each task folder contains 5 files. Different agents read and write different ones:

| File | Purpose | Who writes | Who reads |
|------|---------|------------|-----------|
| `README.md` | Status, branch, commits, summary | Lead/dev | Everyone |
| `REQUIREMENT.md` | Problem statement & acceptance criteria | Lead/user | Everyone |
| `PLAN.md` | Root cause analysis & implementation approach | Dev/lead | Everyone |
| `CHANGES.md` | Files modified, logic added, commit refs | Dev | Reviewer, QA |
| `TESTING.md` | Verification steps, edge cases, test results | QA | Lead, dev |

### README.md status values

`proposed` | `in-progress` | `review` | `complete` | `blocked`

### Workflow

1. **Before starting**: Check `tasks/` for existing folder. Read it for context.
2. **If new task**: Create folder `YYYYMM-NN-summary`, fill `REQUIREMENT.md` and `PLAN.md` first
3. **During implementation**: Keep `CHANGES.md` updated as you work — files modified, decisions made
4. **After implementation**: Update `README.md` with branch, commits, status. QA records results in `TESTING.md`.
5. **Resuming a session**: Read the task folder first for context recovery
6. **Multi-phase work**: Update the existing task folder, don't create a new one
