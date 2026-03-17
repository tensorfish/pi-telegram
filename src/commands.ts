import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
	deleteRelayConfig,
	readRelayConfig,
	writeRelayConfig,
} from "./config.ts";
import { TelegramApi } from "./telegram-api.ts";
import type { RelayConfig, TelegramChat, TelegramUpdate } from "./types.ts";
import type { RelayConnection } from "./relay.ts";
import { report, sleep } from "./relay.ts";

const TEST_TIMEOUT_MS = 60_000;
const CHAT_DISCOVERY_TIMEOUT_MS = 60_000;
const CHAT_DISCOVERY_POLL_SECONDS = 10;

interface PendingTest {
	code: string;
	messageId: number;
	expiresAt: number;
}

interface ResolvedChatTarget {
	chat: TelegramChat;
	chatId: number;
	allowedUserIds: number[];
	nextOffset: number | undefined;
	discoveryMode: "auto" | "manual";
	detectedSenderId?: number;
}

interface CapturedTelegramChat {
	chat: TelegramChat;
	chatId: number;
	senderId: number;
	nextOffset: number | undefined;
}

interface ChatCaptureAttempt {
	captured: CapturedTelegramChat | null;
	nextOffset: number | undefined;
}

export class CommandHandler {
	pendingTest: PendingTest | null = null;

	constructor(private readonly relay: RelayConnection) {}

	// --- Load / save ---

	async loadConfig(): Promise<void> {
		const config = await readRelayConfig();
		this.relay.setConfig(config);
	}

	async saveConfig(config: RelayConfig): Promise<void> {
		await this.relay.stopPolling();
		this.relay.setConfig(config);
		await writeRelayConfig(config);
	}

	// --- Local command dispatch ---

	async handleTelegramCommand(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
		const [command = ""] = rawArgs.trim().split(/\s+/).filter(Boolean);
		switch (command) {
			case "":
				ctx.ui.notify(this.relay.buildCommandHelpText(), "info");
				return;
			case "status": {
				const statusText = this.relay.buildStatusText();
				report("status", this.relay.buildStatusReport());
				ctx.ui.notify(statusText, "info");
				return;
			}
			case "connect":
				await this.runConnectFlow(ctx);
				return;
			case "toggle":
				await this.toggleRelay(ctx);
				return;
			case "logout":
				await this.logoutRelay(ctx);
				return;
			case "test":
				await this.runRelayTest(ctx);
				return;
			default:
				ctx.ui.notify(this.relay.buildCommandHelpText(), "warning");
		}
	}

	// --- Remote command dispatch ---

	handleRemoteTelegramCommand(text: string): boolean {
		if (!text.startsWith("/telegram")) return false;
		const [, rawSubcommand = "", ...rest] = text.split(/\s+/);
		const subcommand = rawSubcommand.trim();
		switch (subcommand) {
			case "":
				void this.relay.telegramSend(this.relay.buildCommandHelpText());
				break;
			case "status":
				void this.relay.telegramSend(this.relay.buildStatusText());
				break;
			case "test":
				void this.remoteTest();
				break;
			case "toggle":
				void this.remoteToggle();
				break;
			case "logout":
				if (rest[0] !== "yes") {
					void this.relay.telegramSend("Remote logout requires confirmation. Send: /telegram logout yes");
				} else {
					void this.relay.telegramSend("Telegram relay logging out.");
					void this.logoutCore();
				}
				break;
			case "connect":
				void this.relay.telegramSend("Remote connect is not available. Use local /telegram connect.");
				break;
			default:
				void this.relay.telegramSend(this.relay.buildCommandHelpText());
		}
		return true;
	}

	// --- Test ---

	async runRelayTest(ctx: ExtensionCommandContext): Promise<void> {
		if (!this.relay.config || !this.relay.api) {
			ctx.ui.notify("No relay config found. Use /telegram connect.", "warning");
			return;
		}
		const code = String(Math.floor(1000 + Math.random() * 9000));
		const text = `Telegram relay test\n\nReply to this message with: ${code}\nThis check expires in 60 seconds.`;
		this.relay.setWorkingMessage("Sending Telegram test message...");
		try {
			const messageId = await this.relay.telegramSend(text);
			if (!messageId) {
				ctx.ui.notify("Could not send the Telegram test message.", "error");
				return;
			}
			this.pendingTest = { code, messageId, expiresAt: Date.now() + TEST_TIMEOUT_MS };
			this.relay.setWorkingMessage("Waiting for test reply in Telegram...");
			report("test.sent", { code, messageId, expiresAt: this.pendingTest.expiresAt });
		} catch {
			this.relay.setWorkingMessage();
		}
		// Working message stays visible until test completes or expires
	}

	async completeTestSuccess(senderId: number): Promise<void> {
		if (!this.pendingTest) return;
		await this.relay.telegramEdit(this.pendingTest.messageId, "Telegram relay test\n\nSuccess. Outbound and inbound relay both work.");
		report("test.success", { senderId, messageId: this.pendingTest.messageId });
		this.pendingTest = null;
		this.relay.setWorkingMessage();
	}

	async expirePendingTestIfNeeded(): Promise<void> {
		if (!this.pendingTest) return;
		if (Date.now() < this.pendingTest.expiresAt) return;
		const expired = this.pendingTest;
		this.pendingTest = null;
		await this.relay.telegramEdit(expired.messageId, "Telegram relay test\n\nExpired. No matching reply was received in time.");
		report("test.expired", { messageId: expired.messageId });
		this.relay.setWorkingMessage();
	}

	private async remoteTest(): Promise<void> {
		if (!this.relay.config) return;
		const code = String(Math.floor(1000 + Math.random() * 9000));
		const body = `Telegram relay test\n\nReply to this message with: ${code}\nThis check expires in 60 seconds.`;
		const messageId = await this.relay.telegramSend(body);
		if (messageId) this.pendingTest = { code, messageId, expiresAt: Date.now() + TEST_TIMEOUT_MS };
	}

	// --- Toggle ---

	async toggleRelay(ctx: ExtensionCommandContext): Promise<void> {
		if (!this.relay.config) {
			ctx.ui.notify("No relay config found. Use /telegram connect.", "warning");
			return;
		}
		const nextConfig = { ...this.relay.config, enabled: !this.relay.config.enabled };
		await this.saveConfig(nextConfig);
		if (nextConfig.enabled) {
			await this.relay.ensureDesiredConnection();
			ctx.ui.notify("Telegram relay enabled.", "info");
		} else {
			await this.relay.stopPolling();
			ctx.ui.notify("Telegram relay disabled.", "info");
		}
		this.relay.refreshFooter();
		report("toggle", { enabled: nextConfig.enabled });
	}

	private async remoteToggle(): Promise<void> {
		if (!this.relay.config) return;
		if (this.relay.config.enabled) {
			await this.relay.telegramSend("Telegram relay disabling.");
		}
		const nextConfig = { ...this.relay.config, enabled: !this.relay.config.enabled };
		await this.saveConfig(nextConfig);
		if (nextConfig.enabled) {
			await this.relay.ensureDesiredConnection();
			await this.relay.telegramSend("Telegram relay enabled.");
		} else {
			await this.relay.stopPolling();
		}
		this.relay.refreshFooter();
	}

	// --- Logout ---

	async logoutRelay(ctx: ExtensionCommandContext): Promise<void> {
		const confirmed = await ctx.ui.confirm("Logout Telegram relay?", "This removes saved credentials and disconnects the relay.");
		if (!confirmed) return;
		await this.logoutCore();
		ctx.ui.notify("Telegram relay logged out.", "info");
	}

	async logoutCore(): Promise<void> {
		await this.relay.stopPolling();
		await deleteRelayConfig();
		this.relay.setConfig(null);
		this.relay.lastApiSuccessAt = null;
		this.relay.retryActive = false;
		this.relay.retryAttempt = 0;
		this.relay.retryLogPath = null;
		this.pendingTest = null;
		this.relay.refreshFooter();
		report("logout", {});
	}

	// --- Connect flow ---

	async runConnectFlow(ctx: ExtensionCommandContext): Promise<void> {
		const resumePreviousRelay = Boolean(this.relay.config?.enabled && this.relay.api);
		let saved = false;
		await this.relay.stopPolling();
		try {
			const botToken = await ctx.ui.input(
				"Bot token from @BotFather",
				"123456789:ABCdef...",
			);
			if (!botToken) return;
			const token = botToken.trim();
			const probeApi = new TelegramApi(token);
			let me;
			this.relay.setWorkingMessage("Validating Telegram bot token...");
			try {
				me = await probeApi.getMe();
			} catch (error) {
				report("connect.validate_bot.failure", { error: error instanceof Error ? error.message : String(error) });
				ctx.ui.notify("Could not validate bot token from @BotFather.", "error");
				return;
			} finally {
				this.relay.setWorkingMessage();
			}
			const startOffset = await this.captureSetupOffset(probeApi);
			const resolved = await this.resolveChatTarget(ctx, probeApi, me.id, startOffset);
			if (!resolved) return;
			const enableNow = await ctx.ui.confirm(
				"Enable Telegram relay now?",
				`Bot: @${me.username ?? "unknown"} (${me.id})\nChat: ${resolved.chatId}${resolved.chat.type ? ` (${resolved.chat.type})` : ""}\nAllowed users: ${resolved.allowedUserIds.join(", ")}`,
			);
			const nextConfig: RelayConfig = {
				version: 1,
				enabled: enableNow,
				botToken: token,
				botId: me.id,
				botUsername: me.username ?? `bot_${me.id}`,
				chatId: resolved.chatId,
				allowedUserIds: resolved.allowedUserIds,
				lastValidatedAt: new Date().toISOString(),
			};
			await this.saveConfig(nextConfig);
			this.relay.recordApiSuccess();
			this.relay.currentOffset = resolved.nextOffset;
			saved = true;
			await this.relay.ensureDesiredConnection();
			this.relay.refreshFooter();
			report("connect.saved", {
				chatId: resolved.chatId,
				chatType: resolved.chat.type,
				allowedUserIds: resolved.allowedUserIds,
				enabled: enableNow,
				botId: me.id,
				botUsername: me.username,
				discoveryMode: resolved.discoveryMode,
				detectedSenderId: resolved.detectedSenderId,
			});
		} finally {
			this.relay.setWorkingMessage();
			if (!saved && resumePreviousRelay) await this.relay.ensureDesiredConnection();
			this.relay.refreshFooter();
		}
	}

	private async captureSetupOffset(api: TelegramApi): Promise<number | undefined> {
		if (this.relay.currentOffset !== undefined) return this.relay.currentOffset;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const updates = await api.getUpdates(undefined, 0);
				if (updates.length === 0) return undefined;
				return updates[updates.length - 1]!.update_id + 1;
			} catch (error) {
				if (this.relay.isTransientDiscoveryError(error) && attempt < 2) {
					await sleep(1_000);
					continue;
				}
				report("connect.capture_offset.failure", { error: error instanceof Error ? error.message : String(error) });
				return this.relay.currentOffset;
			}
		}
		return this.relay.currentOffset;
	}

	private async resolveChatTarget(
		ctx: ExtensionCommandContext,
		api: TelegramApi,
		botId: number,
		startOffset: number | undefined,
	): Promise<ResolvedChatTarget | null> {
		const autoChoice = "Auto-detect after you send /start or a short message to the bot";
		const manualChoice = "Enter chat id manually";
		const retryChoice = "Retry auto-detect";
		const cancelChoice = "Cancel setup";
		let mode = await ctx.ui.select("How should pi find the Telegram chat?", [autoChoice, manualChoice]);
		let nextOffset = startOffset;
		while (mode) {
			if (mode === autoChoice || mode === retryChoice) {
				const attempt = await this.captureChatFromMessage(ctx, api, botId, nextOffset);
				nextOffset = attempt.nextOffset;
				if (attempt.captured) {
					const captured = attempt.captured;
					const allowedUserIds = await this.collectAllowedUserIds(ctx, captured.chat, captured.senderId);
					if (!allowedUserIds) return null;
					return {
						chat: captured.chat,
						chatId: captured.chatId,
						allowedUserIds,
						nextOffset: captured.nextOffset,
						discoveryMode: "auto",
						detectedSenderId: captured.senderId,
					};
				}
				mode = await ctx.ui.select("Telegram chat discovery did not complete.", [retryChoice, manualChoice, cancelChoice]);
				if (!mode || mode === cancelChoice) return null;
				continue;
			}
			if (mode === manualChoice) {
				return this.captureChatManually(ctx, api, botId, nextOffset);
			}
			return null;
		}
		return null;
	}

	private async captureChatFromMessage(
		ctx: ExtensionCommandContext,
		api: TelegramApi,
		botId: number,
		startOffset: number | undefined,
	): Promise<ChatCaptureAttempt> {
		let nextOffset = startOffset;
		let warnedTransientFailure = false;
		const deadline = Date.now() + CHAT_DISCOVERY_TIMEOUT_MS;
		this.relay.setWorkingMessage("Waiting for a Telegram message from the selected chat...");
		try {
			while (Date.now() < deadline) {
				const remainingMs = Math.max(1_000, deadline - Date.now());
				const timeoutSeconds = Math.max(1, Math.min(CHAT_DISCOVERY_POLL_SECONDS, Math.floor(remainingMs / 1000)));
				let updates;
				try {
					updates = await api.getUpdates(nextOffset, timeoutSeconds);
					if (warnedTransientFailure) {
						this.relay.setWorkingMessage("Waiting for a Telegram message from the selected chat...");
						warnedTransientFailure = false;
					}
				} catch (error) {
					if (this.relay.isTransientDiscoveryError(error)) {
						report("connect.capture_chat.transient_failure", { error: error instanceof Error ? error.message : String(error) });
						if (!warnedTransientFailure) {
							this.relay.setWorkingMessage("Telegram polling hiccuped. Still waiting for your message...");
							warnedTransientFailure = true;
						}
						await sleep(1_000);
						continue;
					}
					report("connect.capture_chat.failure", { error: error instanceof Error ? error.message : String(error) });
					ctx.ui.notify("Telegram chat discovery failed. You can retry or switch to manual chat id entry.", "error");
					return { captured: null, nextOffset };
				}
				for (const update of updates) {
					nextOffset = update.update_id + 1;
					const message = update.message;
					if (!message?.chat?.id || !message.from?.id || message.from.is_bot) continue;
					try {
						const chat = await this.validateChatForRelay(api, message.chat.id, botId);
						return {
							captured: { chat, chatId: chat.id, senderId: message.from.id, nextOffset },
							nextOffset,
						};
					} catch (error) {
						report("connect.capture_chat.validate_failure", {
							chatId: message.chat.id,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}
			}
			return { captured: null, nextOffset };
		} finally {
			this.relay.setWorkingMessage();
		}
	}

	private async captureChatManually(
		ctx: ExtensionCommandContext,
		api: TelegramApi,
		botId: number,
		nextOffset: number | undefined,
	): Promise<ResolvedChatTarget | null> {
		const chatIdInput = await ctx.ui.input(
			"Chat id (message @userinfobot to find it)",
			"-1001234567890",
		);
		if (!chatIdInput) return null;
		const chatId = Number(chatIdInput.trim());
		if (!Number.isFinite(chatId)) {
			ctx.ui.notify("Chat id must be numeric.", "error");
			return null;
		}
		let chat: TelegramChat;
		try {
			chat = await this.validateChatForRelay(api, chatId, botId);
		} catch (error) {
			report("connect.validate_chat.failure", { chatId, error: error instanceof Error ? error.message : String(error) });
			ctx.ui.notify("Could not validate chat id.", "error");
			return null;
		}
		const allowedUserIds = await this.collectAllowedUserIds(ctx, chat);
		if (!allowedUserIds) return null;
		return { chat, chatId: chat.id, allowedUserIds, nextOffset, discoveryMode: "manual" };
	}

	private async validateChatForRelay(api: TelegramApi, chatId: number, botId: number): Promise<TelegramChat> {
		const chat = await api.getChat(chatId);
		await api.getChatMember(chatId, botId);
		return chat;
	}

	private async collectAllowedUserIds(
		ctx: ExtensionCommandContext,
		chat: TelegramChat,
		detectedSenderId?: number,
	): Promise<number[] | null> {
		if (chat.type === "private") {
			return [detectedSenderId ?? chat.id];
		}
		const defaultCsv = detectedSenderId ? String(detectedSenderId) : "123456789,987654321";
		const prompt = detectedSenderId
			? `Allowed user ids, comma-separated (detected sender: ${detectedSenderId}; others can message @userinfobot)`
			: "Allowed user ids, comma-separated (message @userinfobot to find them)";
		const allowedIdsCsv = await ctx.ui.input(prompt, defaultCsv);
		if (!allowedIdsCsv) return null;
		const allowedUserIds = parseAllowedUserIds(allowedIdsCsv);
		if (allowedUserIds.length === 0) {
			ctx.ui.notify("Allowed user ids must contain at least one numeric id.", "error");
			return null;
		}
		return allowedUserIds;
	}
}

function parseAllowedUserIds(csv: string): number[] {
	const ids = csv
		.split(",")
		.map((v) => v.trim())
		.filter(Boolean)
		.map((v) => Number(v))
		.filter((v) => Number.isFinite(v));
	return [...new Set(ids)];
}
