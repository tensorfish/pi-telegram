# Overview

## What is this?
This is an add-on for the pi agent that lets a running agent connect to Telegram, send updates there, and receive commands back.

## Who is it for?
It is for users of pi.dev who want to stay connected to their running agent through Telegram, so they can follow progress and respond without being tied to the main workspace.

## What does it do?
It acts as a relay between the running agent and Telegram. It sends updates from all agent runs into Telegram and lets approved Telegram users send messages back, making it easier to monitor and guide work from a simple chat interface.

Setup stays lightweight: the user provides a bot token from `@BotFather`, then either messages the bot so pi can auto-detect the chat, or manually enters the chat id.

Once connected, the local UI should stay quiet: the footer shows `Telegram Connected` / `Telegram Disconnected`, with only a brief `Telegram Connecting` spinner state before the relay becomes healthy.

## Documentation roles
- `README.md` is the human-facing quickstart and usage entrypoint.
- `SETUP.md` is the installation guide for AI agents and automated helpers.
