# pi-telegram

A TypeScript pi extension that relays updates from a running pi agent to Telegram and lets Telegram messages flow back into pi.

## What this project is

This project aims to keep Telegram simple:

- pi stays the main control surface
- Telegram is the lightweight relay
- updates should be readable, not spammy
- Telegram replies should behave like normal pi input

## What matters

- one configured Telegram chat
- simple local status: connected or disconnected
- edit-in-place Telegram progress updates
- Telegram messages become the next prompt, or wait in queue until pi is ready
- config lives at `~/.pi/agent/pi-telegram.json`

## Quickstart

1. Read `.memory/overview.md`
2. Read `.memory/specifications.md`
3. Read `.memory/implementation-plan.md`
4. Build the extension in TypeScript
5. Load the extension in pi
6. Run `/telegram connect`
7. Run `/telegram test`

## Project map

- `.memory/overview.md` — plain-language project summary
- `.memory/specifications.md` — behavior and UX source of truth
- `.memory/implementation-plan.md` — build order and validation plan
- `AGENTS.md` — rules for AI contributors

That’s it. This repo should stay small and clear.
