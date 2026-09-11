import type { DamageInfo } from "./perception";

export interface ThinkingState {
	profile: {
		name: string;
		personality?: string;
		/** なりきりの指示。会話の口調はこれで決まる。 */
		roleplay?: string;
		/** 会話で使う言語。未指定なら言語を指定しない。 */
		chatLanguage?: string;
	};

	environment: {
		biome?: string;
		timeOfDay?: string;
		weather?: string;
		lightLevel?: number;
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

	skills?: {
		name: string;
		description: string;
		args: string;
	}[];

	chatHistory?: string[];
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
	sections.push(buildSkillSection(state));
	sections.push(buildMemorySection(state));
	sections.push(buildChatSection(state));
	sections.push(buildOutputFormatSection(state));

	return sections.filter(Boolean).join("\n\n");
}

function buildIdentitySection(state: ThinkingState): string {
	const roleplay = state.profile.roleplay?.trim();

	const parts = [
		`You are ${state.profile.name}, an autonomous Minecraft agent.`,
		`Personality: ${state.profile.personality ?? "calm, rational, survival-focused"}.`,
	];

	// なりきりの指示は会話の口調を決めるので、思考プロンプトにも載せる
	if (roleplay) {
		parts.push("", "=== PERSONA (how you speak) ===", roleplay);
	}

	parts.push("", "Think strategically and act efficiently.");

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

function buildEnvironmentSection(state: ThinkingState): string {
	const e = state.environment;

	return `
=== ENVIRONMENT ===
Biome: ${e.biome ?? "unknown"}
Time: ${e.timeOfDay ?? "unknown"}
Weather: ${e.weather ?? "clear"}
Light Level: ${e.lightLevel ?? "unknown"}
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

	if (state.chatHistory && state.chatHistory.length > 0) {
		lines.push("=== RECENT CHAT ===", state.chatHistory.join("\n"));
	}

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
	// Chat だけは人間に読ませるものなので言語を指定できるようにする。
	// Rationale などは内部用なので英語のままでよい。
	const lang = state.profile.chatLanguage?.trim();
	// 話しかけへの返答は conversation が担当するため、ここの Chat は
	// 自発的な発言（ENABLE_CHAT=1 のとき）にしか使われない。
	const chatLine = lang
		? `Chat: (optional, spontaneous remark. Write it in ${lang}. Stay in character. Leave empty unless you have something new to say.)`
		: "Chat: (optional, spontaneous remark. Leave empty unless you have something new to say.)";

	return `
=== OUTPUT FORMAT ===

Rationale: (optional, internal reasoning)
Strategy: (optional, update or keep current)
Achievement: (optional, if something was completed)
Skill: (exact name)
${chatLine}
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
