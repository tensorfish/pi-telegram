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
- a whitelist of allowed Telegram user ids
- simple local status: connected or disconnected
- all pi runs relay to Telegram while connected
- edit-in-place Telegram progress updates
- Telegram messages become the next prompt, or enter the same run through the follow-up path when pi is busy
- queued Telegram message edits update the queued item in place
- captions are not accepted as prompt input in v1
- accepted prompts already inside pi keep their place even if the relay later disconnects or logs out
- config lives at `~/.pi/agent/pi-telegram.json`
- failure episodes are logged under `~/.pi/pi-telegram/`

## Quickstart

1. Read `.memory/overview.md`
2. Read `.memory/specifications.md`
3. Read `.memory/state-transitions.md`
4. Read `.memory/implementation-plan.md`
5. Build the extension in TypeScript
6. Load the extension in pi
7. Run `/telegram connect`
8. Run `/telegram test`

## Project map

- `.memory/overview.md` — plain-language project summary
- `.memory/specifications.md` — behavior and UX source of truth
- `.memory/state-transitions.md` — TLA+-style state model and flow diagrams
- `.memory/implementation-plan.md` — build order and validation plan
- `AGENTS.md` — rules for AI contributors

That’s it. This repo should stay small and clear.
