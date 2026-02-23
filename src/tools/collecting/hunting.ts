import { goals } from "mineflayer-pathfinder";
import type { AgentOrchestrator } from "../../core/agent";
import { createTool, type ToolResponse, toolResult } from "../types";

/**
 * Collecting Domain: Hunting passive animals.
 * 収集ドメイン（狩猟）：食料や素材を得るために、周囲の動物を狩ります。
 */
export const huntAnimalsTool = createTool<void, { hunted: string; success: boolean }>({
	name: "collecting.hunting",
	description:
		"Finds and hunts nearby animals (cows, pigs, sheep, chickens) for food and materials.",
	inputSchema: {} as any,
	handler: async (
		agent: AgentOrchestrator,
	): Promise<ToolResponse<{ hunted: string; success: boolean }>> => {
		const { bot } = agent;

		// 1. Target animals (passive mobs)
		// 対象とする動物のリスト
		const targetNames = ["cow", "pig", "sheep", "chicken", "rabbit"];
		const target = bot.nearestEntity((e) => {
			return e.name ? targetNames.includes(e.name) : false;
		});

		if (!target) {
			return toolResult.fail("No animals found nearby to hunt.");
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
			await bot.attack(target);

			// 4. Wait a moment and collect drops (Reflex)
			// ドロップアイテムを拾うために少し待機して移動（脊髄反射）
			await new Promise((r) => setTimeout(r, 800));
			await agent.smartGoto(new goals.GoalNear(pos.x, pos.y, pos.z, 1));

			return toolResult.ok(`Successfully hunted a ${target.name}.`, {
				hunted: target.name || "unknown",
				success: true,
			});
		} catch (err) {
			return toolResult.fail(`Hunting failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	},
});
