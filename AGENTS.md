# AGENTS

## Purpose

This repository is for a **TypeScript pi extension** that relays information between a running pi agent and Telegram.

The extension must stay simple:

- pi terminal is the main control surface
- Telegram is only a lightweight relay for updates and replies
- local persistent UI should answer one question: is Telegram connected or disconnected?
- Telegram input should behave like normal pi harness input

## AI behavior

When working in this repo, the AI must:

- prefer the simplest design that matches the current specs
- preserve the project’s simple relay model
- avoid inventing extra control surfaces, dashboards, side panels, or sidecars
- keep Telegram output compact and useful
- prefer editing/updating messages over flooding chat
- treat inbound Telegram messages as normal user input for pi
- queue Telegram input in arrival order when pi is busy
- keep the extension implementation in TypeScript
- use only `~/.pi/agent/pi-telegram.json` for relay config

## What the AI must maintain

The AI must keep these files accurate at all times:

- `.memory/overview.md`
- `.memory/specifications.md`
- `.memory/implementation-plan.md`
- `README.md`
- `AGENTS.md`

## What the AI must update

Any project change must trigger updates to:

- `.memory/`
- `README.md`
- `AGENTS.md`

This is mandatory.
Do not treat documentation updates as optional.

## Update rule

If behavior, commands, config, UX, delivery flow, message formatting, or scope changes, the AI must update the docs in the same change.

Minimum expectation for every change:

1. review `.memory/overview.md`
2. review `.memory/specifications.md`
3. review `.memory/implementation-plan.md`
4. update `README.md`
5. update `AGENTS.md`

## Project guardrails

The AI must preserve these core constraints:

- no side panel or alternate control cockpit
- no complex persistent local UI
- footer state stays simple: Telegram connected or disconnected
- Telegram messages are relayed into pi as if typed into the harness input
- if pi is busy, Telegram messages wait in queue until pi is ready
- Telegram chat UX should avoid spam and prefer message edits where possible
- keep the project focused on one bot and one chat for v1

## Source of truth order

When deciding what to do, use this order:

1. latest user instruction
2. `AGENTS.md`
3. `.memory/specifications.md`
4. `.memory/implementation-plan.md`
5. `.memory/overview.md`
6. `README.md`

If any of these disagree, update the lower-level docs to match the current truth.
