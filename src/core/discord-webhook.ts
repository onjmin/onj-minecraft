const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL ?? "";

interface WebhookPayload {
	content: string;
	username?: string;
	avatar_url?: string;
}

/**
 * Discord Webhook を送信する
 * 引数が文字列の場合はそのまま content とし、
 * オブジェクトの場合は詳細なパラメータを設定する。
 */
export async function emitDiscordWebhook(payload: WebhookPayload): Promise<void> {
	if (!DISCORD_WEBHOOK_URL) return;
	payload.content = await translateText(payload.content);

	try {
		await fetch(DISCORD_WEBHOOK_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
	} catch (e) {
		console.error("[DiscordLog] Failed to send:", e);
	}
}

// 翻訳関数
async function translateText(text: string) {
	try {
		const response = await fetch("http://localhost:5000/translate", {
			method: "POST",
			body: JSON.stringify({
				q: text,
				source: "en",
				target: "ja",
				format: "text",
			}),
			headers: { "Content-Type": "application/json" },
		});

		const data = await response.json();
		return data.translatedText;
	} catch (error) {
		console.error("Translation Error:", error);
		return text; // 失敗時は原文を返す
	}
}
