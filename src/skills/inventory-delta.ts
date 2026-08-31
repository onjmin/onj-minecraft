/**
 * 採集スキルの成果を「壊したブロック数」ではなく「増えた持ち物」で測る。
 *
 * ツルハシを持たずに石を掘っても何も落ちない。鉱石も同じ。それなのに
 * 採集スキルは壊した数を数えて「10個収集した」と報告していた。実際は
 * 持ち物が空のままで、エージェントは持っていない材料を持っていると誤認し、
 * その上で他人の地形をタダで壊す。本番 Realm で
 * collecting.stone が「10個収集」と返した直後にコブルストーンが0だった。
 */
import type { BotDriver } from "../core/driver/types";

export type InventorySnapshot = Map<string, number>;

export function snapshotInventory(driver: BotDriver): InventorySnapshot {
	const snap: InventorySnapshot = new Map();
	for (const item of driver.inventory.items()) {
		snap.set(item.name, (snap.get(item.name) ?? 0) + item.count);
	}
	return snap;
}

/** 撮ってからいま until 増えたぶんだけを返す。減ったものは含めない。 */
export function gainedSince(driver: BotDriver, before: InventorySnapshot): Map<string, number> {
	const after = snapshotInventory(driver);
	const gained = new Map<string, number>();
	for (const [name, count] of after) {
		const diff = count - (before.get(name) ?? 0);
		if (diff > 0) gained.set(name, diff);
	}
	return gained;
}

/** "cobblestone x8, dirt x3" の形。何も無ければ空文字。 */
export function describeGain(gained: Map<string, number>): string {
	return [...gained].map(([name, count]) => `${name} x${count}`).join(", ");
}

export function totalGain(gained: Map<string, number>): number {
	let sum = 0;
	for (const count of gained.values()) sum += count;
	return sum;
}
