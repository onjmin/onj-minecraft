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
	/**
	 * 掘り荒らされた区域。行き先に選ばせない。
	 *
	 * 初期リスの周りは自分で掘った穴の集まりで、そこの作業台や落とし物を
	 * 目当てに goto.coords を選ぶと穴へ戻る。実測 2026-09-19、goto.coords
	 * が58回、goto.landmark が31回、ほぼ全部その中の残骸に向いていた。
	 */
	hazardZones?: string[];

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
	 * いまの状況を、判断に使える文にしたもの(situation.ts)。
	 *
	 * 地下にいる・危険域の中・生肉はあるがかまどが無い、といった事実。
	 * 以前はこれらをコード側が読んで「surface が担当」「secure_food が担当」
	 * と決めていた。決めるのは LLM で、ここはその材料を渡す。
	 */
	situation?: string[];
	/**
	 * 反射が前の思考以降にしたこと(reflex-log.ts)。
	 *
	 * 反射は LLM を待てない場面のためにあるが、何をしたか・何に失敗したかを
	 * LLM が知らなければ、同じ失敗を横で眺めるだけになる。
	 */
	reflexLog?: string[];
	/**
	 * いま走っている行動と、その経過。
	 *
	 * 以前は「担当してから60秒未満なら乗り換えを却下」というコード側の判断で
	 * 長い行動を守っていた。いまは経過を渡して、続けるか替えるかを LLM が言う。
	 */
	currentAction?: string;
	/** いまの構え(auto / flee / fight)。LLM が Stance 欄で変える。 */
	stance?: "auto" | "flee" | "fight";
	/** 夜の籠り反射を LLM がいま断っているか。Hide 欄の現在値として見せる。 */
	hideDeclined?: boolean;
	/** 夜の籠りを保持中か。この間 Hide: no は無視される。 */
	hideHeld?: boolean;
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
	sections.push(buildSituationSection(state));
	sections.push(buildInventorySection(state));
	sections.push(buildStrategicSection(state));
	sections.push(buildCurrentActionSection(state));
	sections.push(buildReflexSection(state));
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

Exception: when you are starving (hunger 6 or less) and you carry anything edible (cooked or raw — survival.eat eats raw meat too), eat first. Health does not regenerate while starving, so wood and swords come after the meal.

Never repeat a skill that failed twice in the same environment unless the environment has changed.

You have a small set of reflexes that act without you: digging out when boxed in, eating when hungry and safe, joining others in bed, hiding underground at night when unarmed, and a per-tick combat reflex that runs from or fights nearby hostiles. The hiding reflex is the only one that holds you for minutes; you can switch it off with "Hide: no". The combat reflex follows your "Stance". Everything else is YOUR decision: getting back to the surface, securing food, crafting weapons, walking out of hazard zones, recovering dropped items. Nobody will do these for you. Read SITUATION and decide.
`.trim();
}

function buildSituationSection(state: ThinkingState): string {
	if (!state.situation || state.situation.length === 0) return "";
	return `
=== SITUATION (facts derived from the world — act on these) ===
${state.situation.map((n) => `- ${n}`).join("\n")}
`.trim();
}

function buildCurrentActionSection(state: ThinkingState): string {
	if (!state.currentAction) return "";
	return `
=== CURRENT ACTION ===
${state.currentAction}
`.trim();
}

function buildReflexSection(state: ThinkingState): string {
	if (!state.reflexLog || state.reflexLog.length === 0) return "";
	return `
=== WHAT YOUR REFLEXES DID SINCE YOUR LAST THOUGHT ===
${state.reflexLog.map((n) => `- ${n}`).join("\n")}
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

Man-made structures you have seen (use goto.coords to reach one if it is on the surface and outside the hazard zone):
${formatList(state.landmarks)}

Respawn point registered at: ${state.spawnBed ?? "None (you will respawn at world spawn if you die)"}
${
	state.hazardZones && state.hazardZones.length > 0
		? `
DUG-OUT HAZARD ZONES (cratered ground, many vertical shafts — never pick a destination inside one; if you are inside, walk out on the surface and explore elsewhere):
${formatList(state.hazardZones)}
Resources are found by walking the surface horizontally (new terrain, forests, animals, villages), not by digging down. Do not dig downward until you have an iron pickaxe, torches and food.`
		: ""
}
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
Skills marked [PRECONDITION UNMET: ...] will fail right now for the stated reason. They are listed so you know they exist and what would make them possible; pick something else unless you are fixing that precondition.
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
		`Stance: (auto, flee or fight) — how your per-tick combat reflex treats nearby hostiles. auto (default): flee when unarmed, low on health or facing a creeper, otherwise fight. flee: always run, even armed. fight: engage even bare-handed (still flees when health is critical). Current: ${state.stance ?? "auto"}. Omit to keep it.`,
		`Hide: (yes or no) — whether your night reflex may dig you in and hide underground until dawn. At night, "no" is honored only when you carry BOTH a sword and armor; without armor the reflex hides you regardless (walking the surface at night unarmored has killed you every time). Current: ${state.hideHeld ? "yes — HELD: you are hidden for the night; no is ignored until dawn or until you take damage" : state.hideDeclined ? "no" : "yes"}. Say no when you have a better plan for the night (digging up to the surface, staying in a sealed room you already have). Keep answering the same way each thought while the plan stands; flipping between yes and no every thought hands control back and forth and wastes the night.`,
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
