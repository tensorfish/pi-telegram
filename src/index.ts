import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	appendFailureLog,
	createRetryLogPath,
	deleteRelayConfig,
	readRelayConfig,
	writeRelayConfig,
} from "./config.ts";
import { extractAssistantText, renderFinal, renderProgress, splitFinalText, summarizeToolAction, summarizeToolResult } from "./render.ts";
import { TelegramApi } from "./telegram-api.ts";
import type { ActiveRunState, FailureLogEntry, QueuedTelegramInput, RelayConfig, RelayStatusReport, TelegramChat } from "./types.ts";
import { TelegramApiError } from "./types.ts";

const STATUS_KEY = "pi-telegram";
const CONNECTED_WINDOW_MS = 60_000;
const RETRY_INTERVAL_MS = 5_000;
const TEST_TIMEOUT_MS = 60_000;
const CHAT_DISCOVERY_TIMEOUT_MS = 60_000;
const CHAT_DISCOVERY_POLL_SECONDS = 10;
const POLL_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

type AssistantPhase = "waiting" | "llm" | "toolExecution" | "turnBoundary" | "ending";

type LocalContext = ExtensionContext | ExtensionCommandContext;

interface PendingTest {
	code: string;
	messageId: number;
	expiresAt: number;
}

interface RemoteCommandResult {
	handled: boolean;
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

class TelegramRelayController {
	private config: RelayConfig | null = null;
	private api: TelegramApi | null = null;
	private lastContext: LocalContext | null = null;
	private lastApiSuccessAt: number | null = null;
	private pollLoopActive = false;
	private pollLoopGeneration = 0;
	private currentOffset: number | undefined;
	private retryActive = false;
	private retryAttempt = 0;
	private retryLogPath: string | null = null;
	private run: ActiveRunState | null = null;
	private nextRunId = 1;
	private nextAcceptanceSeq = 1;
	private queuedTelegramInputs: QueuedTelegramInput[] = [];
	private queuedTelegramIndex = new Map<number, QueuedTelegramInput>();
	private assistantPhase: AssistantPhase = "waiting";
	private pendingTest: PendingTest | null = null;
	private healthTimer: ReturnType<typeof setInterval> | null = null;
	private pollAbortController: AbortController | null = null;
	private pollLoopPromise: Promise<void> | null = null;
	private pollRequestInFlight = false;
	private pollSpinnerIndex = 0;

	constructor(private readonly pi: ExtensionAPI) {}

	register(): void {
		this.registerCommands();

		this.pi.on("session_start", async (_event, ctx) => {
			this.rememberContext(ctx);
			await this.loadConfig();
			this.ensureHealthTimer();
			await this.ensureDesiredConnection();
			await this.sendStartupConnectedMessageIfNeeded();
			this.refreshFooter();
			report("session_start", { configPresent: Boolean(this.config), enabled: this.config?.enabled ?? false });
		});

		this.pi.on("session_switch", async (_event, ctx) => {
			this.rememberContext(ctx);
			this.refreshFooter();
		});

		this.pi.on("session_shutdown", async (_event, ctx) => {
			this.rememberContext(ctx);
			await this.stopPolling();
			this.clearHealthTimer();
			this.refreshFooter();
		});

		this.pi.on("input", async (event, ctx) => {
			this.rememberContext(ctx);
			if (event.source === "interactive" || event.source === "rpc") {
				report("input.accepted", {
					source: event.source,
					busy: !ctx.isIdle(),
					text: event.text,
				});
			}
			return { action: "continue" as const };
		});

		this.pi.on("agent_start", async (_event, ctx) => {
			this.rememberContext(ctx);
			this.run = {
				id: this.nextRunId++,
				startedAt: Date.now(),
				turnIndex: 1,
				actions: [],
			};
			this.assistantPhase = "llm";
			report("run.start", { runId: this.run.id });
			await this.ensureProgressMessage();
			await this.updateProgressMessage();
		});

		this.pi.on("turn_start", async (event, ctx) => {
			this.rememberContext(ctx);
			if (this.run) this.run.turnIndex = event.turnIndex + 1;
			this.assistantPhase = "llm";
			await this.updateProgressMessage();
		});

		this.pi.on("tool_execution_start", async (event, ctx) => {
			this.rememberContext(ctx);
			this.assistantPhase = "toolExecution";
			if (this.run) {
				this.run.actions.push({ id: event.toolCallId, label: summarizeToolAction(event.toolName, event.args), status: "running" });
			}
			await this.updateProgressMessage();
		});

		this.pi.on("tool_execution_end", async (event, ctx) => {
			this.rememberContext(ctx);
			this.assistantPhase = "toolExecution";
			if (this.run) {
				const existing = this.run.actions.find((action) => action.id === event.toolCallId);
				if (existing) {
					existing.status = event.isError ? "error" : "done";
				} else {
					this.run.actions.push({
						id: event.toolCallId,
						label: summarizeToolResult(event.toolName, null, event.result, event.isError),
						status: event.isError ? "error" : "done",
					});
				}
			}
			await this.updateProgressMessage();
		});

		this.pi.on("message_end", async (event, ctx) => {
			this.rememberContext(ctx);
			if (!this.run) return;
			const message = event.message as { role?: unknown };
			if (message.role === "assistant") {
				const extracted = extractAssistantText(event.message);
				if (extracted.text.trim().length > 0) this.run.lastAssistantText = extracted.text;
				this.run.lastAssistantError = extracted.error;
			}
		});

		this.pi.on("turn_end", async (_event, ctx) => {
			this.rememberContext(ctx);
			this.assistantPhase = "turnBoundary";
			await this.flushOneQueuedTelegramInput();
			await this.updateProgressMessage();
		});

		this.pi.on("agent_end", async (event, ctx) => {
			this.rememberContext(ctx);
			this.assistantPhase = "ending";
			if (this.run) {
				const lastAssistant = [...event.messages].reverse().find((message) => (message as { role?: unknown }).role === "assistant");
				if (lastAssistant) {
					const extracted = extractAssistantText(lastAssistant);
					if (extracted.text.trim().length > 0) this.run.lastAssistantText = extracted.text;
					this.run.lastAssistantError = extracted.error;
				}
				await this.finalizeRun();
			}
			this.run = null;
			this.assistantPhase = "waiting";
			await this.dispatchQueuedTelegramInputIfIdle();
		});
	}

	private registerCommands(): void {
		this.pi.registerCommand("telegram", {
			description: "Manage the Telegram relay",
			handler: async (args, ctx) => {
				this.rememberContext(ctx);
				await this.handleTelegramCommand(args, ctx);
			},
		});
	}

	private rememberContext(ctx: LocalContext): void {
		this.lastContext = ctx;
	}

	private setWorkingMessage(message?: string): void {
		if (!this.lastContext?.hasUI) return;
		this.lastContext.ui.setWorkingMessage(message);
	}

	private ensureHealthTimer(): void {
		if (this.healthTimer) return;
		this.healthTimer = setInterval(() => {
			void this.expirePendingTestIfNeeded();
			if (this.pollRequestInFlight && !this.isConnected()) this.pollSpinnerIndex = (this.pollSpinnerIndex + 1) % POLL_SPINNER_FRAMES.length;
			this.refreshFooter();
		}, 150);
	}

	private clearHealthTimer(): void {
		if (!this.healthTimer) return;
		clearInterval(this.healthTimer);
		this.healthTimer = null;
	}

	private async loadConfig(): Promise<void> {
		this.config = await readRelayConfig();
		if (!this.config) {
			this.api = null;
			return;
		}
		this.api = new TelegramApi(this.config.botToken);
	}

	private async saveConfig(config: RelayConfig): Promise<void> {
		await this.stopPolling();
		this.config = config;
		this.api = new TelegramApi(config.botToken);
		await writeRelayConfig(config);
	}

	private async ensureDesiredConnection(): Promise<void> {
		if (!this.config?.enabled || !this.api) {
			await this.stopPolling();
			return;
		}
		await this.startPolling();
	}

	private async sendStartupConnectedMessageIfNeeded(): Promise<void> {
		if (!this.config?.enabled || !this.api || !this.config.lastValidatedAt) return;
		await this.telegramSend("Telegram relay connected.");
	}

	private async startPolling(): Promise<void> {
		if (this.pollLoopActive || !this.config?.enabled || !this.api) return;
		const generation = ++this.pollLoopGeneration;
		this.pollLoopActive = true;
		const loopPromise = this.pollLoop(generation).finally(() => {
			if (this.pollLoopPromise === loopPromise) this.pollLoopPromise = null;
		});
		this.pollLoopPromise = loopPromise;
		void loopPromise;
	}

	private async stopPolling(): Promise<void> {
		this.pollLoopGeneration++;
		this.pollLoopActive = false;
		this.pollRequestInFlight = false;
		this.pollSpinnerIndex = 0;
		this.pollAbortController?.abort();
		const loopPromise = this.pollLoopPromise;
		if (loopPromise) {
			try {
				await loopPromise;
			} catch {
				// poll loop errors are already handled internally
			}
		}
	}

	private async pollLoop(generation: number): Promise<void> {
		while (generation === this.pollLoopGeneration && this.config?.enabled && this.api) {
			const abortController = new AbortController();
			this.pollAbortController = abortController;
			this.pollRequestInFlight = true;
			this.refreshFooter();
			try {
				const updates = await this.api.getUpdates(this.currentOffset, 50, abortController.signal);
				if (generation !== this.pollLoopGeneration || !this.config?.enabled) break;
				this.recordApiSuccess();
				for (const update of updates) {
					this.currentOffset = update.update_id + 1;
					await this.handleTelegramUpdate(update);
				}
			} catch (error) {
				if (this.isAbortError(error) && generation !== this.pollLoopGeneration) break;
				await this.handleApiFailure(error, "getUpdates");
				if (generation !== this.pollLoopGeneration || !this.config?.enabled) break;
				await sleep(RETRY_INTERVAL_MS);
			} finally {
				this.pollRequestInFlight = false;
				this.pollSpinnerIndex = 0;
				if (this.pollAbortController === abortController) this.pollAbortController = null;
				this.refreshFooter();
			}
		}
		if (generation === this.pollLoopGeneration) this.pollLoopActive = false;
		this.refreshFooter();
	}

	private isConnected(): boolean {
		if (!this.config?.enabled || !this.pollLoopActive || !this.lastApiSuccessAt) return false;
		return Date.now() - this.lastApiSuccessAt <= CONNECTED_WINDOW_MS;
	}

	private refreshFooter(): void {
		if (!this.lastContext?.hasUI) return;
		let text = this.isConnected() ? "Telegram Connected" : "Telegram Disconnected";
		if (!this.isConnected() && this.pollRequestInFlight) {
			text = `${POLL_SPINNER_FRAMES[this.pollSpinnerIndex]} Telegram Connecting`;
		} else if (!this.isConnected() && this.retryActive) {
			text = `Telegram Disconnected · retrying in ${Math.floor(RETRY_INTERVAL_MS / 1000)}s`;
		}
		this.lastContext.ui.setStatus(STATUS_KEY, text);
	}

	private isAbortError(error: unknown): boolean {
		return error instanceof Error && error.name === "AbortError";
	}

	private isTransientChatDiscoveryError(error: unknown): boolean {
		if (this.isAbortError(error)) return true;
		if (!(error instanceof TelegramApiError)) return false;
		if (error.operation !== "getUpdates") return false;
		if (error.status === 409) return true;
		return error.failureClass === "network" || error.failureClass === "timeout" || error.failureClass === "transport";
	}

	private async handleApiFailure(error: unknown, operation: string): Promise<void> {
		const normalized = error instanceof TelegramApiError ? error : new TelegramApiError(error instanceof Error ? error.message : String(error), {
			failureClass: "unknown",
			connectionAffecting: true,
			operation,
		});
		if (!normalized.connectionAffecting) {
			report("api.failure.non_health", {
				operation,
				failureClass: normalized.failureClass,
				message: normalized.message,
			});
			return;
		}
		this.retryActive = true;
		this.retryAttempt += 1;
		if (!this.retryLogPath) this.retryLogPath = createRetryLogPath();
		const entry: FailureLogEntry = {
			timestamp: new Date().toISOString(),
			operation,
			attempt: this.retryAttempt,
			error_type: normalized.failureClass,
			error_message: normalized.message,
		};
		await appendFailureLog(this.retryLogPath, entry);
		report("api.failure", {
			operation,
			failureClass: normalized.failureClass,
			attempt: this.retryAttempt,
			logPath: this.retryLogPath,
		});
		this.refreshFooter();
	}

	private recordApiSuccess(): void {
		this.lastApiSuccessAt = Date.now();
		this.retryActive = false;
		this.retryAttempt = 0;
		this.retryLogPath = null;
		this.refreshFooter();
	}

	private async telegramSend(text: string): Promise<number | undefined> {
		if (!this.config || !this.api) return undefined;
		try {
			const message = await this.api.sendMessage(this.config.chatId, text);
			this.recordApiSuccess();
			return message.message_id;
		} catch (error) {
			await this.handleApiFailure(error, "sendMessage");
			return undefined;
		}
	}

	private async telegramEdit(messageId: number, text: string): Promise<boolean> {
		if (!this.config || !this.api) return false;
		try {
			await this.api.editMessageText(this.config.chatId, messageId, text);
			this.recordApiSuccess();
			return true;
		} catch (error) {
			await this.handleApiFailure(error, "editMessageText");
			return false;
		}
	}

	private buildStatusReport(): RelayStatusReport {
		return {
			connection: this.isConnected() ? "connected" : "disconnected",
			enabled: this.config?.enabled ?? false,
			bot_username: this.config?.botUsername ?? "none",
			bot_id: this.config?.botId ?? "none",
			chat_id: this.config?.chatId ?? "none",
			allowed_user_ids: this.config ? this.config.allowedUserIds.join(",") : "none",
			queue_length: this.queuedTelegramInputs.length,
			active_progress_message_id: this.run?.progressMessageId ?? "none",
			last_api_success_at: this.lastApiSuccessAt ? new Date(this.lastApiSuccessAt).toISOString() : "none",
			retry_state: this.retryActive ? "active" : "inactive",
			failure_log_path: this.retryLogPath ?? "none",
		};
	}

	private buildStatusText(): string {
		const reportData = this.buildStatusReport();
		return [
			`connection: ${reportData.connection}`,
			`enabled: ${String(reportData.enabled)}`,
			`bot_username: ${String(reportData.bot_username)}`,
			`bot_id: ${String(reportData.bot_id)}`,
			`chat_id: ${String(reportData.chat_id)}`,
			`allowed_user_ids: ${String(reportData.allowed_user_ids)}`,
			`queue_length: ${String(reportData.queue_length)}`,
			`active_progress_message_id: ${String(reportData.active_progress_message_id)}`,
			`last_api_success_at: ${String(reportData.last_api_success_at)}`,
			`retry_state: ${reportData.retry_state}`,
			`failure_log_path: ${String(reportData.failure_log_path)}`,
		].join("\n");
	}

	private buildCommandHelpText(): string {
		const connection = this.isConnected() ? "connected" : this.pollRequestInFlight ? "connecting" : "disconnected";
		const enabled = this.config?.enabled ? "on" : "off";
		const chat = this.config?.chatId ?? "not configured";
		const allowedUsers = this.config ? this.config.allowedUserIds.join(", ") || "none" : "not configured";
		return [
			"Telegram relay",
			`Status: ${connection} (${enabled})`,
			`Chat: ${String(chat)}`,
			`Allowed users: ${allowedUsers}`,
			"",
			"Commands:",
			"/telegram connect — guided setup",
			"/telegram status — raw deterministic state report",
			"/telegram test — verify outbound and inbound relay",
			"/telegram toggle — enable or disable the relay",
			"/telegram logout — remove saved credentials",
		].join("\n");
	}

	private async handleTelegramCommand(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
		const [command = ""] = rawArgs.trim().split(/\s+/).filter(Boolean);
		switch (command) {
			case "":
				ctx.ui.notify(this.buildCommandHelpText(), "info");
				return;
			case "status": {
				const statusText = this.buildStatusText();
				report("status", this.buildStatusReport());
				ctx.ui.notify(statusText, "info");
				return;
			}
			case "connect": {
				await this.runConnectFlow(ctx);
				return;
			}
			case "toggle": {
				await this.toggleRelay(ctx);
				return;
			}
			case "logout": {
				await this.logoutRelay(ctx);
				return;
			}
			case "test": {
				await this.runRelayTest(ctx);
				return;
			}
			default:
				ctx.ui.notify(this.buildCommandHelpText(), "warning");
		}
	}

	private async runConnectFlow(ctx: ExtensionCommandContext): Promise<void> {
		const resumePreviousRelay = Boolean(this.config?.enabled && this.api);
		let saved = false;
		await this.stopPolling();
		try {
			const botToken = await ctx.ui.input(
				"Telegram bot token (get it from @BotFather; if needed message @BotFather and send /newbot)",
				"123456789:ABCdef...",
			);
			if (!botToken) return;
			const token = botToken.trim();
			const probeApi = new TelegramApi(token);
			let me;
			this.setWorkingMessage("Validating Telegram bot token...");
			try {
				me = await probeApi.getMe();
			} catch (error) {
				report("connect.validate_bot.failure", { error: error instanceof Error ? error.message : String(error) });
				ctx.ui.notify("Could not validate bot token from @BotFather.", "error");
				return;
			} finally {
				this.setWorkingMessage();
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
			this.recordApiSuccess();
			this.currentOffset = resolved.nextOffset;
			saved = true;
			await this.ensureDesiredConnection();
			this.refreshFooter();
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
			this.setWorkingMessage();
			if (!saved && resumePreviousRelay) await this.ensureDesiredConnection();
			this.refreshFooter();
		}
	}

	private async captureSetupOffset(api: TelegramApi): Promise<number | undefined> {
		if (this.currentOffset !== undefined) return this.currentOffset;
		try {
			const updates = await api.getUpdates(undefined, 0);
			if (updates.length === 0) return undefined;
			return updates[updates.length - 1]!.update_id + 1;
		} catch (error) {
			report("connect.capture_offset.failure", { error: error instanceof Error ? error.message : String(error) });
			return this.currentOffset;
		}
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
				const manual = await this.captureChatManually(ctx, api, botId, nextOffset);
				if (!manual) return null;
				return manual;
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
		this.setWorkingMessage("Waiting for a Telegram message from the selected chat...");
		try {
			while (Date.now() < deadline) {
				const remainingMs = Math.max(1_000, deadline - Date.now());
				const timeoutSeconds = Math.max(1, Math.min(CHAT_DISCOVERY_POLL_SECONDS, Math.floor(remainingMs / 1000)));
				let updates;
				try {
					updates = await api.getUpdates(nextOffset, timeoutSeconds);
					if (warnedTransientFailure) {
						this.setWorkingMessage("Waiting for a Telegram message from the selected chat...");
						warnedTransientFailure = false;
					}
				} catch (error) {
					if (this.isTransientChatDiscoveryError(error)) {
						report("connect.capture_chat.transient_failure", { error: error instanceof Error ? error.message : String(error) });
						if (!warnedTransientFailure) {
							this.setWorkingMessage("Telegram polling hiccuped. Still waiting for your message...");
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
							captured: {
								chat,
								chatId: chat.id,
								senderId: message.from.id,
								nextOffset,
							},
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
			this.setWorkingMessage();
		}
	}

	private async captureChatManually(
		ctx: ExtensionCommandContext,
		api: TelegramApi,
		botId: number,
		nextOffset: number | undefined,
	): Promise<ResolvedChatTarget | null> {
		const chatIdInput = await ctx.ui.input(
			"Telegram chat id (rerun connect and choose auto-detect if you do not know it; otherwise get it from Bot API getUpdates after messaging the bot, or from a trusted chat-id helper bot)",
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
		return {
			chat,
			chatId: chat.id,
			allowedUserIds,
			nextOffset,
			discoveryMode: "manual",
		};
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
			const privateUserId = detectedSenderId ?? chat.id;
			return [privateUserId];
		}
		const defaultCsv = detectedSenderId ? String(detectedSenderId) : "123456789,987654321";
		const prompt = detectedSenderId
			? `Allowed Telegram user ids CSV (group chat; the sender who just messaged the bot was ${detectedSenderId}; if needed ask users to message the bot once so they appear in Bot API getUpdates, or use a trusted user-id helper bot)`
			: "Allowed Telegram user ids CSV (group chat; ask users to message the bot once so they appear in Bot API getUpdates, or use a trusted user-id helper bot)";
		const allowedIdsCsv = await ctx.ui.input(prompt, defaultCsv);
		if (!allowedIdsCsv) return null;
		const allowedUserIds = parseAllowedUserIds(allowedIdsCsv);
		if (allowedUserIds.length === 0) {
			ctx.ui.notify("Allowed user ids must contain at least one numeric id.", "error");
			return null;
		}
		return allowedUserIds;
	}

	private async toggleRelay(ctx: ExtensionCommandContext): Promise<void> {
		if (!this.config) {
			ctx.ui.notify("No relay config found. Use /telegram connect.", "warning");
			return;
		}
		const nextConfig = { ...this.config, enabled: !this.config.enabled };
		await this.saveConfig(nextConfig);
		if (nextConfig.enabled) {
			await this.ensureDesiredConnection();
			ctx.ui.notify("Telegram relay enabled.", "info");
		} else {
			await this.stopPolling();
			ctx.ui.notify("Telegram relay disabled.", "info");
		}
		this.refreshFooter();
		report("toggle", { enabled: nextConfig.enabled });
	}

	private async logoutRelay(ctx: ExtensionCommandContext): Promise<void> {
		const confirmed = await ctx.ui.confirm("Logout Telegram relay?", "This removes saved credentials and disconnects the relay.");
		if (!confirmed) return;
		await this.logoutCore();
		ctx.ui.notify("Telegram relay logged out.", "info");
	}

	private async logoutCore(): Promise<void> {
		await this.stopPolling();
		await deleteRelayConfig();
		this.config = null;
		this.api = null;
		this.lastApiSuccessAt = null;
		this.retryActive = false;
		this.retryAttempt = 0;
		this.retryLogPath = null;
		this.pendingTest = null;
		this.refreshFooter();
		report("logout", { preservedAcceptedPrompts: this.queuedTelegramInputs.length });
	}

	private async runRelayTest(ctx: ExtensionCommandContext): Promise<void> {
		if (!this.config || !this.api) {
			ctx.ui.notify("No relay config found. Use /telegram connect.", "warning");
			return;
		}
		const code = String(Math.floor(1000 + Math.random() * 9000));
		const text = `Telegram relay test\n\nReply to this message with: ${code}\nThis check expires in 60 seconds.`;
		this.setWorkingMessage("Sending Telegram test message...");
		try {
			const messageId = await this.telegramSend(text);
			if (!messageId) {
				ctx.ui.notify("Could not send the Telegram test message.", "error");
				return;
			}
			this.pendingTest = { code, messageId, expiresAt: Date.now() + TEST_TIMEOUT_MS };
			report("test.sent", { code, messageId, expiresAt: this.pendingTest.expiresAt });
		} finally {
			this.setWorkingMessage();
		}
	}

	private async handleTelegramUpdate(update: { message?: { message_id: number; text?: string; caption?: string; from?: { id: number; is_bot?: boolean }; chat: { id: number }; reply_to_message?: { message_id: number } }; edited_message?: { message_id: number; text?: string; caption?: string; from?: { id: number; is_bot?: boolean }; chat: { id: number } } }): Promise<void> {
		if (!this.config) return;
		const rawMessage = update.message ?? update.edited_message;
		if (!rawMessage) return;
		const isEdit = Boolean(update.edited_message);
		const senderId = rawMessage.from?.id;
		const chatId = rawMessage.chat.id;
		if (chatId !== this.config.chatId) {
			report("telegram.reject", { reason: "wrong_chat", chatId });
			return;
		}
		if (!senderId || !this.config.allowedUserIds.includes(senderId) || rawMessage.from?.is_bot) {
			report("telegram.reject", { reason: "sender_not_allowed", senderId });
			return;
		}
		if (this.pendingTest && Date.now() <= this.pendingTest.expiresAt && rawMessage.text?.trim() === this.pendingTest.code) {
			await this.completeTestSuccess(senderId);
			return;
		}
		if (isEdit) {
			if (typeof rawMessage.text !== "string") {
				report("telegram.reject", { reason: "caption_or_non_text_edit", messageId: rawMessage.message_id });
				return;
			}
			const queued = this.queuedTelegramIndex.get(rawMessage.message_id);
			if (!queued || queued.dispatched) {
				report("telegram.edit.ignored", { messageId: rawMessage.message_id });
				return;
			}
			queued.text = rawMessage.text;
			report("telegram.queue.updated", { messageId: rawMessage.message_id, seq: queued.seq, text: queued.text });
			return;
		}
		if (typeof rawMessage.text !== "string") {
			report("telegram.reject", { reason: "caption_or_non_text", messageId: rawMessage.message_id });
			return;
		}
		const text = rawMessage.text.trim();
		if (!text) return;
		const remoteHandled = await this.handleRemoteTelegramCommand(text);
		if (remoteHandled.handled) return;
		await this.acceptTelegramPrompt(text, rawMessage.message_id, senderId);
	}

	private async handleRemoteTelegramCommand(text: string): Promise<RemoteCommandResult> {
		if (!text.startsWith("/telegram")) return { handled: false };
		const [, rawSubcommand = "", ...rest] = text.split(/\s+/);
		const subcommand = rawSubcommand.trim();
		switch (subcommand) {
			case "":
				await this.telegramSend(this.buildCommandHelpText());
				return { handled: true };
			case "status":
				await this.telegramSend(this.buildStatusText());
				return { handled: true };
			case "test": {
				if (!this.config) return { handled: true };
				const code = String(Math.floor(1000 + Math.random() * 9000));
				const body = `Telegram relay test\n\nReply to this message with: ${code}\nThis check expires in 60 seconds.`;
				const messageId = await this.telegramSend(body);
				if (messageId) this.pendingTest = { code, messageId, expiresAt: Date.now() + TEST_TIMEOUT_MS };
				return { handled: true };
			}
			case "toggle": {
				if (!this.config) return { handled: true };
				if (this.config.enabled) {
					await this.telegramSend("Telegram relay disabling.");
				}
				const nextConfig = { ...this.config, enabled: !this.config.enabled };
				await this.saveConfig(nextConfig);
				if (nextConfig.enabled) {
					await this.ensureDesiredConnection();
					await this.telegramSend("Telegram relay enabled.");
				} else {
					await this.stopPolling();
				}
				this.refreshFooter();
				return { handled: true };
			}
			case "logout": {
				if (rest[0] !== "yes") {
					await this.telegramSend("Remote logout requires confirmation. Send: /telegram logout yes");
					return { handled: true };
				}
				await this.telegramSend("Telegram relay logging out.");
				await this.logoutCore();
				return { handled: true };
			}
			case "connect":
				await this.telegramSend("Remote connect is not available. Use local /telegram connect.");
				return { handled: true };
			default:
				await this.telegramSend(this.buildCommandHelpText());
				return { handled: true };
		}
	}

	private async completeTestSuccess(senderId: number): Promise<void> {
		if (!this.pendingTest) return;
		await this.telegramEdit(this.pendingTest.messageId, "Telegram relay test\n\nSuccess. Outbound and inbound relay both work.");
		report("test.success", { senderId, messageId: this.pendingTest.messageId });
		this.pendingTest = null;
	}

	private async expirePendingTestIfNeeded(): Promise<void> {
		if (!this.pendingTest) return;
		if (Date.now() < this.pendingTest.expiresAt) return;
		const expired = this.pendingTest;
		this.pendingTest = null;
		await this.telegramEdit(expired.messageId, "Telegram relay test\n\nExpired. No matching reply was received in time.");
		report("test.expired", { messageId: expired.messageId });
	}

	private async acceptTelegramPrompt(text: string, telegramMessageId: number, senderId: number): Promise<void> {
		const seq = this.nextAcceptanceSeq++;
		if (!this.run) {
			try {
				this.pi.sendUserMessage(text);
				report("telegram.dispatch.immediate", { seq, telegramMessageId, senderId, text });
				return;
			} catch (error) {
				report("telegram.dispatch.immediate_failed", {
					seq,
					telegramMessageId,
					senderId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		const item: QueuedTelegramInput = {
			seq,
			telegramMessageId,
			senderId,
			text,
			acceptedAt: Date.now(),
			dispatched: false,
		};
		this.queuedTelegramInputs.push(item);
		this.queuedTelegramInputs.sort((a, b) => a.seq - b.seq);
		this.queuedTelegramIndex.set(telegramMessageId, item);
		report("telegram.queue.accepted", { seq, telegramMessageId, senderId, text, queueLength: this.queuedTelegramInputs.length });
		if (this.assistantPhase === "turnBoundary") {
			await this.flushOneQueuedTelegramInput();
		}
	}

	private async flushOneQueuedTelegramInput(): Promise<void> {
		if (!this.run || this.queuedTelegramInputs.length === 0) return;
		const next = this.queuedTelegramInputs[0];
		if (!next || next.dispatched) return;
		try {
			this.pi.sendUserMessage(next.text, { deliverAs: "followUp" });
			next.dispatched = true;
			this.queuedTelegramInputs.shift();
			this.queuedTelegramIndex.delete(next.telegramMessageId);
			report("telegram.queue.dispatched", { seq: next.seq, telegramMessageId: next.telegramMessageId, mode: "followUp", queueLength: this.queuedTelegramInputs.length });
		} catch (error) {
			report("telegram.queue.dispatch_failed", {
				seq: next.seq,
				telegramMessageId: next.telegramMessageId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async dispatchQueuedTelegramInputIfIdle(): Promise<void> {
		if (this.run || this.queuedTelegramInputs.length === 0) return;
		const next = this.queuedTelegramInputs[0];
		if (!next) return;
		try {
			this.pi.sendUserMessage(next.text);
			this.queuedTelegramInputs.shift();
			this.queuedTelegramIndex.delete(next.telegramMessageId);
			report("telegram.queue.promoted_to_new_run", { seq: next.seq, telegramMessageId: next.telegramMessageId });
		} catch (error) {
			report("telegram.queue.promote_failed", {
				seq: next.seq,
				telegramMessageId: next.telegramMessageId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async ensureProgressMessage(): Promise<void> {
		if (!this.run || this.run.progressMessageId || !this.config?.enabled) return;
		if (!this.isConnected()) return;
		const text = renderProgress(this.run, Date.now());
		const messageId = await this.telegramSend(text);
		if (!messageId) return;
		this.run.progressMessageId = messageId;
		this.run.lastRenderedText = text;
		report("run.progress.created", { runId: this.run.id, messageId });
	}

	private async updateProgressMessage(): Promise<void> {
		if (!this.run || !this.config?.enabled) return;
		await this.ensureProgressMessage();
		if (!this.run.progressMessageId) return;
		const rendered = renderProgress(this.run, Date.now());
		if (rendered === this.run.lastRenderedText) {
			report("run.progress.noop", { runId: this.run.id, messageId: this.run.progressMessageId });
			return;
		}
		const ok = await this.telegramEdit(this.run.progressMessageId, rendered);
		if (ok) {
			this.run.lastRenderedText = rendered;
			report("run.progress.edited", { runId: this.run.id, messageId: this.run.progressMessageId });
		}
	}

	private async finalizeRun(): Promise<void> {
		if (!this.run || !this.config?.enabled) return;
		await this.ensureProgressMessage();
		if (!this.run.progressMessageId) return;
		const finalText = renderFinal(this.run, Date.now());
		const chunks = splitFinalText(finalText);
		const first = chunks[0] ?? finalText;
		const ok = await this.telegramEdit(this.run.progressMessageId, first);
		if (ok) report("run.finalized", { runId: this.run.id, messageId: this.run.progressMessageId, chunks: chunks.length });
		for (let index = 1; index < chunks.length; index += 1) {
			await this.telegramSend(chunks[index]!);
		}
	}
}

function parseAllowedUserIds(csv: string): number[] {
	const ids = csv
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean)
		.map((value) => Number(value))
		.filter((value) => Number.isFinite(value));
	return [...new Set(ids)];
}

function report(kind: string, payload: Record<string, unknown>): void {
	if (process.env.PI_TELEGRAM_DEBUG !== "1") return;
	console.log(`[pi-telegram] ${JSON.stringify({ kind, ...payload })}`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function telegramExtension(pi: ExtensionAPI): void {
	const controller = new TelegramRelayController(pi);
	controller.register();
}
