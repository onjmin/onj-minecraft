import { goals } from "mineflayer-pathfinder";
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
		const { bot } = agent;

		// 1. Target animals (passive mobs)
		// 対象とする動物のリスト
		const targetNames = ["cow", "pig", "sheep", "chicken", "rabbit"];
		const target = bot.nearestEntity((e) => {
			return e.name ? targetNames.includes(e.name) : false;
		});

		if (!target) {
			return skillResult.fail("No animals found nearby to hunt.");
		}

		try {
			// 2. Equip weapon (sword or axe)
			// 武器を装備（剣を優先、なければ斧）
			const weapon = bot.inventory
				.items()
				.find((item) => item.name.includes("sword") || item.name.includes("axe"));
			if (weapon) await bot.equip(weapon, "hand");

			// 3. Approach and attack
			// 動物に近づいて攻撃
			const pos = target.position;
			await agent.smartGoto(new goals.GoalFollow(target, 1));

			// Attack the entity
			// 攻撃実行
			await agent.safeAttack(target, signal);

			// 4. Wait a moment and collect drops (Reflex)
			// ドロップアイテムを拾うために少し待機して移動（脊髄反射）
			await new Promise((r) => setTimeout(r, 800));
			await agent.smartGoto(new goals.GoalNear(pos.x, pos.y, pos.z, 1));

			let ate = false;

			// 5. 【追加】食事ロジック (Survival Routine)
			// 狩りの後、空腹なら手持ちの食料を食べる
			if (bot.food < 20) {
				const edibleItems = bot.inventory.items().filter((item) => {
					return bot.registry.foodsByName[item.name] || bot.registry.foods[item.type];
				});

				if (edibleItems.length > 0) {
					const food = edibleItems[0];
					await bot.equip(food, "hand");
					await bot.consume();
					ate = true;
				}
			}

			return skillResult.ok(`Successfully hunted a ${target.name}.`, {
				hunted: target.name || "unknown",
				ate: ate,
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
