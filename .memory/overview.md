# Overview

## What is this?
A TypeScript pi extension that relays a running pi agent to Telegram and accepts input back.

## Who is it for?
Users of pi who want to monitor and guide their running agent remotely through a Telegram chat.

## What does it do?
It acts as a bidirectional relay between pi and one Telegram chat:

- **Outbound**: all pi runs produce a single Telegram progress message that is edited in place, then finalized with the result. Long output is split into continuation chunks.
- **Inbound**: approved Telegram text messages are injected into pi as normal user input. If pi is busy, they queue as follow-up items and drain at turn boundaries or after the run ends. Queue ordering is strict FIFO across all sources. Editing a queued Telegram message updates it in place.
- **Remote commands**: messages starting with `/telegram` are intercepted by the extension for relay management (`status`, `toggle`, `test`, `logout yes`, `clear`).

Setup is lightweight: the user provides a bot token from `@BotFather`, then either messages the bot for auto-detection or manually enters the chat id. Private chats auto-derive the allowed user id; group chats require a whitelist.

The local UI stays quiet: the footer shows `Telegram Connected` / `Telegram Disconnected`, with only a brief `⠋ Telegram Connecting` spinner during active connection attempts. On startup with a previously validated config, the relay sends a short connected message to Telegram.

## Implementation status
All 35 implementation steps are complete. The extension is functional.

## Documentation roles
- `README.md` — human-facing quickstart and usage entrypoint
- `SETUP.md` — installation guide for AI agents and automated helpers
- `.memory/specifications.md` — behavior and UX source of truth
- `.memory/state-transitions.md` — state model and queue semantics
- `.memory/implementation-plan.md` — implementation checklist (all complete)
