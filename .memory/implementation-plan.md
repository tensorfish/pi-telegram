# Implementation Plan

This is the execution plan for the Telegram relay.

This plan must be implemented in a way that preserves `.memory/state-transitions.md`.

## Current build status

All 35 implementation steps are complete. Source has been refactored into focused modules.

Source modules:

- `src/relay.ts` — polling lifecycle, connection state, footer, Telegram send/edit
- `src/commands.ts` — local and remote command handlers, connect flow
- `src/queue.ts` — prompt queue and dispatch logic
- `src/render.ts` — progress and final message rendering
- `src/telegram-api.ts` — raw Telegram Bot API client with AbortSignal support
- `src/types.ts` — shared type definitions
- `src/config.ts` — config file read/write/delete with atomic writes
- `src/index.ts` — thin orchestrator wiring events to the modules above
- `index.ts` — extension entrypoint (re-exports `src/index.ts`)

Key implementation details:

- progress edits throttled to at most one every 2 seconds to avoid Telegram rate limits
- startup sends the connection message before starting the poll loop to avoid 409 conflicts
- reconnection spinner stays visible during the retry sleep gap
- failed idle dispatch falls back to enqueueing instead of dropping the prompt
- `captureSetupOffset` retries on 409 conflicts up to 3 times

Documentation:

- `README.md` — human quickstart and usage entrypoint
- `SETUP.md` — AI-agent installation guide

Plan rules:

- each step is small
- each step has one goal
- each step contains no code
- each step includes a validation test
- every completed implementation change must also update `.memory/`, `README.md`, and `AGENTS.md`

---

## Step 1 — Load the TypeScript extension ✅

### Goal
Make the TypeScript pi extension load and register `/telegram`.

### Validation test
- Human-in-the-loop verification: start pi with the extension enabled and confirm `/telegram` appears in command discovery.
- AI feedback loop verification: record a command list or extension state report showing `/telegram` is registered.

---

## Step 2 — Show footer connection state ✅

### Goal
Show relay state in the footer using `Telegram Connected` or `Telegram Disconnected`, with a small `<spinner> Telegram Connecting` animation only while the relay is still becoming healthy.

### Validation test
- Human-in-the-loop verification: start pi with no valid connection and confirm the footer shows `Telegram Disconnected`; connect successfully and confirm it briefly shows `Telegram Connecting` before settling on `Telegram Connected`.
- AI feedback loop verification: emit a state report with the current footer value.

---

## Step 3 — Lock the config path and schema ✅

### Goal
Use only `~/.pi/agent/pi-telegram.json` and enforce the fixed config shape.

### Validation test
- Human-in-the-loop verification: confirm there is no read or write path outside `~/.pi/agent/pi-telegram.json`.
- AI feedback loop verification: emit a config report showing active path, schema version, and parsed fields.

---

## Step 4 — Load saved config on startup ✅

### Goal
Read `~/.pi/agent/pi-telegram.json` at startup, restore the saved relay preference, and if the saved config was already validated try a short Telegram connection message immediately.

### Validation test
- Human-in-the-loop verification: create the config file, restart pi, and confirm the relay restores the saved state and attempts the startup connected message.
- AI feedback loop verification: emit a startup report showing config found, enabled flag, parsed config values, and startup-send result.

---

## Step 5 — Validate the bot token ✅

### Goal
Validate a provided bot token and resolve bot username and bot id.

### Validation test
- Human-in-the-loop verification: enter a valid token and confirm both bot username and bot id are shown; enter an invalid token and confirm a clear failure message.
- AI feedback loop verification: emit a structured validation result with success flag, bot username, and bot id when valid.

---

## Step 6 — Resolve and validate the chat ✅

### Goal
Support both chat-discovery paths: auto-detect from a message sent to the bot, or manually pasted numeric chat id, then validate with `getChat(chatId)` and `getChatMember(chatId, botId)`.

### Validation test
- Human-in-the-loop verification: message the bot and confirm chat detection succeeds; also enter a valid numeric chat id manually and confirm success.
- AI feedback loop verification: emit a validation result with discovery mode, chat id, parse status when manual, `getChat` result, and `getChatMember` result.

---

## Step 7 — Collect and validate allowed user ids ✅

### Goal
Auto-fill the whitelist for private chats and require a CSV whitelist for group chats.

### Validation test
- Human-in-the-loop verification: connect a private chat and confirm the user id is auto-added; connect a group chat and confirm a CSV whitelist is still required.
- AI feedback loop verification: emit a whitelist result showing whether ids were auto-derived or manually entered.

---

## Step 8 — Build the `/telegram connect` flow ✅

### Goal
Create the guided connect flow that collects the bot token, offers auto-detect or manual chat setup, derives or collects allowed user ids as needed, writes config, and optionally enables the relay.

### Validation test
- Human-in-the-loop verification: complete both the auto-detect path and the manual path without manual file editing and confirm the final footer state matches the chosen enable setting.
- AI feedback loop verification: emit a connect-flow completion report with discovery mode, saved config fields, and resulting connection state.

---

## Step 9 — Add setup hints ✅

### Goal
Show short hints in the connect flow telling the user that the bot token comes from `@BotFather`, that they can message the bot for auto-detection, how to find a manual chat id, how to find user ids for group whitelists, and that group chats still require a whitelist.

### Validation test
- Human-in-the-loop verification: run `/telegram connect` and confirm the setup hints are visible during setup.
- AI feedback loop verification: emit a flow-state report showing the hint step was displayed.

---

## Step 10 — Build `/telegram toggle` ✅

### Goal
Allow connect and disconnect without losing saved credentials.

### Validation test
- Human-in-the-loop verification: run `/telegram toggle` twice and confirm the footer flips between connected and disconnected.
- AI feedback loop verification: emit before-and-after state reports showing only `enabled` and connection state changed.

---

## Step 11 — Build `/telegram logout` ✅

### Goal
Forget saved credentials by deleting the config file and disconnecting the relay without removing prompts already accepted into pi’s prompt flow.

### Validation test
- Human-in-the-loop verification: run `/telegram logout` and confirm the relay disconnects and the config file is removed; if prompts were already accepted into pi’s prompt flow, confirm they still execute normally.
- AI feedback loop verification: emit a logout report showing disconnected state, no config file present, and unchanged already-accepted prompt items.

---

## Step 12 — Build `/telegram status` ✅

### Goal
Return the exact deterministic key-value report required by the spec.

### Validation test
- Human-in-the-loop verification: run `/telegram status` and confirm it uses the fixed key-value line format and shows all required fields.
- AI feedback loop verification: parse the status output as structured state feedback without heuristics.

---

## Step 13 — Build `/telegram test` ✅

### Goal
Send a one-time reply-code test message and validate the full outbound and inbound path.

### Validation test
- Human-in-the-loop verification: run `/telegram test`, reply with the code from Telegram, and confirm local success output.
- AI feedback loop verification: emit a test report with sent flag, expected code, reply received flag, match result, and timeout result.

---

## Step 14 — Accept inbound Telegram messages only from the configured chat ✅

### Goal
Reject Telegram messages from other chats.

### Validation test
- Human-in-the-loop verification: send one message from the configured chat and one from a different chat and confirm only the configured chat is accepted.
- AI feedback loop verification: emit inbound acceptance reports showing accepted and rejected chat ids.

---

## Step 15 — Enforce the sender whitelist ✅

### Goal
Accept inbound Telegram messages only from whitelisted user ids.

### Validation test
- Human-in-the-loop verification: send one message from an allowed user and one from a non-allowed user and confirm only the allowed user is accepted.
- AI feedback loop verification: emit inbound acceptance reports showing sender id and whitelist decision.

---

## Step 16 — Relay all pi runs ✅

### Goal
Ensure that all pi runs, including local-terminal-originated runs, produce Telegram progress updates while connected.

### Validation test
- Human-in-the-loop verification: start one run locally and confirm it creates a Telegram progress message.
- AI feedback loop verification: emit a run report showing run source and attached Telegram progress message id.

---

## Step 17 — Inject Telegram input immediately when pi is idle ✅

### Goal
Treat an accepted Telegram message as the next prompt immediately when pi is idle.

### Validation test
- Human-in-the-loop verification: leave pi idle, send a Telegram message, and confirm pi starts that exact prompt.
- AI feedback loop verification: emit an inbound-to-dispatch transition report showing immediate prompt dispatch.

---

## Step 18 — Queue busy Telegram input via follow-up ✅

### Goal
When pi is busy, place accepted Telegram input into the follow-up path instead of interrupting the active assistant message.

### Validation test
- Human-in-the-loop verification: start a long run, send a Telegram message, and confirm the current run continues while the new input waits.
- AI feedback loop verification: emit a queue report showing the item entered follow-up state rather than triggering a fresh prompt call.

---

## Step 19 — Preserve FIFO across all queued sources ✅

### Goal
Use strict FIFO ordering across both local queued input and Telegram queued input.

### Validation test
- Human-in-the-loop verification: create a mixed sequence of local and Telegram queued prompts and confirm they execute in exact acceptance order.
- AI feedback loop verification: emit enqueue order and dispatch order reports and confirm they match.

---

## Step 20 — Update queued Telegram messages when edited ✅

### Goal
If a queued Telegram message is edited before dispatch, replace the queued text in place without changing queue position.

### Validation test
- Human-in-the-loop verification: queue a Telegram message during a long run, edit that Telegram message before dispatch, and confirm the edited text is what pi later receives.
- AI feedback loop verification: emit a queue-update report showing one queue item updated in place rather than duplicated.

---

## Step 21 — Queue new Telegram messages as new FIFO items ✅

### Goal
Treat a brand-new Telegram message as a new queued item even if another queued message from the same sender already exists.

### Validation test
- Human-in-the-loop verification: send two separate Telegram messages during one long run and confirm they later dispatch as two separate prompts in order.
- AI feedback loop verification: emit queue reports showing two distinct queued items.

---

## Step 22 — Consume follow-up queue inside the active run ✅

### Goal
Drain queued prompts automatically, one after another, inside the same run after the current assistant message ends.

### Validation test
- Human-in-the-loop verification: finish the active assistant message and confirm queued prompts continue automatically until the queue is empty without requiring a new outer prompt call.
- AI feedback loop verification: emit a queue-drain report showing queued count decreasing to zero while the same run id remains active until the queue is exhausted.

---

## Step 23 — Create one progress message per run ✅

### Goal
Start one Telegram progress message for each run.

### Validation test
- Human-in-the-loop verification: trigger a run and confirm exactly one Telegram progress message is created for that run.
- AI feedback loop verification: emit a run state report with one active progress message id.

---

## Step 24 — Edit progress only on meaningful delta ✅

### Goal
Update the progress message only when the rendered content changes.

### Validation test
- Human-in-the-loop verification: watch a run in Telegram and confirm the message edits in place without noisy duplicate updates.
- AI feedback loop verification: emit edit reports showing actual edits and suppressed no-op renders.

---

## Step 25 — Apply Takopi-style rendering limits ✅

### Goal
Use the locked Takopi-style rendering defaults for action count, file summary clamping, and safe final chunk sizing.

### Validation test
- Human-in-the-loop verification: run a task with multiple actions and long output and confirm the Telegram formatting matches the spec limits.
- AI feedback loop verification: emit a render report showing action count used, inline file count, chunk count, and chunk sizes.

---

## Step 26 — Edit the final result into the original progress message ✅

### Goal
Turn the original progress message into the final run result instead of sending a separate final message.

### Validation test
- Human-in-the-loop verification: finish a run and confirm the same Telegram message becomes the final result.
- AI feedback loop verification: emit a finalization report showing the final state used the original progress message id.

---

## Step 27 — Split oversized final output safely ✅

### Goal
If final output is too large, edit the original message into chunk 1 and send continuation chunks for the rest.

### Validation test
- Human-in-the-loop verification: trigger a long final answer and confirm chunk 1 replaces the original message and later chunks are labeled `continued (N/M)`.
- AI feedback loop verification: emit a split-output report showing original message id, number of chunks, and continuation labels.

---

## Step 28 — Define connected from recent API success ✅

### Goal
Make `Telegram Connected` mean the last Telegram API call succeeded within the last 60 seconds, while allowing only a brief `<spinner> Telegram Connecting` state before the relay becomes healthy.

### Validation test
- Human-in-the-loop verification: keep the relay healthy and confirm the footer settles on `Telegram Connected`; break the connection and confirm it becomes disconnected.
- AI feedback loop verification: emit a health report showing last successful API call timestamp and resulting connection state.

---

## Step 29 — Retry every 5 seconds after connection-affecting failure ✅

### Goal
On a connection-affecting Telegram API failure, switch to disconnected and retry automatically every 5 seconds until success.

### Validation test
- Human-in-the-loop verification: make Telegram unreachable and confirm the footer switches to disconnected with retry feedback, then reconnect and confirm recovery.
- AI feedback loop verification: emit retry reports with failure class, failure time, retry interval, attempt count, and recovery time.

---

## Step 30 — Write newline-delimited JSON failure logs ✅

### Goal
Write repeated failure episodes to `~/.pi/pi-telegram/YYYYMMDD-HHmmss.log` using newline-delimited JSON entries.

### Validation test
- Human-in-the-loop verification: trigger repeated failures and confirm a log file is created and appended to in the expected directory.
- AI feedback loop verification: emit a failure-log report showing active log path and sample appended JSON entries.

---

## Step 31 — Keep queue on disconnect and reconnect ✅

### Goal
Preserve the in-memory queue across relay disconnect and reconnect inside the same pi process.

### Validation test
- Human-in-the-loop verification: queue Telegram prompts, force a disconnect and reconnect, then confirm the queued prompts still drain afterward.
- AI feedback loop verification: emit queue state reports before disconnect, during disconnect, and after reconnect showing the same queued items retained.

---

## Step 32 — Drop queue on restart or extension reload ✅

### Goal
Do not persist queued prompts across pi restart or extension reload.

### Validation test
- Human-in-the-loop verification: queue prompts, restart pi or reload the extension, and confirm the queue is empty afterward.
- AI feedback loop verification: emit startup reports showing no queue restored from disk.

---

## Step 33 — Reject captions and non-text prompt input ✅

### Goal
Accept only normal Telegram text messages for prompt injection in v1 and reject captions and non-text input.

### Validation test
- Human-in-the-loop verification: send a normal text message and confirm it is accepted; send a caption-only message or other non-text input and confirm it is ignored for prompt injection.
- AI feedback loop verification: emit inbound acceptance reports showing supported and rejected input types.

---

## Step 34 — Preserve already-accepted prompts across logout ✅

### Goal
Ensure `/telegram logout` removes relay credentials and disconnects the relay without removing prompt items already accepted into pi’s prompt flow.

### Validation test
- Human-in-the-loop verification: accept a prompt into pi’s flow, run `/telegram logout`, and confirm the accepted prompt still executes normally.
- AI feedback loop verification: emit a logout-state report showing relay credentials removed while already-accepted prompt items remain unchanged.

---

## Step 35 — Lock documentation to implementation ✅

### Goal
Make doc maintenance part of the implementation process.

### Validation test
- Human-in-the-loop verification: after any behavior change, confirm `.memory/`, `README.md`, and `AGENTS.md` changed in the same work.
- AI feedback loop verification: emit a doc-update checklist report that lists whether `.memory/specifications.md`, `.memory/state-transitions.md`, `.memory/implementation-plan.md`, `README.md`, and `AGENTS.md` were reviewed and updated.
