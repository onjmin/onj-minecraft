import { createSkill, type SkillResponse, skillResult } from "../types";

/**
 * Collecting Domain: Hunting passive animals.
 * 収集ドメイン（狩猟）：食料や素材を得るために、周囲の動物を狩ります。
 */
export const huntAnimalsSkill = createSkill<void, { hunted: string; success: boolean }>({
	name: "collecting.hunting",
	description:
		"Finds and hunts nearby animals (cows, pigs, sheep, chickens) for food and materials.",
	inputSchema: {} as any,
	handler: async ({
		agent,
		signal,
	}): Promise<SkillResponse<{ hunted: string; success: boolean }>> => {
		const { driver } = agent;
		const origin = driver.getState().position;

		// 1. Target animals (passive mobs)
		// 対象とする動物のリスト
		const targetNames = ["cow", "pig", "sheep", "chicken", "rabbit"];
		const distanceTo = (p: { x: number; y: number; z: number }) =>
			Math.hypot(p.x - origin.x, p.y - origin.y, p.z - origin.z);
		const [target] = driver
			.nearbyEntities(32)
			.filter((e) => targetNames.includes(e.name))
			.sort((a, b) => distanceTo(a.position) - distanceTo(b.position));

		if (!target) {
			return skillResult.fail("No animals found nearby to hunt.");
		}

		try {
			// 2. Equip weapon (sword or axe)
			// 武器を装備（剣を優先、なければ斧）
			//
			// includes("axe") で探していたので pickaxe が引っかかっていた。
			// しかも find は持ち物の並び順で最初の1つを返すため、剣を持って
			// いてもツルハシが手前にあればそちらを持って殴りに行っていた。
			// ツルハシの攻撃力は素手と大差ない。順番に探して剣を優先する。
			const items = driver.inventory.items();
			const weapon =
				items.find((item) => item.name.endsWith("_sword")) ??
				items.find((item) => item.name.endsWith("_axe"));
			if (weapon) await driver.equip(weapon.name, "hand");

			// 3. Approach and attack until dead
			// 動物を倒すまで追撃して攻撃を繰り返す
			let lastPos = target.position;
			for (let i = 0; i < 6; i++) {
				if (signal.aborted) break;
				const current = driver.nearbyEntities(32).find((e) => e.id === target.id);
				if (!current) break;
				lastPos = current.position;
				try {
					await driver.goto(signal, { kind: "follow", entityId: target.id, distance: 1.5 });
					await driver.attack(signal, target.id);
					await new Promise((r) => setTimeout(r, 350));
				} catch {
					break;
				}
			}

			// 4. Wait a moment and collect drops (Reflex)
			// ドロップアイテムを拾うために移動（脊髄反射）
			await new Promise((r) => setTimeout(r, 500));
			try {
				await driver.goto(signal, { kind: "near", position: lastPos, distance: 1 });
				await driver.pickupNearbyItems(signal);
			} catch {}

			return skillResult.ok(`Successfully hunted a ${target.name}.`, {
				hunted: target.name || "unknown",
				success: true,
			});
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			if (errorMsg.includes("Cancelled") || errorMsg.includes("stop")) {
				return skillResult.fail("Hunting cancelled by combat");
			}
			return skillResult.fail(`Hunting failed: ${errorMsg}`);
		}
	},
});
