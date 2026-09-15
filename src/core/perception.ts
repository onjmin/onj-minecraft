import type { BotDriver, Position } from "./driver/types";

export interface EnvironmentSnapshot {
	biome: string;
	timeOfDay: "sunrise" | "day" | "sunset" | "night";
	weather: "clear" | "rain";
	/** 0–15 の平均。まだ読めていない場所では null。 */
	lightLevel: number | null;
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
	position: Position;
	health: number;
	food: number;
	environment: EnvironmentSnapshot;
	inventory: InventorySummary;
	lastDamageCause?: DamageInfo;
}

const ORIGIN: Position = { x: 0, y: 0, z: 0 };

export function createPerceptionSnapshot(
	driver: BotDriver,
	lastDamageCause?: DamageInfo,
): PerceptionSnapshot {
	const state = driver.getState();

	if (!state.isReady) {
		return {
			position: ORIGIN,
			health: state.health,
			food: state.food,
			environment: {
				biome: "unknown",
				timeOfDay: "day",
				weather: "clear",
				lightLevel: null,
				nearbyPlayers: [],
				nearbyMobs: [],
			},
			inventory: {
				items: [],
				heldItem: "bare_hands",
			},
			lastDamageCause,
		};
	}

	const position = state.position;

	// バイオームはチャンク未ロードなどで引けないことがあるため、失敗しても知覚全体は止めない
	let biome = "unknown";
	try {
		biome = driver.world.getBiome(position) || state.dimension || "unknown";
	} catch {
		biome = state.dimension || "unknown";
	}

	const nearby = driver.nearbyEntities(16);
	const distanceTo = (p: Position) =>
		Math.hypot(p.x - position.x, p.y - position.y, p.z - position.z);

	const nearbyPlayers = nearby
		.filter((e) => e.kind === "player" && e.username && e.username !== state.username)
		.map((e) => e.username as string);

	const nearbyMobs = nearby
		.filter((e) => e.kind === "mob")
		.map((e) => ({ name: e.name, distance: Math.round(distanceTo(e.position)) }));

	const items = driver.inventory.items();

	return {
		position,
		health: state.health,
		food: state.food,
		environment: {
			biome,
			timeOfDay: detectTimeOfDay(state.timeOfDay),
			weather: state.isRaining ? "rain" : "clear",
			lightLevel: getPerceivedLight(driver, position),
			nearbyPlayers,
			nearbyMobs,
		},
		inventory: {
			items: items.map((i) => `${i.name} x${i.count}`),
			heldItem: driver.inventory.heldItem()?.name ?? "bare_hands",
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

/**
 * 足元まわり 3x3 の明るさを平均する。1つも読めなければ null。
 *
 * 注意: 統合版はライトレベルをクライアントへ送らないため、サイドカーが
 *       頭上の遮蔽・近くの光源・時刻から推定した近似値になる。
 *       厳密な値を前提にした判定をここより上流に書かないこと。
 *
 * 読めなかったぶんは平均に混ぜない。0 として混ぜると、視界の端が
 * 未読み込みなだけで「暗い」に寄っていく。
 */
function getPerceivedLight(driver: BotDriver, position: Position): number | null {
	const base = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
	const samples: number[] = [];

	for (let dx = -1; dx <= 1; dx++) {
		for (let dz = -1; dz <= 1; dz++) {
			try {
				const v = driver.world.getLightLevel({ x: base.x + dx, y: base.y, z: base.z + dz });
				if (v !== null) samples.push(v);
			} catch {
				// 未対応エディションやチャンク未ロードでは単に取れない
			}
		}
	}

	if (samples.length === 0) return null;
	return Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
}
