import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";

export interface EnvironmentSnapshot {
	biome: string;
	timeOfDay: "sunrise" | "day" | "sunset" | "night";
	weather: "clear" | "rain";
	lightLevel: number; // 0–15 averaged
	nearbyPlayers: string[];
	nearbyMobs: {
		name: string;
		distance: number;
	}[];
}

export interface InventorySummary {
	items: string[];
	heldItem: string;
}

export interface DamageInfo {
	type: "attack" | "fire" | "lava" | "fall" | "drowning" | "suffocation";
	attacker?: string;
}

export interface PerceptionSnapshot {
	position: Vec3;
	health: number;
	food: number;
	environment: EnvironmentSnapshot;
	inventory: InventorySummary;
	lastDamageCause?: DamageInfo;
}

export function createPerceptionSnapshot(
	bot: Bot,
	lastDamageCause?: DamageInfo,
): PerceptionSnapshot {
	const position = bot.entity.position.clone();
	const health = bot.health;
	const food = bot.food;

	// biome取得
	const blockAtPos = bot.blockAt(bot.entity.position);

	// 1. 位置を確定（自分自身の足元の座標 Vec3 を取得）
	const pos = blockAtPos?.position || bot.entity.position;

	let biomeName = "unknown";

	if (pos) {
		try {
			// 2. 標準API: world.getBiome を使用して ID を取得
			const biomeId = bot.world.getBiome(pos);

			// 3. レジストリからバイオーム情報を取得
			const biomeInfo = bot.registry.biomes[biomeId];
			
			// 4. 名前を取得（例: "plains"）
			biomeName = biomeInfo?.name || bot.game.dimension || "unknown";
		} catch (err) {
			// まだチャンクが読み込まれていない場合はここに来る
			biomeName = bot.game.dimension || "unknown";
		}
	} else {
		biomeName = bot.game.dimension || "unknown";
	}

	const timeOfDay = detectTimeOfDay(bot.time.timeOfDay);
	const weather = bot.isRaining ? "rain" : "clear";
	const lightLevel = getPerceivedLight(bot);

	const nearbyPlayers = getNearbyPlayers(bot, 16);
	const nearbyMobs = getNearbyMobs(bot, 16);

	const inventoryItems = bot.inventory.items().map((i) => `${i.name} x${i.count}`) ?? [];

	const heldItem = bot.heldItem?.name ?? "bare_hands";

	return {
		position,
		health,
		food,
		environment: {
			biome: biomeName,
			timeOfDay,
			weather,
			lightLevel,
			nearbyPlayers,
			nearbyMobs,
		},
		inventory: {
			items: inventoryItems,
			heldItem,
		},
		lastDamageCause,
	};
}

function detectTimeOfDay(tick: number): "sunrise" | "day" | "sunset" | "night" {
	const t = tick % 24000;

	if (t < 1000) return "sunrise";
	if (t < 6000) return "day";
	if (t < 12000) return "sunset";
	return "night";
}

function getNearbyPlayers(bot: Bot, radius: number): string[] {
	if (!bot.entity?.position) return [];

	return Object.values(bot.players)
		.filter((p) => p.entity && p.entity.position.distanceTo(bot.entity.position) < radius)
		.map((p) => p.username);
}

function getNearbyMobs(bot: Bot, radius: number): { name: string; distance: number }[] {
	if (!bot.entity?.position) return [];

	return Object.values(bot.entities)
		.filter((e) => e.type === "mob" && e.position.distanceTo(bot.entity.position) < radius)
		.map((e) => ({
			name: e.name ?? e.displayName ?? e.type,
			distance: Math.round(e.position.distanceTo(bot.entity.position)),
		}));
}

function getPerceivedLight(bot: Bot): number {
	const pos = bot.entity.position.floored();
	const samples: number[] = [];

	for (let dx = -1; dx <= 1; dx++) {
		for (let dz = -1; dz <= 1; dz++) {
			const block = bot.blockAt(pos.offset(dx, 0, dz));
			if (!block) continue;

			const raw = Math.max(block.light ?? 0, (block as any).skyLight ?? 0);

			samples.push(raw);
		}
	}

	if (samples.length === 0) return 0;

	const avg = samples.reduce((a, b) => a + b, 0) / samples.length;

	return Math.round(avg);
}
