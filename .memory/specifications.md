# Telegram Relay Specification

## Goal

Build a **TypeScript pi extension** that relays a running pi agent to Telegram.

The relay must:

- send updates for **all pi runs** to Telegram
- accept Telegram messages and inject them into pi as normal user input
- keep Telegram readable by editing messages in place instead of flooding chat
- keep the local pi UI extremely simple

This spec is intended to remove implementation ambiguity.

---

## Product definition

This project is a **simple Telegram relay**.

It is **not**:

- a side panel
- a second control cockpit
- a separate agent runtime
- a second queue model

The main control surface remains the pi terminal.
Telegram is only the lightweight remote relay for updates and input.

---

## Non-negotiable decisions

These decisions are fixed.

### Relay scope

Relay **all pi runs**.

That includes:

- runs started from the local terminal
- runs started from Telegram input
- runs started after queued input is drained

If Telegram is connected and available, every pi run should attempt to produce Telegram updates.

### Footer meaning

`TG connected` means:

- relay config exists
- relay is enabled
- the connect / polling loop is running
- the **last Telegram API call succeeded within the last 60 seconds**

`TG disconnected` means anything else.

### Queue rule

Queued input across **all sources** is strict FIFO.

That means:

- local queued input and Telegram queued input share one effective ordering rule
- whichever input is accepted first must be delivered first
- Telegram must not leapfrog terminal input
- terminal input must not leapfrog Telegram input

### Ready-for-next-prompt rule

Pi is considered ready for the next queued prompt **after the current assistant message ends**.

Not after the current tool call.
Not after the current partial update.
Not only after some later manual confirmation.

### Remote command permissions

Telegram may invoke **all** commands that local pi input may invoke.

That includes:

- normal pi commands
- relay-management commands like `/telegram connect`, `/telegram toggle`, `/telegram logout`, `/telegram test`, and `/telegram status`

### Chat id flow

Chat id entry is **manual only**.

The user must paste a numeric chat id.
There is no chat-capture flow.

### Queue lifetime

Queued input is **in-memory only**.

Rules:

- if pi restarts, queued messages are lost
- if the extension reloads, queued messages are lost
- if the relay disconnects and reconnects during the same process, keep the same in-memory queue

### Final message handling

The final run result must **edit the same Telegram progress message**.

Do not send a separate final message as the default completion path.

If a long final result must be split for Telegram size limits:

- edit the original progress message into chunk 1
- send chunk 2+ as continuation messages

### Group trust model

Only accept Telegram input when both are true:

- `chat_id` matches the configured chat
- `sender_id` is in the configured whitelist

The whitelist supports multiple user ids.

### Failure handling

On any connection-affecting Telegram API failure:

- mark the footer disconnected immediately
- keep retrying automatically every **5 seconds**
- append repeated failures to a log file under `~/.pi/pi-telegram/`
- when a Telegram API call succeeds again, mark the footer connected again

---

## Config file

## Single source of truth

The relay must read and write **only**:

- `~/.pi/agent/pi-telegram.json`

No fallback paths.
No migration logic.
No reads from `settings.json`.

## Exact file shape

```json
{
  "version": 1,
  "enabled": true,
  "botToken": "123456789:ABCdef...",
  "botId": 123456789,
  "botUsername": "my_bot",
  "chatId": -1001234567890,
  "allowedUserIds": [111111111, 222222222],
  "lastValidatedAt": "2026-03-17T00:00:00.000Z"
}
```

## Field rules

- `version` — required, must be `1`
- `enabled` — required boolean; controls auto-connect behavior
- `botToken` — required string
- `botId` — required numeric id resolved during token validation
- `botUsername` — required string resolved during token validation
- `chatId` — required numeric Telegram chat id
- `allowedUserIds` — required array of numeric user ids; must contain at least one id
- `lastValidatedAt` — required ISO timestamp string

## File behavior

- write atomically
- preserve unknown future fields if they already exist
- `/telegram toggle` updates only `enabled`
- `/telegram logout` deletes `~/.pi/agent/pi-telegram.json`

---

## Connect flow

## `/telegram connect`

This command must be guided and interactive.

### Inputs collected

The flow collects, in order:

1. bot token
2. chat id
3. allowed user ids as CSV
4. enable-now confirmation

### Token validation

Validate the bot token immediately.

On success, show:

- bot username
- bot id

The user does **not** type the bot id manually.
It is resolved from Telegram.

### Chat id validation

The user must paste a numeric chat id manually.

Validation must confirm:

- the value parses as a number
- `getChat(chatId)` succeeds
- `getChatMember(chatId, botId)` succeeds
- the bot can access that chat
- the chat is usable for relay purposes

### Allowed user id validation

The user must paste a CSV of numeric Telegram user ids.

Rules:

- trim whitespace
- require at least one id
- reject non-numeric values
- store as numeric array in input order

### Setup hints

The connect flow must show short hints explaining where to get:

- chat id
- user id
- bot id

Bot id is for user reference only; it is still resolved automatically from the token.

### Save result

After validation succeeds:

- write the config file
- set `enabled` from the user’s choice
- if enabled, connect immediately
- update the footer immediately

---

## Commands

## Public command surface

Use one command root:

- `/telegram`

Subcommands:

- `/telegram connect`
- `/telegram toggle`
- `/telegram logout`
- `/telegram test`
- `/telegram status`

Optional aliases are allowed, but `/telegram ...` is the canonical interface.

## Command rules

### `/telegram`

Shows:

- connected or disconnected
- enabled true or false
- bot username and bot id if configured
- chat id if configured
- allowed user ids
- queue length
- active Telegram progress message id if one exists
- last successful Telegram API call time
- current retry state if disconnected due to runtime failure
- current failure log path if a retry episode is active

### `/telegram toggle`

Rules:

- if no config file exists, refuse and direct the user to `/telegram connect`
- flip the persisted `enabled` flag
- if `enabled` becomes `false`, disconnect immediately
- if `enabled` becomes `true`, start or resume connection attempts immediately
- preserve the rest of the config file

### `/telegram logout`

Rules:

- require confirmation
- disconnect
- delete `~/.pi/agent/pi-telegram.json`
- clear in-memory relay state tied to saved credentials
- do **not** remove prompt items that were already accepted into pi’s prompt flow
- set footer to disconnected

### `/telegram status`

This command is the deterministic state report for both humans and AI.

It must use this exact line-oriented shape:

```text
connection: <connected|disconnected>
enabled: <true|false>
bot_username: <value|none>
bot_id: <value|none>
chat_id: <value|none>
allowed_user_ids: <csv|none>
queue_length: <number>
active_progress_message_id: <value|none>
last_api_success_at: <iso-timestamp|none>
retry_state: <active|inactive>
failure_log_path: <path|none>
```

No prose paragraphs.
No table formatting.
No omitted fields.

### `/telegram test`

This command must:

1. send a Telegram test message
2. include a one-time numeric reply code
3. wait up to **60 seconds** for a matching reply from an allowed sender in the configured chat
4. report success or failure locally
5. edit the Telegram test message to reflect success or expiry

---

## Local footer

## Steady states

The footer should stay simple.

Steady states:

- `TG connected`
- `TG disconnected`

## Failure feedback

When runtime failures occur, the footer may temporarily expand the disconnected state with short retry feedback.

Allowed retry format:

- `TG disconnected · retrying in 5s`

When Telegram calls succeed again, return to:

- `TG connected`

---

## Telegram outbound behavior

## All runs are relayed

If the relay is connected, every pi run must attempt Telegram updates.

That includes locally started runs.

## One progress message per run

For each run.

A run is the full `agent_start` → `agent_end` envelope.
A run may contain multiple turns.
Steering and follow-up messages extend the same run and do **not** create a separate run.

For each run:

- create one Telegram progress message when the run starts
- keep its `message_id`
- edit that same message as the run evolves

## Render only on meaningful delta

Only edit the Telegram message when the rendered content changes.

Do not edit for no-op timer ticks or unchanged output.

## Finalization rule

At run end:

- edit the same progress message into its final state
- do not leave stale progress content behind

## Takopi formatting rules

Use Takopi-style behavior as the baseline.

Lock these defaults:

- progress header format: `status · pi · <elapsed> · step <n>`
- keep at most **5** recent action lines in progress output
- file change summaries should show at most **3** inline file paths before overflow summary
- final body should target **3500 characters max per Telegram message body chunk**
- if final output exceeds that size, split into continuation chunks labeled `continued (N/M)`
- preserve code fences when splitting
- preserve ordered lists and bullet lists when rendering
- sanitize unsupported local links instead of emitting broken links

## Output content rules

Show compact human-readable action summaries.

Do show:

- current state
- elapsed time
- a few recent meaningful actions
- concise final answer or failure summary

Do not show:

- token-by-token streaming
- giant raw logs
- repeated partial assistant text
- noisy low-signal internal events

---

## Telegram inbound behavior

## Acceptance rule

Accept a Telegram input event only when:

- `chat_id` matches the configured `chatId`
- `sender_id` exists
- `sender_id` is included in `allowedUserIds`

Ignore all other incoming events.

## Supported source types

For v1, accept:

- normal Telegram text messages
- Telegram message edits for queued normal text messages

For v1, do **not** accept captions as prompt input.

Non-text input is out of scope for prompt injection.

## Injection model

Every accepted Telegram message must behave as if the user typed it directly into the pi harness input.

There is no separate Telegram-only prompt model.

## Agent queue semantics

Pi has two internal message insertion paths during a run:

- steering queue via `agent.steer()`
- follow-up queue via `agent.followUp()`

### Steering queue semantics

Steering messages are consumed mid-run between tool boundaries.

When a steering message is consumed:

- remaining tool calls in the current turn are skipped
- the steering message is injected into context
- a new turn starts immediately
- the run continues inside the same `agent_start` → `agent_end` envelope

### Follow-up queue semantics

Follow-up messages are consumed only when the agent would otherwise stop.

When a follow-up message is consumed:

- it becomes the next pending user message
- a new turn starts immediately
- the run continues inside the same `agent_start` → `agent_end` envelope

### Telegram default when pi is busy

If a Telegram message arrives while pi is busy, the relay must place it into the **follow-up queue by default**.

It must **not** create a fresh `agent.prompt()` call after `agent_end`.

That means the busy-path Telegram message is consumed inside the current run if the run continues long enough to reach follow-up consumption.

### Telegram interrupt behavior

V1 does not invent a new interrupt mode.

If a future explicit interrupt feature is added, it may route selected Telegram input to the steering queue.
Until then, the default busy-path behavior is follow-up only.

### If pi is idle

Inject the Telegram message immediately as the next prompt.

### If pi is busy

Queue the Telegram message into the follow-up queue.

The queue must then:

- preserve FIFO order across all queued sources
- drain automatically after the current assistant message ends
- continue draining one item after another until the queue is empty

This should mirror how queued local terminal prompts behave.

## Telegram message edits while queued

If a Telegram message is already queued and the user edits that same Telegram message **before it has been dispatched into pi**:

- identify the queued item by the original Telegram `message_id`
- update the queued item’s text in place
- preserve its original queue position
- do not create a second queued item

If the Telegram message has already been dispatched into pi:

- ignore later Telegram edits for prompt injection purposes

## New Telegram messages while queued

If the user sends a brand-new Telegram message:

- enqueue it as a new FIFO item

Editing a queued message updates that queued item.
Sending a new message adds a new queue item.

## Remote command behavior

Telegram may send:

- normal prompts
- pi commands
- relay-management commands

All are accepted through the same input model, subject to the whitelist and chat match rules.

---

## Queue behavior

## Queue storage

The prompt queue is in-memory only.

## Ordering rule

Ordering is by acceptance time across all sources.

All accepted prompt inputs must enter one effective prompt queue and receive one monotonic acceptance order.
Dispatch must happen strictly by that order.

If two queued items are accepted in the same logical instant, preserve insertion order.

## Disconnect / reconnect rule

If the relay disconnects and later reconnects during the same pi process:

- keep the existing in-memory queue
- continue draining it once pi is ready

## Restart / reload rule

If pi restarts or the extension reloads:

- do not persist queued prompts
- do not restore queued prompts

## Logout rule for accepted prompts

If `/telegram logout` happens after a prompt was already accepted into pi’s prompt flow:

- that prompt remains in pi’s prompt flow
- it may still execute later according to normal queue semantics
- logout only stops future Telegram relay activity and removes saved relay credentials

---

## Failure handling and logging

## Runtime failure response

A failure is connection-affecting only if it is one of these:

- unreachable Telegram
- invalid token or auth responses
- polling failures
- network or timeout failures
- send/edit failures caused by auth, connectivity, or transport failure

A failure is **not** connection-affecting if it is only:

- invalid content formatting
- stale or non-editable message state
- message-specific payload rejection that does not indicate transport loss

On a connection-affecting failure:

- switch the footer to disconnected immediately
- record the failure in the active failure log
- retry after 5 seconds
- continue retrying every 5 seconds until a Telegram API call succeeds

## Recovery response

When a Telegram API call succeeds again:

- mark the relay connected again
- return the footer to `TG connected`
- stop the current retry episode

A successful polling call also counts as a successful Telegram API call for connection-health purposes.

## Failure log location

Write repeated failures to:

- `~/.pi/pi-telegram/`

## Failure log file naming

Use one file per retry episode:

- `~/.pi/pi-telegram/YYYYMMDD-HHmmss.log`

## Failure log contents

Failure logs must be newline-delimited JSON.

Each line must include:

- `timestamp`
- `operation`
- `attempt`
- `error_type`
- `error_message`

When the connection recovers, stop appending to that episode log.
A later failure episode creates a new file.

---

## Session behavior

The relay is process-level connection state.

Rules:

- switching pi sessions does not disconnect Telegram
- all runs in the current pi process may be relayed while connected
- relay connection state is independent from any one conversation branch

---

## Non-goals for v1

Do not build:

- multiple chats
- multi-chat routing
- forum topics
- voice note input
- file upload prompt injection
- a side panel or alternate control surface
- queue persistence across restart

---

## Documentation maintenance

Any project change must update:

- `.memory/`
- `README.md`
- `AGENTS.md`

---

## Acceptance criteria

The implementation is correct only if all of the following are true:

1. The extension is written in TypeScript.
2. The relay reads and writes only `~/.pi/agent/pi-telegram.json`.
3. `/telegram connect` collects bot token, chat id, and allowed user ids CSV.
4. Bot token validation resolves and displays bot username and bot id.
5. Chat id is entered manually and validated against Telegram.
6. Allowed user ids are stored as a whitelist and enforced for all inbound Telegram control.
7. All pi runs, including local-terminal-originated runs, create Telegram progress updates while connected.
8. Each run uses one Telegram progress message and edits it in place.
9. Final output edits the original progress message.
10. Long final output uses Takopi-style safe splitting with continuation chunks.
11. Accepted Telegram messages are injected into pi as normal user input.
12. If pi is busy, queued input drains automatically after the current assistant message ends.
13. Queue order is strict FIFO across all sources.
14. Editing a queued Telegram message updates the queued item in place.
15. Sending a new Telegram message creates a new FIFO queued item.
16. Telegram may invoke all commands, including relay-management commands.
17. `TG connected` means the last Telegram API call succeeded within the last 60 seconds.
18. Runtime failure switches the relay to disconnected immediately and retries every 5 seconds.
19. Failure episodes are logged under `~/.pi/pi-telegram/YYYYMMDD-HHmmss.log`.
20. Queue state survives disconnect/reconnect within the same process and does not survive restart or extension reload.
21. Captions do not act as prompt input in v1.
22. `/telegram logout` does not remove prompts already accepted into pi’s prompt flow.
