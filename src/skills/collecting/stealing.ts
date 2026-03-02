import { goals } from "mineflayer-pathfinder";
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
		handler: async ({
			agent,
			signal,
		}): Promise<SkillResponse<{ itemsCount: number; containerType: string }>> => {
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
				await agent.abortableGoto(
					signal,
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

				return skillResult.ok(`Stole ${itemsCount} items from ${containerBlock.name}.`, {
					itemsCount,
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
