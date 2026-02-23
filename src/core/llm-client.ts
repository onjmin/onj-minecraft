// 環境変数の取得（URL末尾の /chat/completions は fetch 側で付与する方が汎用的）
const LLM_BASE_URL = process.env.LLM_API_BASE ?? "http://localhost:1234/v1";
const LLM_API_KEY = process.env.LLM_API_KEY ?? "not-needed";
const LLM_MODEL = process.env.LLM_MODEL_NAME ?? "local-model";

const EMBED_BASE_URL = process.env.EMBED_API_BASE ?? "http://localhost:1234/v1";
const EMBED_MODEL = process.env.EMBED_MODEL_NAME ?? "local-model";

export interface LLMOutput {
	content: string;
}

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

	async ask(prompt: string): Promise<LLMOutput> {
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
		const content = json.choices[0].message.content || "";
		return { content };
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
