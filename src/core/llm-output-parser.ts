export function parseSections(rawContent: string) {
	// 見出しのリスト（必要ならここに新しいセクション名を追加）
	const headers = ["Rationale", "Chat", "Skill", "Strategy", "Achievement"];

	const headerPattern = headers.join("|");

	// ^...: で行頭からキャプチャ、次の見出し行または文末までを非貪欲に取得
	const pattern = new RegExp(
		`^(${headerPattern}):\\s*([\\s\\S]*?)(?=^(?:${headerPattern}):|$)`,
		"gim",
	);

	const map: Record<string, string[]> = {};
	for (const h of headers) map[h.toLowerCase()] = [];

	let m: RegExpExecArray | null;

	while (true) {
		m = pattern.exec(rawContent);
		if (m === null) break;

		const key = m[1].toLowerCase();
		const value = (m[2] || "").trim();

		if (value) {
			map[key].push(value);
		}
	}

	// map の各値を「複数見つかった場合は改行で結合」して返す（用途に応じて変更可）
	const result: Record<string, string> = {};
	for (const k of Object.keys(map)) {
		result[k] = map[k].join("\n").trim();
	}
	return result;
}

export function cleanChatField(raw: string): string {
	if (!raw) return "";

	// 1行目のみ使う（必要なら複数行許可へ変更）
	let line = raw.split("\n")[0].trim();

	// "Skill:" などキーワード混入があればそこまで切る
	line = line.split(/(?:\bSkill:|\bRationale:|\bStrategy:|\bAchievement:)/i)[0].trim();

	// 括弧始まりは心の声とみなして無視
	if (line.startsWith("(") || line.startsWith("（")) return "";

	// 引用符の除去
	line = line.replace(/^["'「“](.*)["'」”]$/, "$1").trim();

	// none 判定（先頭トークンのみで判定）
	const normalized = line
		.toLowerCase()
		.replace(/[()."']/g, "")
		.split(/[\s—-]/)[0];
	const isNone = ["", "none", "empty", "n/a", "nothing", "silent", "ignored"].includes(normalized);
	if (isNone) return "";

	// 最終トリム（余分な囲み引用符を再度）
	line = line.replace(/^["'“]|["'”]$/g, "").trim();
	return line;
}

/**
 * Skill フィールドのパース:
 * - 期待されるフォーマット例:
 *   Skill: mineSomething
 *   Skill: mineSomething, radius: 3, target: oak_log
 *   Skill: buildShelter, {"size":3, "material":"wood"}
 *
 * 戻り値: { name: string | null, args: Record<string, any> }
 */
export function parseSkillField(rawSkill: string) {
	if (!rawSkill) return { name: null, args: {} };

	// 1行目を取得して処理
	const line = rawSkill.split("\n")[0].trim();

	// 「skillName, json...」のパターンを検出
	const firstComma = line.indexOf(",");
	const head = firstComma === -1 ? line : line.slice(0, firstComma).trim();
	const tail = firstComma === -1 ? "" : line.slice(firstComma + 1).trim();

	const skillNameMatch = head.match(/^([a-zA-Z0-9._-]+)/);
	const name = skillNameMatch ? skillNameMatch[1] : null;
	let args: Record<string, any> = {};

	if (tail) {
		// tail が JSON っぽければ JSON.parse を試す
		const maybeJson = tail.trim();
		if (
			(maybeJson.startsWith("{") && maybeJson.endsWith("}")) ||
			(maybeJson.startsWith("[") && maybeJson.endsWith("]"))
		) {
			try {
				args = JSON.parse(maybeJson);
			} catch {
				// JSON 失敗したらフォールバックして key:value パターンでパース
				args = parseKeyValueArgs(tail);
			}
		} else {
			args = parseKeyValueArgs(tail);
		}
	}

	return { name, args };
}

function parseKeyValueArgs(argStr: string) {
	const parsed: Record<string, any> = {};
	// key: "value" か key: 'value' か key: value のいずれかにマッチ
	const kvRegex = /(\w+)\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^\s,]+))/g;
	let m: RegExpExecArray | null;

	while (true) {
		m = kvRegex.exec(argStr);
		if (m === null) break;

		const key = m[1];
		const rawVal = m[2] ?? m[3] ?? m[4] ?? "";

		let val: unknown = rawVal;

		if (/^\d+$/.test(rawVal)) {
			val = Number(rawVal);
		} else if (/^(true|false)$/i.test(rawVal)) {
			val = rawVal.toLowerCase() === "true";
		}

		parsed[key] = val;
	}
	return parsed;
}

export interface ParsedThought {
	speak?: string;
	action?: {
		name: string;
		args?: Record<string, any>;
	};
	memory?: string;
}

export function parseLlmOutput(rawContent: string): ParsedThought {
	if (!rawContent || rawContent.trim() === "") {
		throw new Error("Empty LLM output");
	}

	// ① セクション分解
	const sections = parseSections(rawContent);

	const result: ParsedThought = {};

	// ② Chat → speak
	const cleanedChat = cleanChatField(sections.chat);
	if (cleanedChat) {
		result.speak = cleanedChat;
	}

	// ③ Skill → action
	const { name, args } = parseSkillField(sections.skill);
	if (name) {
		result.action = {
			name,
			args,
		};
	}

	// ④ Strategy や Achievement を memory として保存
	const memoryChunks: string[] = [];

	if (sections.strategy) {
		memoryChunks.push(`Strategy: ${sections.strategy}`);
	}

	if (sections.achievement) {
		memoryChunks.push(`Achievement: ${sections.achievement}`);
	}

	if (memoryChunks.length > 0) {
		result.memory = memoryChunks.join(" | ");
	}

	return result;
}
