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

	skills?: {
		name: string;
		description: string;
		args: string;
	}[];

	chatHistory?: string[];
	/** 直近に他プレイヤーから話しかけられているか。返答を優先させる判断に使う。 */
	awaitingReply?: boolean;

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

When a strategy is stalled, prioritize movement or exploration skills to change the environment (e.g., explore_land, goto.player, goto.surface, explore_underground) before attempting the same resource task again.

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
	if (!state.chatHistory || state.chatHistory.length === 0) return "";

	const lines = ["=== RECENT CHAT ===", state.chatHistory.join("\n")];

	// これは本来「次に何をするか」を決めるためのプロンプトなので、
	// 明示しないと話しかけられていても行動計画を喋り続けてしまう。
	if (state.awaitingReply) {
		lines.push(
			"",
			"A player is talking to YOU right now.",
			"Answer them directly in the Chat field. Reply to what they actually said.",
			"Do NOT narrate your current task instead of replying.",
			"If they asked for something you cannot do, say so plainly.",
		);
	}

	return lines.join("\n").trim();
}

function buildOutputFormatSection(state: ThinkingState): string {
	// Chat だけは人間に読ませるものなので言語を指定できるようにする。
	// Rationale などは内部用なので英語のままでよい。
	const lang = state.profile.chatLanguage?.trim();
	const chatLine = lang
		? `Chat: (optional, message to send. Write it in ${lang}. Stay in character.)`
		: "Chat: (optional, message to send)";

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
