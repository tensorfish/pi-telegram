# Telegram Relay Specification

## Goal

Enable a Telegram relay for pi that can:

- connect a running agent to Telegram
- push useful live updates into Telegram
- accept user input from Telegram and feed it back into the running agent
- stay readable in Telegram instead of flooding the chat with noisy updates

This builds on `.memory/overview.md` and reflects a review of:

- pi extension and TUI patterns in `../pi-mono`
- Takopi’s Telegram relay, rendering, queueing, and message-editing behavior in `../takopi`

---

## What we are building

This should feel like a **quiet, reliable relay** for a running pi agent.

It must be implemented as a **TypeScript pi extension** and should follow the extension and TUI patterns reviewed in `../pi-mono`.

The user can keep pi open locally, turn Telegram relay on, and then:

- watch progress remotely
- receive meaningful status updates
- reply from Telegram to guide the agent
- verify the connection end to end

The experience should feel like:

- **one live thread of work**, not a spammy log dump
- **simple control state**, both in pi and in Telegram
- **simple onboarding**, like `/login`, not like hand-editing config files

There should be **no separate side panel, cockpit, or control surface** inside pi.
The local pi terminal remains the main control surface.
Telegram is just the lightweight remote relay for updates and replies.

---

## Key findings from the references

### From pi-mono

1. **Bottom bar state should use `ctx.ui.setStatus()`**
   - This is the cleanest way to show persistent plugin state without replacing the whole footer.
   - `status-line.ts` is the closest reference pattern.

2. **If we only need an on/off indicator, we should not replace the full footer**
   - `custom-footer.ts` proves it is possible.
   - But for this feature, a small footer status is the right UX.

3. **Command UX should be guided and interactive**
   - pi’s `/login` flow is not a raw prompt dump; it is a guided, stateful interaction.
   - The Telegram connect flow should behave the same way: prompt, validate, confirm, save.

4. **Extension commands should stay discoverable and small in number**
   - Too many top-level slash commands make the command menu noisy.
   - A compact command surface is better.

### From Takopi

1. **Edits beat spam**
   - Takopi does not send a fresh Telegram message for every event.
   - It keeps one progress message alive and edits it as work changes.
   - This is the single most important Telegram UX lesson to copy.

2. **Only send meaningful deltas**
   - Takopi coalesces updates and only edits when rendered output actually changes.
   - We should do the same.

3. **Progress and final states should be formatted differently**
   - Progress messages are compact, action-oriented, and temporary.
   - Final messages are clearer, calmer, and can include the real answer.

4. **Long messages need Telegram-aware splitting**
   - Takopi trims or splits long finals.
   - Splits preserve code fences and add continuation labels.
   - We want that same discipline.

5. **Outbound message operations need basic queue/coalescing behavior**
   - A newer edit should replace an older pending edit for the same message.
   - Final sends should outrank stale progress edits.
   - This avoids race conditions and chat junk.

---

## Product behavior

### High-level behavior

The extension should provide a **simple Telegram relay connection**.

When enabled, the relay:

- loads Telegram credentials from its saved extension config
- connects to Telegram
- listens for incoming Telegram messages from the configured chat
- watches pi session / agent events
- sends compact Telegram updates
- edits active progress messages in place

When disabled, the relay disconnects cleanly and no Telegram traffic should flow.

### Lifecycle

- On startup, load the saved Telegram config.
- If the saved state is enabled and valid, connect automatically.
- If the saved state exists but is disabled, show that it is disconnected and do not connect.
- On logout, disconnect and clear saved credentials.
- On shutdown or reload, stop polling / background work cleanly.

---

## Recommended command UX

## Recommended public command surface

Use **one primary command root**:

- `/telegram`

Then expose subcommands:

- `/telegram connect`
- `/telegram toggle`
- `/telegram logout`
- `/telegram test`
- `/telegram status`

### Why this is the best UX

This is clearer than adding many separate slash commands.

It keeps the command menu clean while still making the feature obvious.

### Optional aliases

If we want first-time discoverability, we can add thin aliases:

- `/telegram-connect` → `/telegram connect`
- `/telegram-toggle` → `/telegram toggle`
- `/telegram-logout` → `/telegram logout`
- `/telegram-test` → `/telegram test`

But the **documented** UX should still be the single `/telegram ...` family.

### Command behavior

#### `/telegram`

Shows current state and help:

- connected or not
- enabled or disabled
- configured chat id
- whether saved credentials exist
- last validation result if known
- available subcommands

#### `/telegram connect`

Guided setup flow that mimics `/login` in spirit.

Flow:

1. Prompt for bot token.
2. Validate token immediately.
3. Prompt for chat id.
4. Validate chat id immediately.
5. Save config.
6. Ask whether to enable now.
7. Update bottom-bar status immediately.
8. Offer to run `/telegram test` next.

This should feel like a short setup wizard, not a raw prompt loop.

#### `/telegram toggle`

Flips relay state between enabled and disabled.

Rules:

- If no saved credentials exist, refuse and point the user to `/telegram connect`.
- If toggled on, connect immediately.
- If toggled off, disconnect immediately.
- Always show the resulting state explicitly: do not just say “toggled”.

Example success copy:

- `Telegram relay enabled`
- `Telegram relay disabled`

#### `/telegram logout`

Removes saved Telegram credentials and disables the relay.

Flow:

1. Ask for confirmation.
2. Disconnect.
3. Remove saved token and chat id.
4. Reset status to disconnected.

This is not just “disconnect for now”; it is “forget this Telegram connection”.

#### `/telegram test`

Runs an end-to-end connection check.

Flow:

1. Send a test message into Telegram.
2. In that message, ask the user to reply with a short one-time code.
3. Wait for a matching reply for a limited amount of time.
4. On success, confirm that both outbound and inbound paths work.
5. On timeout, show a clear failure state without breaking the saved connection.

This command should validate the full round trip, not just credentials.

#### `/telegram status`

Recommended even though it was not explicitly requested.

It reduces confusion and gives the user a quick answer to:

- Is it configured?
- Is it enabled?
- Is it healthy?
- What chat is it pointed at?

---

## Connect flow details

The connect flow should mimic pi’s `/login` behavior in tone and structure:

- guided
- step-by-step
- validated at each step
- clear success/failure copy
- no need to hand-edit JSON

### Inputs

The user provides:

- `bot token`
- `chat_id`

### Validation

Validation should happen immediately.

#### Bot token validation

Validate by connecting to Telegram and resolving bot identity.

Success should show something human-readable, for example:

- `Connected to @my_bot`

Failure should say something clear, for example:

- `Could not validate bot token`

#### Chat id validation

Validate that:

- it parses as a numeric Telegram chat id
- the bot can access that chat

Important:

- support negative chat ids for groups
- do not assume only private chats

### Save behavior

After successful validation, save the config and load it automatically on startup.

---

## Settings storage

## Preferred location

Use a dedicated extension-owned config file:

- `~/.pi/agent/pi-telegram.json`

This is a better fit for this extension than writing arbitrary extension state into pi’s main settings file.

### Why this is preferable

- keeps extension-owned credentials isolated
- avoids cluttering `settings.json`
- makes logout / reset simpler
- makes debugging easier
- keeps one obvious file for this feature

## Recommended file shape

```json
{
  "enabled": true,
  "botToken": "123456789:ABCdef...",
  "chatId": -1001234567890,
  "lastValidatedAt": "2026-03-17T00:00:00.000Z"
}
```

## Single source of truth

The extension should read and write **only**:

- `~/.pi/agent/pi-telegram.json`

No fallback paths.
No migration logic.
No reads from `settings.json`.

### Rules

- Preserve unrelated files.
- Only read and write `~/.pi/agent/pi-telegram.json`.
- Write the extension config atomically.
- Be tolerant of unknown future fields.
- Load this file automatically on startup.

---

## Bottom bar feedback

Use `ctx.ui.setStatus()` for a persistent footer indicator.

This should stay **extremely simple**.

## Recommended persistent states

- `TG disconnected`
- `TG connected`

That is the whole persistent model.

## Styling

Use simple color semantics:

- dim for disconnected
- green for connected

Anything more detailed, such as connect failures or test progress, should be shown as transient command feedback or notifications, not as persistent footer complexity.

The footer state should be readable at a glance and answer only one question:

- is Telegram connected or not?

---

## Telegram message UX

This is the most important part of the product.

The Telegram chat should feel useful, calm, and legible.

## Principles copied from Takopi

### 1. One live progress message per run

When a new run starts:

- send one progress message
- keep its Telegram `message_id`
- edit that message as work progresses

Do **not** emit a new Telegram message for every agent event.

### 2. Only edit on meaningful change

Do not edit just because time passed.

Edit only when the visible summary changes, for example:

- new step started
- action completed
- status changed
- final answer ready
- run failed
- run cancelled

### 3. Keep progress compact

Progress messages should be summaries, not transcripts.

Show:

- current state
- elapsed time
- a few recent meaningful actions

Do not show:

- token-by-token streaming
- raw diffs
- giant logs
- repetitive tool noise

### 4. Final messages should replace or conclude progress cleanly

When the run finishes:

- edit the progress message into the final result when possible
- or replace it cleanly if needed
- remove any temporary controls / loading state

### 5. Long messages must be Telegram-safe

If a final answer is too long:

- split it cleanly
- preserve code blocks
- add continuation labels like `continued (2/3)`
- keep the thread readable

---

## Recommended message format

## Progress message format

Use a compact Takopi-style structure:

```text
working · pi · 18s · step 3

✓ reviewed current files
✓ drafted command UX
↻ updating Telegram relay spec

reply in Telegram to guide the agent
```

### Notes

- first line is status + identity + elapsed time + step count
- body is short action lines
- footer can be a short interaction hint when useful

## Final message format

```text
done · pi · 42s

Saved the Telegram relay spec.

- defined connect / toggle / logout / test commands
- specified footer status behavior
- specified edit-in-place Telegram UX
```

### Failure format

```text
error · pi · 12s

Could not validate the configured chat id.

- bot token is valid
- bot cannot access the target chat
- run /telegram connect to update the saved settings
```

---

## Action summarization rules

Takopi’s biggest win is that it formats work as a small number of human-readable action lines.

We should do the same.

### Good action lines

- `reviewed current files`
- `reading overview.md`
- `editing settings flow`
- `running test message check`
- `updated 2 files`

### Bad action lines

- raw JSON payloads
- repeated partial assistant text
- huge patch output
- low-signal internal events

### File change formatting

Follow Takopi’s lead:

- show relative file names when possible
- cap inline file listing
- summarize overflow

Example:

- `updated README.md, src/relay.ts, src/status.ts …(+2 more)`

---

## Markdown / Telegram rendering rules

Takopi’s renderer is careful for a reason. We should carry over the same standards.

### Requirements

- render Telegram-safe formatting, not raw markdown guesses
- preserve code blocks and bullet lists cleanly
- preserve ordered lists when possible
- drop or sanitize unsupported local links instead of sending broken links
- split long bodies without breaking formatting
- if a code block is split, close and reopen it correctly

This is essential if Telegram updates should stay readable.

---

## Outbound update queue behavior

Even for one chat, we should keep the transport logic disciplined.

## Required behavior

- only one pending progress edit per active Telegram message
- if a newer edit arrives, it replaces the older pending edit
- final sends outrank stale progress edits
- stale edits should never land after the final result

This is directly inspired by Takopi’s outbox model and is important for race-free UX.

---

## Inbound message behavior

The relay must accept Telegram text and feed it back into pi.

## Basic rule

Only accept input from the configured chat.

## Delivery behavior

Every incoming Telegram message should be treated as if the user had typed it directly into the pi harness input.

### If the agent is idle

Use that Telegram message immediately as the next prompt.

### If the agent is already working

Queue that Telegram message and deliver it when the harness is ready for the next user prompt.

Rules:

- preserve arrival order
- each Telegram message becomes one user input item
- do not invent a separate Telegram-only prompt model
- do not silently drop messages
- do not interrupt the current run unless a future explicit command is added for that purpose

This should mirror normal local pi input behavior as closely as possible.

### Reserved relay replies

Some inbound Telegram replies should be consumed by the relay itself and **not** forwarded into the agent:

- `/telegram test` verification replies

## Slash-command parity

Telegram input should go through the same logical input path as normal typed input whenever possible.

That means if the user sends something like:

- `/compact`
- `/name release prep`
- `/telegram status`

it should behave as consistently as possible with local pi input.

---

## Test command behavior

`/telegram test` should prove that the relay works both ways.

## Test message UX

Send something like:

```text
Telegram relay test

Reply to this message with: 4821
This check expires in 60 seconds.
```

## Success behavior

On matching reply:

- update the test state in pi
- optionally edit the Telegram test message to mark success
- show a clear local confirmation

Example:

- `Telegram test passed: outbound and inbound relay both work`

## Timeout behavior

If the reply never arrives:

- show timeout locally
- optionally mark the Telegram test message as expired
- do not erase saved credentials automatically

This is a health check, not an auto-destructive action.

---

## Suggested state model

At minimum, the relay should track:

- saved credentials present or not
- enabled or disabled
- connected or disconnected
- current active Telegram progress message id, if any
- pending test request, if any

A simple practical persistent state set:

- `disconnected`
- `connected`

Anything more detailed should remain transient command feedback, not persistent UI state.

---

## Session behavior

The Telegram relay should be treated as **process-level connection state**, not temporary message state.

That means:

- switching pi sessions should not silently disconnect Telegram
- if the agent stays running, the relay stays available
- current session activity becomes the content that gets relayed

---

## Recommended non-goals for v1

To keep the first version clean, do **not** require:

- multiple chats
- multiple Telegram users
- forum topics / thread routing
- voice notes
- file uploads
- inline buttons beyond optional future polish
- rich admin controls inside Telegram

v1 should focus on:

- one bot
- one chat
- reliable outbound updates
- reliable inbound text replies
- strong local command UX

---

## Documentation maintenance

Any project change must also update the project docs.

Required update targets:

- `.memory/`
- `README.md`
- `AGENTS.md`

This repo should treat those files as part of the product, not as optional follow-up work.

---

## Acceptance criteria

The feature is correct when all of the following are true:

1. A user can run `/telegram connect`, enter a bot token and chat id, validate both, and save them.
2. The saved configuration is loaded only from `~/.pi/agent/pi-telegram.json` on startup.
3. The bottom bar immediately shows only whether Telegram is connected or disconnected.
4. When enabled, a new agent run creates one Telegram progress message, not a flood of messages.
5. Progress updates edit that message in place.
6. Final output is delivered cleanly and long output is split safely when needed.
7. Telegram messages are injected into pi as normal user input, as if they had been typed into the harness input directly.
8. If the agent is busy, Telegram messages are queued in arrival order until the harness is ready for the next prompt.
9. `/telegram toggle` cleanly enables and disables the relay connection.
10. `/telegram logout` clears saved credentials and disconnects the relay.
11. `/telegram test` sends a test message, waits for a reply, and confirms end-to-end health.
12. Config writes preserve unrelated files and only touch `~/.pi/agent/pi-telegram.json`.

---

## Final recommendation

The product should feel like **Takopi’s Telegram polish applied to a pi extension**:

- guided setup like pi
- quiet editing behavior like Takopi
- compact status formatting like Takopi
- simple local command UX
- instant bottom-bar clarity inside pi

If we get those five things right, this will feel polished instead of bolted on.
