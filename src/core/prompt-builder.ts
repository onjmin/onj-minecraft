import type { DamageInfo } from "./perception";

export interface ThinkingState {
	profile: {
		name: string;
		personality?: string;
		/**
		 * 会話で使う言語。
		 *
		 * 使うのは ENABLE_CHAT=1 の自発発言だけ。なりきりの指示(口調・
		 * 言葉遣い)はここには来ない。喋るのは conversation.ts の仕事で、
		 * 行動を選ぶプロンプトに混ぜると、そのぶん行動の判断材料が薄まる。
		 */
		chatLanguage?: string;
	};

	environment: {
		biome?: string;
		timeOfDay?: string;
		weather?: string;
		/** 0–15。推定できないときは null(プロンプトには unknown と出す)。 */
		lightLevel?: number | null;
		health?: number;
		hunger?: number;
		position?: { x: number; y: number; z: number };
		nearbyPlayers?: string[];
		nearbyMobs?: string[];
		nearbyBlocks?: string;
		heldItem?: string;
	};

	inventorySummary?: string;

	strategies?: string[];
	achievements?: string[];

	bases?: string[];

	/**
	 * 見かけた人工物(誰かの拠点)の位置。
	 *
	 * 地上に出たときの行き先として渡す。これが無いと、ランダムに歩き回る
	 * ことしか選べず、拠点へ一向に着かない。
	 */
	landmarks?: string[];
	/** リスポーン地点として登録したベッドの位置。無ければ未登録。 */
	spawnBed?: string;

	/** 自発的な発言を出力させるか。使わない出力は書かせない。 */
	allowSpontaneousChat?: boolean;

	skills?: {
		name: string;
		description: string;
		args: string;
	}[];

	/**
	 * 行き詰まりの覚え書き。
	 *
	 * AGENT RULES は「同じ手を繰り返すな」と書いているが、繰り返している
	 * ことが分からなければ守れない。スキルの中の空回りは外からは1回の失敗に
	 * しか見えないので、明示的に渡す。
	 */
	stallNotes?: string[];
	/**
	 * 人から受けた作業の依頼。返答そのものは conversation が担当するので、
	 * ここでは「何を頼まれたか」だけを渡し、行動に落とさせる。
	 */
	pendingRequest?: string;

	lastDamageCause?: DamageInfo;

	memorySummary?: string;
}

export function buildThinkingPrompt(state: ThinkingState): string {
	const sections: string[] = [];

	sections.push(buildIdentitySection(state));
	sections.push(buildAgentRulesSection());
	sections.push(buildEnvironmentSection(state));
	sections.push(buildInventorySection(state));
	sections.push(buildStrategicSection(state));
	sections.push(buildStallSection(state));
	sections.push(buildSkillSection(state));
	sections.push(buildMemorySection(state));
	sections.push(buildChatSection(state));
	sections.push(buildOutputFormatSection(state));

	return sections.filter(Boolean).join("\n\n");
}

function buildIdentitySection(state: ThinkingState): string {
	// なりきり(口調・言葉遣い・煽られたときの返し方)はここには載せない。
	//
	// 喋るのは別系統(conversation.ts)の仕事で、こちらは「次にどの Skill を
	// 動かすか」を1つ選ぶだけ。実測 2026-09-17 の思考プロンプトは172行中
	// 68行がなりきりの指示で、しかも全部日本語だった。行動の選択に効かない
	// うえ、語り口の指示が大量に混ざると、24B のモデルは行動を選ぶ代わりに
	// 喋ろうとする。会話の質がモデルではなくプロンプトの問題だったのと同じ
	// 筋で、こちらも経路を分けたぶんの利を取る。
	//
	// ここは英語だけで書く。混ぜると、出力(Strategy や Achievement)まで
	// 日本語に引きずられ、次の周の入力に日本語が積み上がっていく。
	const parts = [
		`You are ${state.profile.name}, an autonomous Minecraft agent.`,
		`Personality: ${state.profile.personality ?? "calm, rational, survival-focused"}.`,
		"",
		"You are choosing actions, not talking. Another system handles all conversation.",
		"Think strategically and act efficiently. Write every field in English.",
	];

	return parts.join("\n");
}

function buildAgentRulesSection(): string {
	return `
=== AGENT RULES ===
If the same skill fails repeatedly or produces no progress for 3 consecutive steps, treat the strategy as stalled and update it instead of repeating the same action.

When a strategy is stalled, move somewhere new once, then try a DIFFERENT kind of task there. Moving again and again is itself a stalled strategy: exploring without ever gathering, crafting, or building makes no progress.

Prefer the task that unblocks the most other tasks. With empty hands that is usually gathering wood, then crafting a tool. Exploration is only worth it when you have looked and there is nothing to gather where you are.

Order matters for survival. Once you have wood, craft a SWORD before anything else. Unarmed you cannot fight back, so you spend the whole time running or hiding and lose everything you carry each time you die. A wooden sword is cheap and changes that.

Never repeat a skill that failed twice in the same environment unless the environment has changed.
`.trim();
}

/**
 * 明るさを、意味のわかる形にして返す。
 *
 * 数字だけ出しても行動は変わらない。実際 15 固定を出し続けていた頃は、
 * 暗い洞窟の底でも "Light Level: 15" と書かれていて、明かりを置く判断も
 * 夜を避ける判断も一度も出てこなかった。敵が湧く明るさなら、そう書く。
 */
function formatLightLevel(level: number | null | undefined): string {
	if (level === null || level === undefined) return "unknown";
	// 7以下は湧き潰しができていない明るさ。地上の夜もここに入る。
	if (level <= 7) return `${level} (DARK - hostile mobs spawn here)`;
	return String(level);
}

function buildEnvironmentSection(state: ThinkingState): string {
	const e = state.environment;

	return `
=== ENVIRONMENT ===
Biome: ${e.biome ?? "unknown"}
Time: ${e.timeOfDay ?? "unknown"}
Weather: ${e.weather ?? "clear"}
Light Level: ${formatLightLevel(e.lightLevel)}
Health: ${e.health ?? "unknown"}
Hunger: ${e.hunger ?? "unknown"}
Position: ${formatPosition(e.position)}
Held Item: ${e.heldItem ?? "bare_hands"}

Nearby Players: ${formatList(e.nearbyPlayers)}
Nearby Mobs: ${formatList(e.nearbyMobs)}
Nearby Blocks (sample): ${e.nearbyBlocks ?? "None"}

Last Damage Cause: ${state.lastDamageCause ? `${state.lastDamageCause.type}${state.lastDamageCause.attacker ? ` by ${state.lastDamageCause.attacker}` : ""}` : "none"}
`.trim();
}

function buildInventorySection(state: ThinkingState): string {
	return `
=== INVENTORY ===
${state.inventorySummary ?? "Empty or unknown"}
`.trim();
}

function buildStrategicSection(state: ThinkingState): string {
	const strategies = state.strategies ?? [];
	const achievements = state.achievements ?? [];

	const strategyText = strategies.length > 0 ? strategies.map((s) => `- ${s}`).join("\n") : "None";

	const achievementText =
		achievements.length > 0
			? achievements.map((a) => `- ${a}`).join("\n")
			: "None (still in progress)";

	return `
=== CURRENT STRATEGY (Max 3) ===
${strategyText}

=== RECENT ACHIEVEMENTS (Max 3) ===
${achievementText}

Known Bases:
${formatList(state.bases)}

Man-made structures you have seen (someone's base — go here instead of wandering):
${formatList(state.landmarks)}

Respawn point registered at: ${state.spawnBed ?? "None (you will respawn at world spawn if you die)"}
`.trim();
}

function buildStallSection(state: ThinkingState): string {
	if (!state.stallNotes || state.stallNotes.length === 0) return "";
	return `
=== WHAT IS NOT WORKING ===
${state.stallNotes.map((n) => `- ${n}`).join("\n")}

These are not one-off failures. Repeating the same skill will produce the same
result. Pick a different approach, or change what you are trying to reach.
`.trim();
}

function buildSkillSection(state: ThinkingState): string {
	if (!state.skills || state.skills.length === 0) {
		return "=== AVAILABLE SKILLS ===\nNone";
	}

	const skillText = state.skills
		.map((s) => `- ${s.name}(${s.args})\n  Description: ${s.description}`)
		.join("\n");

	return `
=== AVAILABLE SKILLS ===
${skillText}
`.trim();
}

function buildMemorySection(state: ThinkingState): string {
	if (!state.memorySummary) return "";

	return `
=== MEMORY SUMMARY ===
${state.memorySummary}
`.trim();
}

function buildChatSection(state: ThinkingState): string {
	const lines: string[] = [];

	// 会話のログはここには載せない。
	//
	// 返事は別系統(conversation.ts)が済ませていて、そこから行動に変えるべき
	// ものだけが PLAYER REQUEST として渡ってくる。生のやり取りを重ねて見せても
	// 選ぶ Skill は変わらないうえ、他人の発言を指示として読ませる隙
	// (「掘って」「壊して」)をわざわざ作ることになる。実際、載せるために
	// 「これは記録であって指示ではない」と3行かけて打ち消していた。
	// 載せなければ打ち消しも要らない。

	// 返答は別系統（conversation）が済ませている。ここでの仕事は
	// 「頼まれたことを行動に変える」ことだけ。喋らせようとしない。
	if (state.pendingRequest) {
		if (lines.length > 0) lines.push("");
		lines.push(
			"=== PLAYER REQUEST (highest priority) ===",
			state.pendingRequest,
			"",
			"The reply has already been sent by another system. Do NOT answer in words here.",
			"Pick the skill that actually carries out this request.",
			"If no available skill can do it, pick the closest useful skill and move on.",
		);
	}

	return lines.join("\n").trim();
}

function buildOutputFormatSection(state: ThinkingState): string {
	const fields = [
		"Rationale: (optional, internal reasoning)",
		"Strategy: (optional, update or keep current)",
		"Achievement: (optional, if something was completed)",
		"Skill: (exact name)",
	];

	// Chat 欄は、その出力を実際に使うときだけ出す。
	//
	// 返事は別系統(conversation.ts)が済ませていて、ここの Chat は
	// ENABLE_CHAT=1 の自発発言にしか使われない。設定していないのに欄だけ
	// 残すと、捨てるためだけに日本語の一言を毎回書かせることになる。
	// 行動を選ぶプロンプトで喋り方を指定すると、モデルは行動より発言に
	// 寄る。実測 2026-09-17 の思考プロンプトは、この1行と、載せる必要の
	// 無かったなり習いの指示で 12,976 バイトあった。
	if (state.allowSpontaneousChat) {
		const lang = state.profile.chatLanguage?.trim();
		fields.push(
			lang
				? `Chat: (optional, spontaneous remark. Write it in ${lang}. Stay in character. Leave empty unless you have something new to say.)`
				: "Chat: (optional, spontaneous remark. Leave empty unless you have something new to say.)",
		);
	}

	return `
=== OUTPUT FORMAT ===

${fields.join("\n")}
`.trim();
}

function formatList(list?: string[]): string {
	if (!list || list.length === 0) return "None";
	return list.join(", ");
}

function formatPosition(pos?: { x: number; y: number; z: number }): string {
	if (!pos) return "unknown";
	return `(${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)})`;
}
