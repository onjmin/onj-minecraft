import type { Bot } from "mineflayer";

export interface EnvironmentSnapshot {
	biome?: string;
	timeOfDay?: string;
	lightLevel?: number;
	health?: number;
	hunger?: number;
	position?: { x: number; y: number; z: number };
	nearbyPlayers: string[];
	nearbyMobs: string[];
}

export interface PerceptionSnapshot {
	environment: EnvironmentSnapshot;
	inventorySummary: string;
	lastDamageCause?: string;
}

export function createPerceptionSnapshot(bot: Bot): PerceptionSnapshot {
	return {
		environment: createEnvironmentSnapshot(bot),
		inventorySummary: summarizeInventory(bot),
		lastDamageCause: detectEnvironmentDamageCause(bot),
	};
}

function createEnvironmentSnapshot(bot: Bot): EnvironmentSnapshot {
	return {
		biome: bot.game?.dimension ?? "unknown",
		timeOfDay: detectTimeOfDay(bot),
		lightLevel: getPerceivedLight(bot),
		health: bot.health,
		hunger: bot.food,
		position: bot.entity?.position
			? {
					x: bot.entity.position.x,
					y: bot.entity.position.y,
					z: bot.entity.position.z,
				}
			: undefined,
		nearbyPlayers: getNearbyPlayers(bot, 16),
		nearbyMobs: getNearbyMobs(bot, 16),
	};
}

export function getPerceivedLight(bot: Bot, samples = 20, radius = 3): number {
	if (!bot.entity?.position) return 0;

	const base = bot.entity.position;
	let total = 0;
	let count = 0;

	for (let i = 0; i < samples; i++) {
		const dx = randInt(-radius, radius);
		const dz = randInt(-radius, radius);

		const pos = base.offset(dx, 0, dz);
		const block = bot.blockAt(pos);

		if (block) {
			total += block.light;
			count++;
		}
	}

	return count === 0 ? 0 : Math.round(total / count);
}

function detectTimeOfDay(bot: Bot): string {
	const time = bot.time?.timeOfDay;
	if (time == null) return "unknown";

	if (time < 1000) return "sunrise";
	if (time < 6000) return "day";
	if (time < 12000) return "sunset";
	return "night";
}

function getNearbyPlayers(bot: Bot, radius: number): string[] {
	const players = Object.values(bot.players);

	return players
		.filter((p) => p.entity)
		.filter((p) => p.username !== bot.username)
		.filter((p) => {
			return p.entity!.position.distanceTo(bot.entity.position) <= radius;
		})
		.map((p) => p.username);
}

function getNearbyMobs(bot: Bot, radius: number): string[] {
	return Object.values(bot.entities)
		.filter((e) => e.type === "mob")
		.filter((e) => {
			return e.position.distanceTo(bot.entity.position) <= radius;
		})
		.map((e) => e.name);
}

function summarizeInventory(bot: Bot): string {
	const items = bot.inventory.items();
	if (items.length === 0) return "Empty";

	const grouped: Record<string, number> = {};

	for (const item of items) {
		grouped[item.name] = (grouped[item.name] ?? 0) + item.count;
	}

	return Object.entries(grouped)
		.map(([name, count]) => `${name} x${count}`)
		.join(", ");
}

export function detectEnvironmentDamageCause(bot: Bot): string | undefined {
	if (bot.entity?.isInWater) return "drowning";
	if (bot.entity?.isInLava) return "lava";
	if (bot.entity?.velocity.y < -0.6) return "fall";
	return undefined;
}

function randInt(min: number, max: number) {
	return Math.floor(Math.random() * (max - min + 1)) + min;
}
