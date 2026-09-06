/**
 * 日本語 Minecraft Wiki (ja.minecraft.wiki) からの知識検索モジュール。
 *
 * レシピ、出現確率、Mobやアイテムの仕様、バイオームなどの質問に対して、
 * 公式MediaWiki APIから情報を取得し、会話プロンプトに提供する。
 *
 * 外部ライブラリを追加せず、標準の fetch だけで動作する。
 */

interface CacheEntry {
	data: string | null;
	expiresAt: number;
}

const CACHE_TTL_MS = 30 * 60_000; // 30分
const CACHE_MAX_SIZE = 50;
const cache = new Map<string, CacheEntry>();

const WIKI_API_BASE = "https://ja.minecraft.wiki/api.php";
const SEARCH_TIMEOUT_MS = 3000; // 会話のテンポを崩さないため3秒上限

/**
 * 発言がMinecraftのゲーム知識・質問に関係しそうか判定するパターン
 */
const QUESTION_PATTERNS = [
	/[?？]/,
	/どうやって|作り方|つくりかた|レシピ|れしぴ|クラフト/,
	/確率|出現|湧く|わく|ドロップ/,
	/どこ|何処|場所|バイオーム/,
	/何|なに|なん|なんの|どんな|どういう/,
	/教えて|おしえて|知ってる|わかる|ある？|いる？|ない？|いない？/,
];

/**
 * Minecraftに関係のない日常会話や自己紹介・状況質問を弾くパターン
 */
const NON_MINECRAFT_PATTERNS = [
	/^(?:こんにちは|こんばんは|おはよう|やあ|やぁ|よろしく|はじめまして)/,
	/(?:天気|調子|気分|眠い|お腹すいた|つかれた)/,
	/(?:だれ|誰|お前|君|あなた|あんた|bot|ボット)(?:は|って|の)?(?:誰|だれ|何者|名前|正体|管理人|製作者|作者)/,
	/何(?:してる|してん|やってる|やってん|持ってる|もってる)/,
	/(?:どこ|何処)(?:いる|いん|におる|にいん)/,
];

/**
 * 検索キーワードから取り除く助詞・ノイズ語
 */
const STOP_WORDS_REGEX =
	/(?:って|という|とは|の|は|を|に|が|で|と|も|へ|から|まで|より|教えて|おしえて|どうやって|作り方|つくりかた|レシピ|れしぴ|確率|出現確率|どこ|場所|何|なに|ある|いる|ない|いない|ください|お願い|おねがい|ですか|ますか|[?？!！。、\s])+/g;

/**
 * プレイヤーの発言からMinecraft Wikiを検索し、要約された知識テキストを返す。
 * 関連する知識が見つからない場合や、質問でない場合は null を返す。
 */
export async function fetchMinecraftKnowledge(message: string): Promise<string | null> {
	const trimmed = message.trim();
	if (!trimmed) return null;

	// 日常会話・自己紹介・現在地確認などMinecraft知識でない質問は弾く
	if (NON_MINECRAFT_PATTERNS.some((p) => p.test(trimmed))) {
		return null;
	}

	// 質問・疑問のニュアンスを含んでいるか確認
	const isQuestion = QUESTION_PATTERNS.some((p) => p.test(trimmed));
	if (!isQuestion) return null;

	// キャッシュ確認
	const cached = cache.get(trimmed);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.data;
	}

	try {
		const result = await searchWiki(trimmed);
		setCache(trimmed, result);
		return result;
	} catch (err) {
		console.warn(`[Wiki] 検索エラー (${trimmed}):`, err);
		return null;
	}
}

function setCache(key: string, data: string | null): void {
	if (cache.size >= CACHE_MAX_SIZE) {
		const oldest = cache.keys().next().value;
		if (oldest) cache.delete(oldest);
	}
	cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * 内部検索ロジック
 */
async function searchWiki(query: string): Promise<string | null> {
	// クエリ候補の作成:
	// 1. ノイズを除いたコア名詞（例: 「ウーパールーパー」「金床」）
	// 2. 「コア名詞 + 観点（確率 / レシピ / 作り方 など）」
	const coreTerms = query
		.split(STOP_WORDS_REGEX)
		.map((t) => t.trim())
		.filter((t) => t.length >= 2);

	const isRecipeQuery = /作り方|レシピ|クラフト|どうやって/.test(query);
	const isRateQuery = /確率|出現|ドロップ|湧き|わき/.test(query);
	const isWhereQuery = /どこ|場所|バイオーム/.test(query);

	// 最も重要そうな名詞（一番長い名詞、または最初の名詞）
	const primaryNoun = [...coreTerms].sort((a, b) => b.length - a.length)[0];
	if (!primaryNoun) return null;

	// 1. タイトルのプレフィックス・完全一致検索 (opensearch)
	const titleCandidate = await findExactTitle(primaryNoun);

	const searchQueries: string[] = [];
	if (titleCandidate) {
		if (isRateQuery) searchQueries.push(`${titleCandidate} 確率`);
		if (isRecipeQuery) searchQueries.push(`${titleCandidate} レシピ`);
		if (isWhereQuery) searchQueries.push(`${titleCandidate} スポーン`);
		searchQueries.push(titleCandidate);
	}

	if (isRateQuery) searchQueries.push(`${primaryNoun} 確率`);
	if (isRecipeQuery) searchQueries.push(`${primaryNoun} 作り方`);
	searchQueries.push(coreTerms.join(" "));

	// 2. クラフトレシピを直接パースできるか試す（レシピの質問かつタイトル特定できている場合）
	let craftingSnippet: string | null = null;
	if (titleCandidate && isRecipeQuery) {
		craftingSnippet = await fetchCraftingRecipe(titleCandidate);
	}

	// 3. 全文検索 (list=search) でスニペットを取得
	let bestSnippets: string[] = [];
	for (const sq of searchQueries) {
		const hits = await executeTextSearch(sq);
		if (hits.length > 0) {
			bestSnippets = hits;
			break;
		}
	}

	// 4. 結果の集約
	const knowledgeParts: string[] = [];

	if (craftingSnippet) {
		knowledgeParts.push(craftingSnippet);
	}

	for (const snip of bestSnippets) {
		if (knowledgeParts.join("\n").length < 250) {
			knowledgeParts.push(snip);
		}
	}

	if (knowledgeParts.length === 0) return null;

	return knowledgeParts.join("\n");
}

/**
 * opensearch を使って Wiki 上の正式な記事タイトルを探す
 */
async function findExactTitle(term: string): Promise<string | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
	try {
		const url = `${WIKI_API_BASE}?action=opensearch&search=${encodeURIComponent(term)}&limit=3&format=json`;
		const res = await fetch(url, {
			headers: { "User-Agent": "onj-minecraft-bot/1.0" },
			signal: controller.signal,
		});
		if (!res.ok) return null;
		const json = (await res.json()) as [string, string[]];
		const titles = json[1];
		if (!titles || titles.length === 0) return null;

		// サブページ (/DV 等) を避けてメインの記事名を優先
		const main = titles.find((t) => !t.includes("/"));
		return main || titles[0] || null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * ページの wikitext から {{Crafting ...}} テンプレートを抜き出して材料をまとめる
 */
async function fetchCraftingRecipe(pageTitle: string): Promise<string | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
	try {
		const url = `${WIKI_API_BASE}?action=parse&page=${encodeURIComponent(pageTitle)}&prop=wikitext&format=json`;
		const res = await fetch(url, {
			headers: { "User-Agent": "onj-minecraft-bot/1.0" },
			signal: controller.signal,
		});
		if (!res.ok) return null;
		const json = (await res.json()) as { parse?: { wikitext?: { "*": string } } };
		const wikitext = json.parse?.wikitext?.["*"] || "";

		const craftMatch = wikitext.match(/\{\{Crafting[\s\S]*?\}\}/i);
		if (!craftMatch) return null;

		const lines = craftMatch[0]
			.split("\n")
			.filter((l) => l.includes("=") && !l.startsWith("{{") && !l.startsWith("}}"));
		const ingMap: Record<string, number> = {};
		for (const l of lines) {
			const [k, v] = l
				.replace(/^\|/, "")
				.split("=")
				.map((s) => s.trim());
			if (v && k !== "type" && k !== "Output" && k !== "ignoreusage") {
				// 複数候補 (例: Oak Planks; Birch Planks) の場合は最初の候補に
				const cleanV = v.split(";")[0].trim();
				ingMap[cleanV] = (ingMap[cleanV] || 0) + 1;
			}
		}

		const ingredients = Object.entries(ingMap)
			.map(([name, count]) => `${name} x${count}`)
			.join(", ");
		if (!ingredients) return null;

		return `【${pageTitle}のレシピ】 材料: ${ingredients}`;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * MediaWiki の検索 API でスニペットを取得する
 */
async function executeTextSearch(query: string): Promise<string[]> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
	try {
		const url = `${WIKI_API_BASE}?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=5&format=json`;
		const res = await fetch(url, {
			headers: { "User-Agent": "onj-minecraft-bot/1.0" },
			signal: controller.signal,
		});
		if (!res.ok) return [];
		const json = (await res.json()) as {
			query?: { search?: Array<{ title: string; snippet: string }> };
		};
		const hits = json.query?.search || [];

		// クエリ内のキーワードと一致度が高いものを優先
		const keywords = query.split(/\s+/).filter((k) => k.length >= 2);
		const scored = hits.map((h) => {
			let score = 0;
			for (const kw of keywords) {
				if (h.title.includes(kw)) score += 5;
				const matches = (h.snippet.match(new RegExp(kw, "gi")) || []).length;
				score += matches;
			}
			return { h, score };
		});
		scored.sort((a, b) => b.score - a.score);

		return scored.map(({ h }) => {
			const clean = h.snippet
				.replace(/<[^>]+>/g, "")
				.replace(/&quot;/g, '"')
				.replace(/&#039;/g, "'")
				.replace(/&amp;/g, "&")
				.replace(/\s+/g, " ")
				.trim();
			return `【${h.title}】 ${clean}`;
		});
	} catch {
		return [];
	} finally {
		clearTimeout(timer);
	}
}
