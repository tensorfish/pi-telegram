export interface RelayConfig {
	version: 1;
	enabled: boolean;
	botToken: string;
	botId: number;
	botUsername: string;
	chatId: number;
	allowedUserIds: number[];
	lastValidatedAt: string;
	[key: string]: unknown;
}

export type ConnectionState = "connected" | "disconnected";

export type FailureClass = "auth" | "network" | "timeout" | "transport" | "message" | "unknown";

export interface TelegramApiErrorData {
	failureClass: FailureClass;
	connectionAffecting: boolean;
	operation: string;
	status?: number;
	description?: string;
}

export class TelegramApiError extends Error {
	readonly failureClass: FailureClass;
	readonly connectionAffecting: boolean;
	readonly operation: string;
	readonly status?: number;
	readonly description?: string;

	constructor(message: string, data: TelegramApiErrorData) {
		super(message);
		this.name = "TelegramApiError";
		this.failureClass = data.failureClass;
		this.connectionAffecting = data.connectionAffecting;
		this.operation = data.operation;
		this.status = data.status;
		this.description = data.description;
	}
}

export interface TelegramUser {
	id: number;
	is_bot?: boolean;
	username?: string;
	first_name?: string;
}

export interface TelegramChat {
	id: number;
	type?: string;
	title?: string;
	username?: string;
}

export interface TelegramChatMember {
	status?: string;
	user?: TelegramUser;
}

export interface TelegramMessage {
	message_id: number;
	date?: number;
	text?: string;
	caption?: string;
	from?: TelegramUser;
	chat: TelegramChat;
	reply_to_message?: TelegramMessage;
	edit_date?: number;
}

export interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	edited_message?: TelegramMessage;
}

export interface QueuedTelegramInput {
	seq: number;
	telegramMessageId: number;
	senderId: number;
	text: string;
	acceptedAt: number;
	dispatched: boolean;
}

export interface FailureLogEntry {
	timestamp: string;
	operation: string;
	attempt: number;
	error_type: string;
	error_message: string;
}

export interface RenderAction {
	id: string;
	label: string;
	status: "running" | "done" | "error";
}

export interface ActiveRunState {
	id: number;
	startedAt: number;
	turnIndex: number;
	progressMessageId?: number;
	lastRenderedText?: string;
	actions: RenderAction[];
	lastAssistantText?: string;
	lastAssistantError?: boolean;
}

export interface RelayStatusReport {
	connection: ConnectionState;
	enabled: boolean;
	bot_username: string | "none";
	bot_id: number | "none";
	chat_id: number | "none";
	allowed_user_ids: string | "none";
	queue_length: number;
	active_progress_message_id: number | "none";
	last_api_success_at: string | "none";
	retry_state: "active" | "inactive";
	failure_log_path: string | "none";
}
