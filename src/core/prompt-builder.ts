export interface ThinkingState {
	profile: {
		name: string;
		personality?: string;
	};

	environment: {
		biome?: string;
		timeOfDay?: string;
		lightLevel?: number;
		health?: number;
		hunger?: number;
		position?: { x: number; y: number; z: number };
		nearbyPlayers?: string[];
		nearbyMobs?: string[];
	};

	inventorySummary?: string;

	strategicState?: string;

	bases?: string[];

	skills?: {
		name: string;
		description: string;
		usage: string;
	}[];

	chatHistory?: string[];

	lastDamageCause?: string;

	memorySummary?: string;
}

export function buildThinkingPrompt(state: ThinkingState): string {
	const sections: string[] = [];

	sections.push(buildIdentitySection(state));
	sections.push(buildEnvironmentSection(state));
	sections.push(buildInventorySection(state));
	sections.push(buildStrategicSection(state));
	sections.push(buildSkillSection(state));
	sections.push(buildMemorySection(state));
	sections.push(buildChatSection(state));
	sections.push(buildOutputFormatSection());

	return sections.filter(Boolean).join("\n\n");
}

function buildIdentitySection(state: ThinkingState): string {
	return `
You are ${state.profile.name}, an autonomous Minecraft agent.
Personality: ${state.profile.personality ?? "calm, rational, survival-focused"}.

Think strategically and act efficiently.
`.trim();
}

function buildEnvironmentSection(state: ThinkingState): string {
	const e = state.environment;

	return `
=== ENVIRONMENT ===
Biome: ${e.biome ?? "unknown"}
Time: ${e.timeOfDay ?? "unknown"}
Light Level: ${e.lightLevel ?? "unknown"}
Health: ${e.health ?? "unknown"}
Hunger: ${e.hunger ?? "unknown"}
Position: ${formatPosition(e.position)}

Nearby Players: ${formatList(e.nearbyPlayers)}
Nearby Mobs: ${formatList(e.nearbyMobs)}

Last Damage Cause: ${state.lastDamageCause ?? "none"}
`.trim();
}

function buildInventorySection(state: ThinkingState): string {
	return `
=== INVENTORY ===
${state.inventorySummary ?? "Empty or unknown"}
`.trim();
}

function buildStrategicSection(state: ThinkingState): string {
	return `
=== STRATEGIC STATE ===
${state.strategicState ?? "No active long-term plan."}

Known Bases:
${formatList(state.bases)}
`.trim();
}

function buildSkillSection(state: ThinkingState): string {
	if (!state.skills || state.skills.length === 0) {
		return "=== AVAILABLE SKILLS ===\nNone";
	}

	const skillText = state.skills
		.map((s) => `- ${s.name}\n  Description: ${s.description}\n  Usage: ${s.usage}`)
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

	return `
=== RECENT CHAT ===
${state.chatHistory.join("\n")}
`.trim();
}

function buildOutputFormatSection(): string {
	return `
=== OUTPUT FORMAT ===

Respond ONLY in JSON:

{
  "speak": string | null,
  "action": {
    "name": string,
    "args": object
  } | null,
  "memory": string | null
}

Do not include explanations outside JSON.
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
