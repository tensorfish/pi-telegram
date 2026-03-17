# AGENTS

## Purpose

This repository is for a **TypeScript pi extension** that relays information between a running pi agent and Telegram.

The implementation entrypoint is `index.ts`, with relay code under `src/`.

Documentation roles:

- `README.md` is the human entrypoint and quickstart
- `SETUP.md` is the installation guide for AI agents and automated helpers

The extension must stay simple:

- pi terminal is the main control surface
- Telegram is only a lightweight relay for updates and replies
- local persistent UI should answer one question: is Telegram connected or disconnected?
- while the relay is still connecting, the footer may briefly show a small spinner as `⠋ Telegram Connecting`
- Telegram input should behave like normal pi harness input
- all pi runs should relay to Telegram while connected

## AI behavior

When working in this repo, the AI must:

- prefer the simplest design that matches the current specs
- preserve the project’s simple relay model
- avoid inventing extra control surfaces, dashboards, side panels, or sidecars
- keep Telegram output compact and useful
- prefer editing/updating messages over flooding chat
- relay all pi runs while Telegram is connected
- treat inbound Telegram messages as normal user input for pi
- make `/telegram` human-friendly by default and reserve `/telegram status` for the raw deterministic report
- support connect-flow chat discovery either by messaging the bot or by manual chat id entry
- make setup hints explicit about where to get the bot token, manual chat ids, and manual user ids
- use the follow-up path by default for busy Telegram input so it extends the current run
- preserve strict FIFO ordering across all queued input sources
- update queued Telegram items in place when the source Telegram message is edited before dispatch
- accept only normal Telegram text messages for prompt input in v1, not captions
- enforce the configured whitelist of allowed Telegram user ids
- preserve already-accepted prompt items if the user later runs `/telegram logout`
- keep the extension implementation in TypeScript
- use only `~/.pi/agent/pi-telegram.json` for relay config
- on startup with an already validated enabled config, attempt a short Telegram connected message to the configured chat
- log failure episodes under `~/.pi/pi-telegram/`

## What the AI must maintain

The AI must keep these files accurate at all times:

- `.memory/overview.md`
- `.memory/specifications.md`
- `.memory/state-transitions.md`
- `.memory/implementation-plan.md`
- `README.md`
- `SETUP.md`
- `AGENTS.md`

## What the AI must update

Any project change must trigger updates to:

- `.memory/`
- `README.md`
- `SETUP.md`
- `AGENTS.md`

This is mandatory.
Do not treat documentation updates as optional.

## Update rule

If behavior, commands, config, UX, delivery flow, message formatting, or scope changes, the AI must update the docs in the same change.

Minimum expectation for every change:

1. review `.memory/overview.md`
2. review `.memory/specifications.md`
3. review `.memory/state-transitions.md`
4. review `.memory/implementation-plan.md`
5. update `README.md`
6. update `SETUP.md` when installation, loading, or operator workflow changes
7. update `AGENTS.md`

## Project guardrails

The AI must preserve these core constraints:

- no side panel or alternate control cockpit
- no complex persistent local UI
- footer state stays simple: `Telegram Connected` or `Telegram Disconnected`, with only a small `Telegram Connecting` spinner state during active connection attempts before the relay is healthy
- all pi runs relay to Telegram while connected
- Telegram messages are relayed into pi as if typed into the harness input
- if pi is busy, Telegram messages enter the follow-up path and are consumed after the current assistant message ends
- queue ordering is strict FIFO across all sources
- editing a queued Telegram message updates that queued item in place
- only whitelisted sender ids in the configured chat may steer the agent
- private-chat setup may auto-derive the allowed user id, but group-chat setup must still collect a whitelist
- captions are not prompt input in v1
- `/telegram logout` does not remove prompts already accepted into pi’s prompt flow
- Telegram chat UX should avoid spam and prefer message edits where possible
- keep the project focused on one bot and one chat for v1

## Source of truth order

When deciding what to do, use this order:

1. latest user instruction
2. `AGENTS.md`
3. `SETUP.md` for installation and loading procedures
4. `.memory/specifications.md`
5. `.memory/state-transitions.md`
6. `.memory/implementation-plan.md`
7. `.memory/overview.md`
8. `README.md`

If any of these disagree, update the lower-level docs to match the current truth.
