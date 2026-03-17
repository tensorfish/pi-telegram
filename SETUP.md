# SETUP

This file teaches an AI agent how to install and verify `pi-telegram`.

## Goal

Install this repository as a pi extension so pi auto-discovers it, then configure the Telegram relay from inside pi.

## Preferred install method

Use pi's normal auto-discovery paths.

Choose one:

### Option A — global install from an existing checkout

If this repository already exists on disk at `/absolute/path/to/pi-telegram`:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s /absolute/path/to/pi-telegram ~/.pi/agent/extensions/pi-telegram
```

### Option B — global install by cloning directly into the extension directory

```bash
mkdir -p ~/.pi/agent/extensions
git clone <repo-url> ~/.pi/agent/extensions/pi-telegram
```

### Option C — project-local install

From the target project root:

```bash
mkdir -p .pi/extensions
git clone <repo-url> .pi/extensions/pi-telegram
```

Use project-local install only when the extension should apply to one project instead of all pi sessions.

## Do not use these as the default install path

Avoid these unless the user explicitly asks for them:

- `pi -e ./index.ts` for normal long-term installation
- loading the relay through unrelated wrapper scripts
- storing relay config anywhere except `~/.pi/agent/pi-telegram.json`

`pi -e` is fine for quick testing, but not the default install story.

## Verify that pi can see the extension

Start pi:

```bash
pi
```

If pi is already running, use:

```text
/reload
```

Then verify:

- `/telegram` appears as a command
- running `/telegram` shows a human-friendly overview and subcommand list
- the footer shows either `Telegram Connected`, `Telegram Disconnected`, or a brief `⠋ Telegram Connecting` state while the relay is still connecting
- on startup with an already validated enabled config, pi attempts a short Telegram "connected" message to the configured chat

## Configure the relay

Inside pi, run:

```text
/telegram connect
```

Provide:

1. Telegram bot token from `@BotFather`
2. either:
   - auto-detect by sending a message to the bot, or
   - a numeric chat id entered manually
3. allowed Telegram user ids when required
4. whether to enable the relay now

The connect flow validates:

- bot token via `getMe`
- chat via `getChat(chatId)`
- bot membership via `getChatMember(chatId, botId)`

Rules:

- private-chat setup auto-adds the detected user id to the whitelist
- group-chat setup still requires manual whitelist entry
- when manual chat id entry is used, the connect flow mentions `@userinfobot`
- when manual user-id entry is required, the connect flow mentions `@userinfobot`

## Verify inbound and outbound relay

Run:

```text
/telegram test
```

Then reply in Telegram with the code from the test message.

Success means:

- pi could send to Telegram
- Telegram input returned to pi
- the configured chat and whitelist are working

## Expected files

After setup, these paths matter:

- extension install path: `~/.pi/agent/extensions/pi-telegram/` or `.pi/extensions/pi-telegram/`
- relay config: `~/.pi/agent/pi-telegram.json`
- failure logs: `~/.pi/pi-telegram/YYYYMMDD-HHmmss.log`

## Update workflow

If this repo is already installed as a git checkout:

```bash
cd ~/.pi/agent/extensions/pi-telegram
git pull
```

Then in pi:

```text
/reload
```

If the install is project-local, run the same flow in `.pi/extensions/pi-telegram`.

## Uninstall workflow

1. In pi, run:

```text
/telegram logout
```

2. Remove the extension directory or symlink:

```bash
rm -rf ~/.pi/agent/extensions/pi-telegram
```

## AI-agent guardrails

When installing this extension, prefer the simplest deterministic path:

- prefer auto-discovery directories over ad hoc flags
- do not invent alternate relay config files
- do not read or write relay config from `settings.json`
- do not add extra UI surfaces during setup
- keep README human-focused and keep this file installation-focused
