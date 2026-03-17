import type {
	TelegramApiErrorData,
	TelegramChat,
	TelegramChatMember,
	TelegramMessage,
	TelegramUpdate,
	TelegramUser,
} from "./types.ts";
import { TelegramApiError } from "./types.ts";

const TELEGRAM_API_BASE = "https://api.telegram.org";

interface TelegramEnvelope<T> {
	ok: boolean;
	result?: T;
	description?: string;
	error_code?: number;
}

function classifyTelegramError(operation: string, status: number | undefined, description: string | undefined): TelegramApiErrorData {
	const lower = (description ?? "").toLowerCase();
	if (status === 401 || lower.includes("unauthorized") || lower.includes("token")) {
		return { failureClass: "auth", connectionAffecting: true, operation, status, description };
	}
	if (status === 408) {
		return { failureClass: "timeout", connectionAffecting: true, operation, status, description };
	}
	if (status === 409 || lower.includes("terminated by other getupdates request")) {
		return { failureClass: "transport", connectionAffecting: true, operation, status, description };
	}
	if (status === 429 || (status !== undefined && status >= 500)) {
		return { failureClass: "transport", connectionAffecting: true, operation, status, description };
	}
	if (lower.includes("network") || lower.includes("fetch")) {
		return { failureClass: "network", connectionAffecting: true, operation, status, description };
	}
	if (
		lower.includes("message is not modified") ||
		lower.includes("message can't be edited") ||
		lower.includes("message cant be edited") ||
		lower.includes("message to edit not found") ||
		lower.includes("bad request")
	) {
		return { failureClass: "message", connectionAffecting: false, operation, status, description };
	}
	return { failureClass: "unknown", connectionAffecting: status !== undefined && status >= 400 && status < 500 ? false : true, operation, status, description };
}

async function parseEnvelope<T>(response: Response, operation: string): Promise<T> {
	let payload: TelegramEnvelope<T> | undefined;
	try {
		payload = (await response.json()) as TelegramEnvelope<T>;
	} catch {
		throw new TelegramApiError(`${operation} failed with a non-JSON response`, {
			failureClass: "transport",
			connectionAffecting: true,
			operation,
			status: response.status,
			description: response.statusText,
		});
	}
	if (!response.ok || !payload.ok || payload.result === undefined) {
		const errorData = classifyTelegramError(operation, payload.error_code ?? response.status, payload.description ?? response.statusText);
		throw new TelegramApiError(payload.description ?? `${operation} failed`, errorData);
	}
	return payload.result;
}

async function telegramRequest<T>(token: string, method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
	const operation = method;
	const url = `${TELEGRAM_API_BASE}/bot${token}/${method}`;
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal,
		});
		return await parseEnvelope<T>(response, operation);
	} catch (error) {
		if (error instanceof TelegramApiError) throw error;
		if (error instanceof Error && error.name === "AbortError") throw error;
		throw new TelegramApiError(error instanceof Error ? error.message : String(error), {
			failureClass: "network",
			connectionAffecting: true,
			operation,
		});
	}
}

export class TelegramApi {
	constructor(private readonly token: string) {}

	async getMe(signal?: AbortSignal): Promise<TelegramUser> {
		return telegramRequest<TelegramUser>(this.token, "getMe", {}, signal);
	}

	async getChat(chatId: number, signal?: AbortSignal): Promise<TelegramChat> {
		return telegramRequest<TelegramChat>(this.token, "getChat", { chat_id: chatId }, signal);
	}

	async getChatMember(chatId: number, userId: number, signal?: AbortSignal): Promise<TelegramChatMember> {
		return telegramRequest<TelegramChatMember>(this.token, "getChatMember", { chat_id: chatId, user_id: userId }, signal);
	}

	async getUpdates(offset: number | undefined, timeoutSeconds: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
		return telegramRequest<TelegramUpdate[]>(
			this.token,
			"getUpdates",
			{
				offset,
				timeout: timeoutSeconds,
				allowed_updates: ["message", "edited_message"],
			},
			signal,
		);
	}

	async sendMessage(chatId: number, text: string, signal?: AbortSignal): Promise<TelegramMessage> {
		return telegramRequest<TelegramMessage>(
			this.token,
			"sendMessage",
			{
				chat_id: chatId,
				text,
				disable_web_page_preview: true,
			},
			signal,
		);
	}

	async editMessageText(chatId: number, messageId: number, text: string, signal?: AbortSignal): Promise<TelegramMessage> {
		return telegramRequest<TelegramMessage>(
			this.token,
			"editMessageText",
			{
				chat_id: chatId,
				message_id: messageId,
				text,
				disable_web_page_preview: true,
			},
			signal,
		);
	}

	async deleteMessage(chatId: number, messageId: number, signal?: AbortSignal): Promise<boolean> {
		return telegramRequest<boolean>(
			this.token,
			"deleteMessage",
			{
				chat_id: chatId,
				message_id: messageId,
			},
			signal,
		);
	}
}
