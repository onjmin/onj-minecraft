/**
 * 会話の担当。行動決定とは切り離して、返答だけを専門に作る。
 *
 * これまで返答は思考プロンプト（行動決定）の Chat 欄のおまけだった。
 * そのせいで、
 *   - 返事が最大30秒待たされる（思考ループの周期でしか喋れない）
 *   - スキル一覧と行動規則で埋まったプロンプトの片隅で返事を書くので、
 *     相手の話ではなく自分の作業計画を喋る
 *   - 自分の過去の発言が履歴に入らず、同じ返事を繰り返す
 * という問題が同時に出ていた。会話は会話として、複数ターンの
 * messages を組んで別のモデルに投げる。
 */
import type { AgentProfile } from "../profiles/types";
import { type ChatMessage, chatLlm } from "./llm-client";

/** 返事を書くために渡す「今の状況」。分かる範囲でよい。 */
export interface ChatSituation {
	position?: { x: number; y: number; z: number };
	biome?: string;
	timeOfDay?: string;
	health?: number;
	hunger?: number;
	inventorySummary?: string;
	/** 今実行中のスキル名。「何してるの」に答えるために要る。 */
	currentTask?: string;
	/** 直近の行動と結果。「さっきのどうなった」に答えるために要る。 */
	recentResults?: string[];
	/** できること（スキル名の一覧）。できない依頼を断るために要る。 */
	skillNames?: string[];
	nearbyPlayers?: string[];
}

export interface ChatTurn {
	speaker: string;
	message: string;
	/** 自分の発言か。履歴を assistant として積むために使う。 */
	self: boolean;
	at: number;
}

export interface ChatReply {
	/** ゲーム内で実際に喋る一言。空なら黙る。 */
	reply: string;
	/** 相手から受けた作業依頼。無ければ null。思考ループに渡す。 */
	request: string | null;
}

/** ゲーム内チャットに流していい長さ。長い返事は読まれないし邪魔になる。 */
const MAX_UTTERANCE = Number(process.env.CHAT_MAX_CHARS ?? 160);
/** 保持する会話ターン数（自分の発言も含む）。 */
const MAX_TURNS = Number(process.env.CHAT_HISTORY_TURNS ?? 20);
/** これより古いやり取りは文脈から外す。昨日の話を引きずらせない。 */
const HISTORY_WINDOW_MS = Number(process.env.CHAT_HISTORY_WINDOW_MS ?? 20 * 60_000);

export class Conversation {
	private turns: ChatTurn[] = [];

	/**
	 * modelOverride はモデルを比べるとき用。本番では渡さず、
	 * env の CHAT_MODEL_NAME をそのまま使う。
	 */
	constructor(
		private profile: AgentProfile,
		private modelOverride?: string,
	) {}

	/** 発言を記録する。相手のものも自分のものも、同じ列に時系列で積む。 */
	record(speaker: string, message: string, self: boolean): void {
		const text = message.trim();
		if (!text) return;
		this.turns.push({ speaker, message: text, self, at: Date.now() });
		if (this.turns.length > MAX_TURNS) {
			this.turns.splice(0, this.turns.length - MAX_TURNS);
		}
	}

	/** 思考プロンプトに載せるための行。自分の発言も含めて時系列で返す。 */
	lines(limit = 6): string[] {
		return this.turns.slice(-limit).map((t) => `<${t.speaker}> ${t.message}`);
	}

	/** 最後の相手の発言。返す相手を決めるのに使う。 */
	lastFromOthers(): ChatTurn | null {
		for (let i = this.turns.length - 1; i >= 0; i--) {
			if (!this.turns[i].self) return this.turns[i];
		}
		return null;
	}

	/**
	 * 返事を作る。発言はしない（送るのは呼び出し側の責任）。
	 *
	 * 相手の発言が無いときは何も返さない。話しかけられていないのに
	 * 喋り出すのはここの仕事ではない。
	 */
	async respond(situation: ChatSituation): Promise<ChatReply> {
		const last = this.lastFromOthers();
		if (!last) return { reply: "", request: null };

		const messages: ChatMessage[] = [
			{ role: "system", content: this.buildSystemPrompt(situation) },
			...this.buildHistory(),
		];

		const raw = await chatLlm.talk(normalizeMessages(messages), {
			model: this.modelOverride,
		});
		return parseReply(raw, this.profile.minecraftName);
	}

	private buildSystemPrompt(s: ChatSituation): string {
		const lang = this.profile.chatLanguage?.trim();
		const sections: string[] = [];

		sections.push(
			[
				`あなたは Minecraft の中にいる「${this.profile.minecraftName}」です。`,
				`性格: ${this.profile.personality}`,
			].join("\n"),
		);

		const roleplay = this.profile.roleplayPrompt?.trim();
		if (roleplay) sections.push(`=== 人格・話し方 ===\n${roleplay}`);

		sections.push(`=== 今の状況 ===\n${describeSituation(s)}`);

		sections.push(
			[
				"=== 返事の作り方 ===",
				"- 直前の相手の発言に答えてください。自分の作業計画を一方的に語らないこと。",
				"- 1〜2文、長くても60文字程度。ゲーム内チャットなので長文は読まれません。",
				"- 「今の状況」に書かれていないことを、あるかのように言わないでください。",
				"  座標・持ち物・体力を聞かれたら、上の値をそのまま使うこと。",
				"- できないことを頼まれたら、正直に断ってください。",
				"- 同じ返事を繰り返さないこと。前と同じことを聞かれたら言い方を変えるか、",
				"  「さっきも言ったけど」と前置きしてください。",
				"- 自分の名前を先頭に付けないでください。発言の中身だけを書くこと。",
				"- 顔文字・絵文字・記号の装飾は使わないでください。",
				lang ? `- ${lang}で書いてください。` : "",
				"- 自分に向けられていない雑談なら、黙っていてよいです（Reply を none にする）。",
			]
				.filter(Boolean)
				.join("\n"),
		);

		sections.push(
			[
				"=== 出力形式 ===",
				"次の2行だけを出力してください。説明や前置きは書かないこと。",
				"",
				"Reply: (実際に喋る一言。黙るなら none)",
				"Request: (相手から受けた作業の依頼を一文で要約。依頼でなければ none)",
			].join("\n"),
		);

		return sections.join("\n\n");
	}

	/** 会話履歴を messages に変換する。相手の発言は話者名を添える。 */
	private buildHistory(): ChatMessage[] {
		const cutoff = Date.now() - HISTORY_WINDOW_MS;
		return this.turns
			.filter((t) => t.at >= cutoff)
			.map((t) => ({
				role: t.self ? ("assistant" as const) : ("user" as const),
				content: t.self ? t.message : `<${t.speaker}> ${t.message}`,
			}));
	}
}

/** 状況を人が読める形にまとめる。値が無い項目は載せない（嘘の材料になる）。 */
function describeSituation(s: ChatSituation): string {
	const lines: string[] = [];

	if (s.position) {
		const p = s.position;
		lines.push(`現在地: (${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})`);
	}
	if (s.biome) lines.push(`バイオーム: ${s.biome}`);
	if (s.timeOfDay) lines.push(`時間帯: ${s.timeOfDay}`);
	if (s.health !== undefined) lines.push(`体力: ${s.health}/20`);
	if (s.hunger !== undefined) lines.push(`満腹度: ${s.hunger}/20`);
	lines.push(`持ち物: ${s.inventorySummary || "なし"}`);
	lines.push(`今やっていること: ${s.currentTask || "特になし"}`);

	if (s.recentResults?.length) {
		lines.push(`直近の行動:\n${s.recentResults.map((r) => `  - ${r}`).join("\n")}`);
	}
	if (s.nearbyPlayers?.length) {
		lines.push(`近くにいる人: ${s.nearbyPlayers.join(", ")}`);
	}
	if (s.skillNames?.length) {
		lines.push(`できること: ${s.skillNames.join(", ")}`);
		lines.push("これ以外のことは頼まれてもできません。");
	}

	return lines.join("\n");
}

/**
 * Reply / Request を取り出す。
 *
 * ローカルモデルは見出しを忘れる。その場合は本文全体を返事とみなす。
 * 「見出しが無いから黙る」は、会話としては最悪の壊れ方なので避ける。
 */
export function parseReply(raw: string, selfName: string): ChatReply {
	if (!raw?.trim()) return { reply: "", request: null };

	const replyMatch = raw.match(/^\s*Reply\s*[:：]\s*([\s\S]*?)(?=^\s*Request\s*[:：]|$)/im);
	const requestMatch = raw.match(/^\s*Request\s*[:：]\s*([\s\S]*?)(?=^\s*Reply\s*[:：]|$)/im);

	const replyRaw = replyMatch ? replyMatch[1] : raw;
	const reply = sanitizeUtterance(replyRaw, selfName);

	const requestRaw = requestMatch ? sanitizeUtterance(requestMatch[1], selfName) : "";
	const request = requestRaw && !isNone(requestRaw) ? requestRaw : null;

	return { reply, request };
}

const NONE_WORDS = ["none", "null", "なし", "n/a", "-", "無し", "特になし"];

function isNone(text: string): boolean {
	const normalized = text
		.toLowerCase()
		.replace(/[。．.、,！!？?（）()"'「」]/g, "")
		.trim();
	return normalized === "" || NONE_WORDS.includes(normalized);
}

/**
 * ゲーム内チャットに流せる一言に整える。
 *
 * 改行・見出しの混入・名前の前置き・引用符・長すぎる本文は、どれも
 * そのまま流すと読みにくいか、ボットらしさが出て会話が壊れる。
 */
export function sanitizeUtterance(raw: string, selfName: string): string {
	if (!raw) return "";

	let text = raw.trim();

	// 見出しが本文に紛れ込んだら、そこで切る
	text = text.split(/^\s*(?:Request|Reply|Skill|Rationale)\s*[:：]/im)[0].trim();

	// 複数行は1行に畳む。空行は落とす。
	text = text
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.join(" ");

	// 「kusabot: 」「<kusabot> 」のような名前の前置きを剥がす
	const namePrefix = new RegExp(
		`^[<\\[（(]?\\s*${escapeRegExp(selfName)}\\s*[>\\])）]?\\s*[:：]?\\s*`,
		"i",
	);
	text = text.replace(namePrefix, "").trim();

	// Markdown の強調と囲み引用符
	text = text.replace(/\*\*(.*?)\*\*/g, "$1").replace(/[*_`]/g, "");
	text = text.replace(/^["'“「](.*)["'”」]$/s, "$1").trim();

	if (isNone(text)) return "";

	// 長すぎるものは文の切れ目で落とす。切れ目が無ければそのまま切る。
	if (text.length > MAX_UTTERANCE) {
		const head = text.slice(0, MAX_UTTERANCE);
		const cut = Math.max(head.lastIndexOf("。"), head.lastIndexOf("！"), head.lastIndexOf("？"));
		text = cut > MAX_UTTERANCE / 2 ? head.slice(0, cut + 1) : `${head.trim()}…`;
	}

	return text;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 同じ role が連続する messages を1つに畳む。
 *
 * Gemma のようにテンプレートが user/assistant の交互を要求するモデルがあり、
 * 連続すると 400 で落ちる。話者名は本文側に入れてあるので、畳んでも
 * 誰の発言かは失われない。
 */
export function normalizeMessages(messages: ChatMessage[]): ChatMessage[] {
	const out: ChatMessage[] = [];

	for (const m of messages) {
		if (!m.content.trim()) continue;
		const prev = out[out.length - 1];
		if (prev && prev.role === m.role) {
			prev.content = `${prev.content}\n${m.content}`;
			continue;
		}
		out.push({ ...m });
	}

	// system の直後は user から始める。assistant で始まるとテンプレートが崩れる。
	const firstNonSystem = out.findIndex((m) => m.role !== "system");
	if (firstNonSystem !== -1 && out[firstNonSystem].role === "assistant") {
		out.splice(firstNonSystem, 1);
	}

	return out;
}
