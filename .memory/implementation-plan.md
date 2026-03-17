# Implementation Plan

This is the build plan for the project.

Rules for this plan:

- each step is small
- each step has one goal
- each step contains no code
- each step includes a validation test
- each completed step must also trigger doc updates in `.memory/`, `README.md`, and `AGENTS.md`

---

## Step 1 — Load the extension

### Goal
Make the TypeScript pi extension load successfully and expose the `/telegram` command.

### Validation test
- Human-in-the-loop verification: start pi with the extension enabled and confirm `/telegram` appears in command discovery.
- AI feedback loop verification: capture a command listing or status output that shows the extension loaded and the `/telegram` command registered.

---

## Step 2 — Show a simple local status

### Goal
Show a persistent footer status with only two steady states: `TG disconnected` or `TG connected`.

### Validation test
- Human-in-the-loop verification: start pi with no Telegram connection and confirm the footer shows `TG disconnected`.
- AI feedback loop verification: expose a status report that includes the current footer state.

---

## Step 3 — Define the config file contract

### Goal
Use only `~/.pi/agent/pi-telegram.json` as the relay config source.

### Validation test
- Human-in-the-loop verification: confirm there is no config lookup outside `~/.pi/agent/pi-telegram.json`.
- AI feedback loop verification: expose a state report that includes the active config path and whether the file exists.

---

## Step 4 — Read saved relay state

### Goal
Load saved Telegram relay state from `~/.pi/agent/pi-telegram.json` on startup.

### Validation test
- Human-in-the-loop verification: prepare the config file, restart pi, and confirm the extension reads it.
- AI feedback loop verification: emit a startup state report showing whether config was found and what connection mode was requested.

---

## Step 5 — Validate the bot token

### Goal
Confirm that a provided bot token is valid and identify the bot.

### Validation test
- Human-in-the-loop verification: enter a valid token and see a clear success message that identifies the bot; enter an invalid token and see a clear failure message.
- AI feedback loop verification: emit a structured validation result with success or failure and the resolved bot identity when present.

---

## Step 6 — Validate the chat id

### Goal
Confirm that a provided chat id is reachable by the bot.

### Validation test
- Human-in-the-loop verification: enter a valid chat id and see a clear confirmation; enter an invalid or unreachable chat id and see a clear failure.
- AI feedback loop verification: emit a structured validation result with the chat id and reachability status.

---

## Step 7 — Build the `/telegram connect` flow

### Goal
Provide a guided connect flow that collects token and chat id, validates both, saves config, and optionally enables the relay.

### Validation test
- Human-in-the-loop verification: complete the flow without editing files manually and confirm the final state is clear.
- AI feedback loop verification: expose a final state report showing saved credentials present, selected connection state, and config file written.

---

## Step 8 — Save and restore connection preference

### Goal
Persist whether Telegram should connect automatically or remain disconnected after setup.

### Validation test
- Human-in-the-loop verification: connect, restart pi, and confirm the same preference is restored.
- AI feedback loop verification: emit a startup report that shows saved preference and resulting connection state.

---

## Step 9 — Build `/telegram toggle`

### Goal
Allow the user to connect or disconnect without changing saved credentials.

### Validation test
- Human-in-the-loop verification: run `/telegram toggle` twice and confirm the footer flips between `TG connected` and `TG disconnected`.
- AI feedback loop verification: capture before-and-after state reports showing that credentials stay the same while connection state changes.

---

## Step 10 — Build `/telegram logout`

### Goal
Forget saved credentials and return the relay to a disconnected state.

### Validation test
- Human-in-the-loop verification: run `/telegram logout`, confirm the relay disconnects, and confirm reconnect setup is required again.
- AI feedback loop verification: emit a state report showing no saved credentials and a disconnected relay.

---

## Step 11 — Send a manual Telegram message

### Goal
Prove the relay can send a message from pi to Telegram.

### Validation test
- Human-in-the-loop verification: trigger a manual send and confirm the message appears in the configured Telegram chat.
- AI feedback loop verification: record a delivery result with message id, destination chat id, and success or failure.

---

## Step 12 — Receive a Telegram message locally

### Goal
Prove the relay can receive a Telegram message from the configured chat.

### Validation test
- Human-in-the-loop verification: send a Telegram message and confirm pi shows that the message was received.
- AI feedback loop verification: emit a structured inbound event with message text, chat id, and acceptance decision.

---

## Step 13 — Inject Telegram input when pi is idle

### Goal
Treat an incoming Telegram message as the next prompt immediately when pi is idle.

### Validation test
- Human-in-the-loop verification: leave pi idle, send a Telegram message, and confirm the agent starts on that exact prompt.
- AI feedback loop verification: emit a state transition showing inbound Telegram text mapped directly to immediate prompt dispatch.

---

## Step 14 — Queue Telegram input while pi is busy

### Goal
Queue incoming Telegram messages instead of interrupting the active run.

### Validation test
- Human-in-the-loop verification: start a long task, send one Telegram message, and confirm the current run continues while the new message waits.
- AI feedback loop verification: expose a queue report that shows queue length increasing while the agent is busy.

---

## Step 15 — Preserve message arrival order

### Goal
Keep queued Telegram messages in strict first-in, first-out order.

### Validation test
- Human-in-the-loop verification: send multiple Telegram messages during one long run and confirm they are later applied in the same order.
- AI feedback loop verification: emit enqueue and dispatch order reports and compare them for exact match.

---

## Step 16 — Drain the queue when pi is ready

### Goal
Deliver queued Telegram messages when the harness is ready for the next user prompt.

### Validation test
- Human-in-the-loop verification: after the current run finishes, confirm queued messages begin flowing into pi without manual rescue steps.
- AI feedback loop verification: expose a queue drain report showing pending count dropping as prompts are dispatched.

---

## Step 17 — Start one Telegram progress message per run

### Goal
Create one Telegram progress message for a run instead of many separate messages.

### Validation test
- Human-in-the-loop verification: trigger a run and confirm Telegram receives one progress message for that run.
- AI feedback loop verification: emit a run report that shows one active progress message id attached to the run.

---

## Step 18 — Edit progress in place

### Goal
Update the same Telegram progress message as work evolves.

### Validation test
- Human-in-the-loop verification: watch an active run in Telegram and confirm the same message changes instead of new progress messages appearing.
- AI feedback loop verification: emit an edit report showing repeated updates against one message id and suppressed no-op updates.

---

## Step 19 — Finish runs cleanly in Telegram

### Goal
Turn the progress message into a clear final result when the run completes.

### Validation test
- Human-in-the-loop verification: confirm Telegram ends with a readable final result and no stale progress clutter.
- AI feedback loop verification: emit a finalization report showing the active progress message closed and the final message state recorded.

---

## Step 20 — Handle long Telegram output safely

### Goal
Keep long final output readable by trimming or splitting safely for Telegram.

### Validation test
- Human-in-the-loop verification: trigger a long response and confirm Telegram still shows readable, well-formed output.
- AI feedback loop verification: emit a render report showing whether output was trimmed or split and how many Telegram messages were used.

---

## Step 21 — Build `/telegram test`

### Goal
Provide an end-to-end test that confirms both outbound send and inbound reply behavior.

### Validation test
- Human-in-the-loop verification: run `/telegram test`, reply with the requested code, and confirm local success feedback.
- AI feedback loop verification: emit a test report with outbound sent, reply received, match result, and completion status.

---

## Step 22 — Build `/telegram status`

### Goal
Provide a simple state report for humans and AI.

### Validation test
- Human-in-the-loop verification: run `/telegram status` and confirm it clearly explains connection state, config path, queue size, and active relay state.
- AI feedback loop verification: use the status output as structured feedback for later validation and debugging.

---

## Step 23 — Verify startup and shutdown behavior

### Goal
Make relay startup, disconnect, reload, and shutdown clean and predictable.

### Validation test
- Human-in-the-loop verification: restart pi, reload the extension, and exit pi while observing that the relay connects or disconnects cleanly.
- AI feedback loop verification: emit lifecycle reports for startup, connect, disconnect, reload, and shutdown.

---

## Step 24 — Lock documentation to behavior

### Goal
Make documentation maintenance part of the implementation process.

### Validation test
- Human-in-the-loop verification: after completing any implementation step, confirm `.memory/`, `README.md`, and `AGENTS.md` were updated if project behavior changed.
- AI feedback loop verification: add a doc-change checklist to the state report so the AI can verify whether required docs were touched in the same change.
