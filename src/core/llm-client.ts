// 環境変数の取得（URL末尾の /chat/completions は fetch 側で付与する方が汎用的）
// envStr/envNum を使うのは、.env に `KEY=` と書いた行が空文字で渡ってくるため。
// 詳しくは utils/env.ts を参照。
import { envNum, envStr } from "./utils/env";

const LLM_BASE_URL = envStr("LLM_API_BASE", "http://localhost:1234/v1");
const LLM_API_KEY = envStr("LLM_API_KEY", "not-needed");
const LLM_MODEL = envStr("LLM_MODEL_NAME", "local-model");

const EMBED_BASE_URL = envStr("EMBED_API_BASE", "http://localhost:1234/v1");
const EMBED_MODEL = envStr("EMBED_MODEL_NAME", "local-model");

export interface LLMOutput {
	content: string;
}

let taskQueue: Promise<any> = Promise.resolve();

/**
 * 大脳（LLM）通信
 */
export const llm = {
	async complete(prompt: string): Promise<string> {
		const res = await this.ask(prompt);
		return res.content.trim();
	},

	async completeAsJson<T = object>(
		prompt: string,
	): Promise<{ data: T | null; error: string | null }> {
		const res = await this.ask(prompt);
		return repairAndParseJSON<T>(res.content);
	},

	/**
	 * 内部でキューイングを行い、リクエストを1つずつ処理する
	 */
	async ask(prompt: string): Promise<LLMOutput> {
		// 新しいタスクをキューに追加
		const result = new Promise<LLMOutput>((resolve, reject) => {
			taskQueue = taskQueue
				.then(async () => {
					try {
						const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
							method: "POST",
							headers: {
								"Content-Type": "application/json",
								Authorization: `Bearer ${LLM_API_KEY}`,
							},
							body: JSON.stringify({
								model: LLM_MODEL,
								messages: [{ role: "user", content: prompt }],
								temperature: 0,
							}),
						});

						if (!response.ok) {
							const errorText = await response.text();
							throw new Error(`LLM API Error (${response.status}): ${errorText}`);
						}

						const json = await response.json();
						const message = json.choices?.[0]?.message ?? {};
						// 推論型のモデルは思考を reasoning_content に出し、上限に
						// 当たると content が空のまま返ってくる。空を掴んで
						// 「Empty LLM output」で落ちるより、思考の中身から拾って
						// 先へ進める方がよい。モデルを差し替えたときに黙って
						// 壊れないための保険。
						const content: string = message.content || message.reasoning_content || "";

						// ローカルLLMへの負荷軽減のため、少しだけ待機（冷却期間）
						await new Promise((r) => setTimeout(r, 200));

						resolve({ content });
					} catch (err) {
						reject(err);
					}
				})
				.catch((err) => {
					// 前のタスクがエラーになってもキューを止めないための処理
					console.error("[Queue] Task failed in queue:", err);
				});
		});

		return result;
	},
};

/**
 * 記憶・検索用（Embedding）
 */
export const embedding = {
	async create(text: string): Promise<number[]> {
		const response = await fetch(`${EMBED_BASE_URL}/embeddings`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${LLM_API_KEY}`,
			},
			body: JSON.stringify({
				model: EMBED_MODEL,
				input: text,
			}),
		});

		if (!response.ok) {
			throw new Error(`Embedding API Error: ${response.statusText}`);
		}

		const json = await response.json();
		return json.data[0].embedding;
	},
};

/**
 * 8Bモデルが混ぜたノイズ（Markdownや解説文）からJSONを救出する
 */
export function repairAndParseJSON<T>(badJson: string): { data: T | null; error: string | null } {
	// 1. Markdownのコードブロック(```json ... ```)を剥がす
	const cleaned = badJson.replace(/```json|```/g, "").trim();

	try {
		// 2. そのままパース
		return { data: JSON.parse(cleaned) as T, error: null };
	} catch {
		// 3. ブラケットを探して抽出（それでもダメな場合）
		const start = cleaned.indexOf("{");
		const end = cleaned.lastIndexOf("}");

		if (start !== -1 && end !== -1 && end > start) {
			const candidate = cleaned.slice(start, end + 1);
			try {
				return { data: JSON.parse(candidate) as T, error: null };
			} catch {
				return { data: null, error: `Invalid JSON structure: ${candidate}` };
			}
		}
		return { data: null, error: "No JSON object found in response" };
	}
}

/**
 * 会話専用の設定。未指定なら思考用（LLM_*）と同じものを使う。
 *
 * 行動決定と会話は求められるものが違う。前者は指示に従って形式通りに
 * 出力する力、後者は文脈を追って自然な日本語を返す力で、得意なモデルが
 * 一致しない。実際 devstral はコード向けのモデルで、会話は不得手。
 * 別のエンドポイント・別のモデルに向けられるようにしておく。
 */
const CHAT_BASE_URL = envStr("CHAT_API_BASE", LLM_BASE_URL);
const CHAT_API_KEY = envStr("CHAT_API_KEY", LLM_API_KEY);
const CHAT_MODEL = envStr("CHAT_MODEL_NAME", LLM_MODEL);
/** 会話は temperature 0 だと同じ返事を繰り返す。既定を少し上げる。 */
const CHAT_TEMPERATURE = envNum("CHAT_TEMPERATURE", 0.7);
/** 返事が返らないまま詰まるのを防ぐ。黙るより諦める方がよい。 */
const CHAT_TIMEOUT_MS = envNum("CHAT_TIMEOUT_MS", 45_000);

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

/**
 * 推論型モデルが混ぜる思考の痕跡を落とす。
 *
 * <think> の中身をそのまま喋らせると、独り言が全部ゲーム内に流れる。
 * 閉じタグが無いまま切れることもあるので、その場合は開始タグ以降を捨てる。
 */
function stripReasoning(text: string): string {
	let out = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
	const open = out.search(/<think>/i);
	if (open !== -1) out = out.slice(0, open);
	return out.replace(/<\/?think>/gi, "").trim();
}

/** 会話は思考の後ろに並ばせない。返事が30秒待たされると会話にならない。 */
let chatQueue: Promise<any> = Promise.resolve();

/**
 * 会話用のLLM通信。思考用と違い、複数ターンの messages をそのまま渡す。
 *
 * 会話履歴を1つの文字列に畳んで user 1発で投げると、モデルは自分の
 * 過去の発言を「自分が言ったこと」として扱えず、同じ返事を繰り返す。
 */
export const chatLlm = {
	/** 実際に使うモデル名。起動ログで確認できるように公開する。 */
	modelName: CHAT_MODEL,
	endpoint: CHAT_BASE_URL,

	async talk(
		messages: ChatMessage[],
		/** model はモデルを比べるとき用。本番は env の CHAT_MODEL_NAME を使う。 */
		opts?: { temperature?: number; maxTokens?: number; model?: string },
	) {
		const result = new Promise<string>((resolve, reject) => {
			chatQueue = chatQueue
				.then(async () => {
					const controller = new AbortController();
					const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
					try {
						const response = await fetch(`${CHAT_BASE_URL}/chat/completions`, {
							method: "POST",
							headers: {
								"Content-Type": "application/json",
								Authorization: `Bearer ${CHAT_API_KEY}`,
							},
							body: JSON.stringify({
								model: opts?.model ?? CHAT_MODEL,
								messages,
								temperature: opts?.temperature ?? CHAT_TEMPERATURE,
								max_tokens: opts?.maxTokens ?? 300,
							}),
							signal: controller.signal,
						});

						if (!response.ok) {
							const errorText = await response.text();
							throw new Error(`Chat LLM Error (${response.status}): ${errorText}`);
						}

						const json = await response.json();
						const message = json.choices?.[0]?.message ?? {};
						const raw: string = message.content || message.reasoning_content || "";
						resolve(stripReasoning(raw));
					} catch (err) {
						reject(err);
					} finally {
						clearTimeout(timer);
					}
				})
				.catch((err) => {
					console.error("[ChatQueue] Task failed in queue:", err);
				});
		});

		return result;
	},
};
