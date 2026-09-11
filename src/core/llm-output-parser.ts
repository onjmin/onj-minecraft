export function parseSections(rawContent: string) {
	// 見出しのリスト（必要ならここに新しいセクション名を追加）
	const headers = ["Rationale", "Chat", "Skill", "Strategy", "Achievement"];

	const headerPattern = headers.join("|");

	// ^...: で行頭からキャプチャ、次の見出し行または文末までを非貪欲に取得。
	//
	// 終端に `$` をそのまま置かないこと。`m` を付けているので `$` は行末に
	// 当たる。非貪欲の `[\s\S]*?` と組み合わさると最初の改行で先読みが成立して
	// 打ち切られ、どのセクションも1行目しか取れない。ローカルモデルは
	// Strategy を複数行の箇条書きで返すので、2行目以降が丸ごと落ちていた
	// (Rationale や Chat も同じく1行目だけになる)。
	// 文末は「$ に当たり、かつ後ろに何も無い」で表す。
	const pattern = new RegExp(
		`^(${headerPattern}):[ \\t]*([\\s\\S]*?)(?=^(?:${headerPattern}):|$(?![\\s\\S]))`,
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

	// 「skillName(a: 1, b: 2)」の関数呼び出し形。ローカルモデルが最もよく出す形で、
	// カンマで頭と尾に割ると最初の引数が head 側に埋もれて丸ごと落ちる。
	// 括弧の中身をまとめて引数として扱う。
	const callForm = line.match(/^([a-zA-Z0-9._-]+)\s*\(([\s\S]*)\)\s*$/);

	// 「skillName, json...」のパターンを検出
	const firstComma = line.indexOf(",");
	const head = firstComma === -1 ? line : line.slice(0, firstComma).trim();
	const tail = callForm
		? callForm[2].trim()
		: firstComma === -1
			? ""
			: line.slice(firstComma + 1).trim();

	const skillNameMatch = (callForm ? callForm[1] : head).match(/^([a-zA-Z0-9._-]+)/);
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

	// キー名が付いていれば位置引数は見ない。両方あるときは名前付きの方が確実。
	const positional = tail && Object.keys(args).length === 0 ? parsePositionalArgs(tail) : [];

	return { name, args, positional };
}

/** "-926" → -926、"true" → true。それ以外は文字列のまま。 */
function coerceValue(rawVal: string): unknown {
	// 負数と小数も数値として扱う。座標は普通に負になるので、
	// ここで弾くと文字列のまま渡って検証に落ちる。
	if (/^[+-]?\d+(?:\.\d+)?$/.test(rawVal)) return Number(rawVal);
	if (/^(true|false)$/i.test(rawVal)) return rawVal.toLowerCase() === "true";
	return rawVal;
}

/**
 * キー名の無い引数を並び順のまま取り出す。
 *
 * `goto.coords(586, 0, -923)` のように位置引数だけで書かれることがある。
 * 対応するキー名はスキルの inputSchema にしかないので、ここでは値の並びだけを
 * 返し、名前の割り当ては呼び出し側(agent)に任せる。
 */
function parsePositionalArgs(argStr: string): unknown[] {
	return argStr
		.split(",")
		.map((part) =>
			part
				.trim()
				.replace(/^[("']+|[)"']+$/g, "")
				.trim(),
		)
		.filter((part) => part.length > 0 && !/[:=]/.test(part))
		.map(coerceValue);
}

function parseKeyValueArgs(argStr: string) {
	const parsed: Record<string, any> = {};
	// key: "value" か key: 'value' か key: value のいずれかにマッチ
	// 括弧やカンマは値に含めない。含めると "-926)" のような値ができ、
	// 数値判定にも Number() にも通らないまま座標として使われる。
	const kvRegex = /(\w+)\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^\s,()]+))/g;
	let m: RegExpExecArray | null;

	while (true) {
		m = kvRegex.exec(argStr);
		if (m === null) break;

		const key = m[1];
		const rawVal = m[2] ?? m[3] ?? m[4] ?? "";

		parsed[key] = coerceValue(rawVal);
	}
	return parsed;
}

export interface ParsedThought {
	speak?: string;
	action?: {
		name: string;
		args?: Record<string, any>;
		/**
		 * キー名の無い引数を並び順のまま渡す。スキルの inputSchema と
		 * 突き合わせて名前を付けるのは agent の仕事。
		 */
		positional?: unknown[];
	};
	/**
	 * Strategy セクションの中身を行ごとに分けたもの。箇条書きの記号は外してある。
	 *
	 * memory に混ぜた文字列から取り出し直さないこと。ローカルモデルは
	 * Strategy を複数行の箇条書きで返すので、`Strategy: <本文> | Achievement: ...`
	 * のように1本の文字列へ畳むと、読む側は改行をまたげる正規表現を書くしかなく
	 * なる。実際そうなっていて、`/Strategy:\s*(.+?)(?:\||$)/` が1行目だけを
	 * 拾い、しかも先頭の "- " ごと保存していた。表示側も "- " を足すので
	 * 「- - 安全な場所へ移動する」になり、似た言い換えが3枠を埋めて二度と
	 * 更新されない状態が続いていた。
	 */
	strategy?: string[];
	/** Achievement セクションの中身。扱いは strategy と同じ。 */
	achievement?: string[];
	memory?: string;
}

/**
 * 箇条書きを行の配列にする。
 *
 * "- ", "* ", "・", "1. " のような記号を落とす。落とさないと、表示側が
 * 付け直す記号と二重になる。空行と記号だけの行は捨てる。
 */
export function splitListLines(section: string): string[] {
	if (!section) return [];
	return section
		.split(/\r?\n/)
		.map((line) =>
			line
				.trim()
				.replace(/^(?:[-*+・‣▪]|\d+[.)])\s*/, "")
				.trim(),
		)
		.filter((line) => line.length > 0);
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
	const { name, args, positional } = parseSkillField(sections.skill);
	if (name) {
		result.action = {
			name,
			args,
			positional,
		};
	}

	// ④ Strategy / Achievement は行ごとに分けて渡す。
	//
	// memory は「何を考えたか」を1本の文字列で見せるための控えとして残す
	// (rationale の表示に使われている)。判断に使う側は strategy /
	// achievement を見ること。畳んだ文字列から取り出し直すと、改行と
	// 区切り文字の両方に振り回される。
	const strategy = splitListLines(sections.strategy);
	const achievement = splitListLines(sections.achievement);
	if (strategy.length > 0) result.strategy = strategy;
	if (achievement.length > 0) result.achievement = achievement;

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
