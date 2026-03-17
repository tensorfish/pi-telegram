# pi-telegram

A TypeScript pi extension that relays all pi runs to Telegram and lets approved Telegram users reply back into pi.

## What it does

- relays **all pi runs** to one Telegram chat while connected
- edits one Telegram progress message in place during a run
- lets approved Telegram users send normal text replies back into pi
- keeps the local UI simple: `Telegram Connected` or `Telegram Disconnected`
- shows a small loader animation as `⠋ Telegram Connecting` only while the relay is still connecting
- on startup with an already validated enabled config, sends a short Telegram connection message to confirm the relay is up

## Requirements

Before you start, you need:

- `pi` installed and working
- a Telegram bot token from `@BotFather`
- either:
  - a Telegram chat where you can message the bot, or
  - a numeric Telegram chat id you want to enter manually
- for group chats, one or more allowed Telegram user ids

## Quickstart

### 1. Install the extension

```
pi install git:https://github.com/tensorfish/pi-telegram
```

Or from this repository root:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$(pwd)" ~/.pi/agent/extensions/pi-telegram
```

If you prefer project-local install instead of global install, place this repo at:

```text
.pi/extensions/pi-telegram
```

### 2. Start pi

```bash
pi
```

If pi was already running, use:

```text
/reload
```

### 3. Connect Telegram

Inside pi, run:

```text
/telegram connect
```

You will be prompted for:

- bot token from `@BotFather`
- whether to auto-detect the chat by messaging the bot or enter the chat id manually
- allowed user ids when needed

If you message the bot in a private chat, pi auto-fills both the chat id and allowed user id.
If you use a group chat, pi still asks for the whitelist of allowed user ids.
For manual chat id or user id entry, message `@userinfobot` on Telegram to find the numeric ids.

### 4. Verify the relay

Run:

```text
/telegram test
```

Reply in Telegram with the code from the test message.

## Daily use

Once connected:

- local prompts started in pi are relayed to Telegram
- Telegram replies are accepted only from the configured chat and allowed user ids
- if pi is idle, a Telegram message starts the next prompt
- if pi is busy, a Telegram message is queued for the same run through the follow-up path
- edits to queued Telegram text messages update the queued item before dispatch

## Commands

- `/telegram` — human-friendly overview and subcommand list
- `/telegram status` — raw deterministic relay state
- `/telegram test` — verify outbound and inbound relay
- `/telegram toggle` — enable or disable relay without deleting credentials
- `/telegram logout` — remove saved credentials and disconnect relay
- `/telegram connect` — run the setup flow again
- `/telegram clear` — clear Telegram footer and working messages from the TUI

## Files on disk

- relay config: `~/.pi/agent/pi-telegram.json`
- failure logs: `~/.pi/pi-telegram/YYYYMMDD-HHmmss.log`

## Architecture

The extension source is split into focused modules:

- `src/relay.ts` — polling lifecycle, footer, connection state, Telegram send/edit
- `src/commands.ts` — local and remote command handlers, connect flow
- `src/queue.ts` — prompt queue and dispatch logic
- `src/render.ts` — progress and final message rendering
- `src/telegram-api.ts` — raw Telegram Bot API client
- `src/types.ts` — shared type definitions
- `src/config.ts` — config file read/write/delete
- `src/index.ts` — extension entrypoint wiring events to the modules above

## More documentation

- `SETUP.md` — installation guide for AI agents and automated helpers
- `.memory/overview.md` — plain-language project summary
- `.memory/specifications.md` — behavior and UX source of truth
- `.memory/state-transitions.md` — state model and queue semantics
- `.memory/implementation-plan.md` — implementation checklist and validation plan
- `AGENTS.md` — contributor rules for AI agents
