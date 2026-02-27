import { goals } from "mineflayer-pathfinder";
import type { AgentOrchestrator } from "../../core/agent";
import { createSkill, type SkillResponse, skillResult } from "../types";

/**
 * Collecting Domain: Stealing from containers.
 * 収集ドメイン（窃取）：周囲のチェストや樽をスキャンし、中身をすべて回収します。
 */
export const stealFromChestSkill = createSkill<void, { itemsCount: number; containerType: string }>(
	{
		name: "collecting.stealing",
		description: "Finds a nearby chest or barrel, opens it, and takes all items inside.",
		inputSchema: {} as any,
		handler: async (
			agent: AgentOrchestrator,
		): Promise<SkillResponse<{ itemsCount: number; containerType: string }>> => {
			const { bot } = agent;

			// 1. 周辺のコンテナ（チェスト、樽、トラップチェスト）をスキャン
			const containerBlock = bot.findBlock({
				matching: [
					bot.registry.blocksByName.chest.id,
					bot.registry.blocksByName.barrel.id,
					bot.registry.blocksByName.trapped_chest.id,
				],
				maxDistance: 16,
			});

			if (!containerBlock) {
				return skillResult.fail("No chests or barrels found nearby.");
			}

			try {
				// 2. ターゲットへ移動
				await agent.smartGoto(
					new goals.GoalGetToBlock(
						containerBlock.position.x,
						containerBlock.position.y,
						containerBlock.position.z,
					),
				);

				// 3. コンテナを開く
				const container = await bot.openContainer(containerBlock);
				const containerItems = container.containerItems();
				const itemsCount = containerItems.length;

				if (itemsCount === 0) {
					container.close();
					return skillResult.ok("The container was empty.", {
						itemsCount: 0,
						containerType: containerBlock.name,
					});
				}

				// 4. すべてのアイテムを回収 (1つずつ引き出す)
				for (const item of containerItems) {
					// インベントリがいっぱいの場合は途中で停止
					if (bot.inventory.emptySlotCount() === 0) break;
					await container.withdraw(item.type, null, item.count);
				}

				container.close();

				let equipped = false;

				// 3. --- Survival Routine A: Equip better gear ---
				// 奪ったアイテムを含め、最強の装備に更新
				// （ここでは簡易的に armor-manager 的な動きを想定、手動での装備更新ロジック）
				const armorItems = bot.inventory
					.items()
					.filter(
						(i) =>
							i.name.endsWith("_helmet") ||
							i.name.endsWith("_chestplate") ||
							i.name.endsWith("_leggings") ||
							i.name.endsWith("_boots"),
					);

				if (armorItems.length > 0) {
					// 本来は防御力を計算すべきですが、ここでは「持っている防具を装備する」反復行動とします
					// 実際には外部モジュールの mineflayer-armor-manager などを使うのが理想的です
					for (const item of armorItems) {
						try {
							await bot.equip(item, null);
							equipped = true;
						} catch {
							/* すでに装備中などのエラーは無視 */
						}
					}
				}

				let ate = false;

				// 4. --- Survival Routine: Eat after stealing ---
				// 奪ったばかりの食料も含め、インベントリから食事
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

				return skillResult.ok(`Stole ${itemsCount} items from ${containerBlock.name}.`, {
					itemsCount,
					ate,
					equipped,
					containerType: containerBlock.name,
				});
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				if (errorMsg.includes("Cancelled") || errorMsg.includes("stop")) {
					return skillResult.fail("Stealing cancelled by combat");
				}
				return skillResult.fail(`Stealing failed: ${errorMsg}`);
			}
		},
	},
);
