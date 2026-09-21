/**
 * 落ちている物を拾いに行く。
 *
 * 統合版は近づけば勝手に拾う。落下物の位置と中身はサイドカーが
 * AddItemActor から名前付きで持っているので、歩いて寄るだけでよい。
 *
 * 2026-09-20 にオーナーの知識で入れた。夜明けに日光で焼けたゾンビは腐った肉を
 * 落とし、腐った肉は食べれば満腹度が戻る(+4、80% で短い空腹効果、致死ではない)。
 * それまで「落ちている物」は SITUATION に載っておらず、拾う手段も他のスキル
 * (木を切る・狩る)の副作用しか無かった。
 */
import { createSkill, type SkillResponse, skillResult } from "../types";

const PICKUP_RANGE = 24;

export const pickupItemsSkill = createSkill<void, { picked: string[] }>({
	name: "collecting.pickup",
	description:
		"Walks over to dropped items lying on the ground nearby (within 24 blocks) and picks them up. SITUATION lists what is lying around. Use it for rotten flesh left by zombies burning at dawn, and for your own drops.",
	inputSchema: {} as any,
	handler: async ({ agent, signal }): Promise<SkillResponse<{ picked: string[] }>> => {
		const { driver } = agent;
		const items = driver.nearbyEntities(PICKUP_RANGE).filter((e) => e.kind === "item");
		if (items.length === 0) {
			return skillResult.fail(`No dropped items within ${PICKUP_RANGE} blocks.`);
		}
		const before = new Map<string, number>();
		for (const i of driver.inventory.items())
			before.set(i.name, (before.get(i.name) ?? 0) + i.count);

		const beforeIds = new Set(items.map((e) => e.id));
		await driver.pickupNearbyItems(signal);

		const picked: string[] = [];
		for (const i of driver.inventory.items()) {
			const gained = i.count - (before.get(i.name) ?? 0);
			if (gained > 0) picked.push(`${i.name} x${gained}`);
			before.set(i.name, 0);
		}
		// 持ち物の写しは遅れることがある。落下物が消えたなら拾えている。
		if (picked.length === 0) {
			const remaining = new Set(
				driver
					.nearbyEntities(PICKUP_RANGE + 8)
					.filter((e) => e.kind === "item")
					.map((e) => e.id),
			);
			const vanished = items.filter((e) => beforeIds.has(e.id) && !remaining.has(e.id));
			const names = (driver as unknown as { pickedUpNames?: string[] }).pickedUpNames;
			if (names && names.length > 0) {
				picked.push(...names.map((n) => `${n} (inventory copy may lag)`));
				names.length = 0;
			} else if (vanished.length > 0) {
				picked.push(...vanished.map((e) => `${e.name} (inventory copy may lag)`));
			}
		}
		if (picked.length === 0) {
			const left = driver.nearbyEntities(PICKUP_RANGE).filter((e) => e.kind === "item").length;
			return skillResult.fail(
				`Walked toward the drops but picked up nothing (${left} still lying around; they may be out of reach or in water).`,
			);
		}
		return skillResult.ok(`Picked up ${picked.join(", ")}.`, { picked });
	},
});
