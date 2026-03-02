import type { Bot } from "mineflayer";
import { goals } from "mineflayer-pathfinder";
import type { Vec3 } from "vec3";
import { createSkill, type SkillResponse, skillResult } from "../types";

export const collectWoodSkill = createSkill<void, { count: number }>({
    name: "collecting.wood",
    description: "Automatically finds and fells nearby trees, including clearing leaves to move safely.",
    inputSchema: {} as any,
    handler: async ({ agent, signal }): Promise<SkillResponse<{ count: number }>> => {
        const { bot } = agent;
        const logs = woodScanner.findNearbyLogs(bot);

        if (logs.length === 0) return skillResult.fail("No trees found nearby.");

        let felledCount = 0;

        try {
            const target = logs[0];
            const toolPlugin = (bot as any).tool;

            // 木の上にいる場合を考慮し、目標地点の少し横まで移動を試みる
            const goal = new goals.GoalNear(target.x, target.y, target.z, 2);
            await agent.abortableGoto(signal, goal);

            // 周辺のブロック（原木と葉っぱ）をスキャン
            const blocksToRemove: Vec3[] = [];
            // ターゲットの周囲（x,z: ±1, y: 0〜6）をチェックして、木に関連するブロックを収集
            for (let x = -1; x <= 1; x++) {
                for (let z = -1; z <= 1; z++) {
                    for (let y = 0; y <= 6; y++) {
                        const pos = target.offset(x, y, z);
                        const b = bot.blockAt(pos);
                        if (b && (isLog(b.name) || isLeaves(b.name))) {
                            blocksToRemove.push(pos);
                        }
                    }
                }
            }

            // ボットの足元の高さを取得
			const botY = bot.entity.position.y;

			// ソート順の変更
			blocksToRemove.sort((a, b) => {
				// 1. まずは「ボットの手が届く範囲(y=0~2付近)」を優先したい
				// 2. 次に「上」を掘っていく
				// 3. 最後に「足元(y=-1以下)」を掘る
				
				// 単純な実装：ボットの目線の高さ(y + 1.6)に近いものから順にする
				const distA = Math.abs(a.y - (botY + 1.5));
				const distB = Math.abs(b.y - (botY + 1.5));
				
				return distA - distB;
			});

            for (const pos of blocksToRemove) {
                const block = bot.blockAt(pos);
                if (block && block.name !== 'air' && bot.canDigBlock(block)) {
                    if (toolPlugin) {
                        await toolPlugin.equipForBlock(block);
                    }
                    await agent.abortableDig(signal, block);
                    felledCount++;
                    // 落下やアイテムドロップを考慮
                    await agent.pickupNearbyItems();
                }
            }

            return skillResult.ok(
                `Successfully cleared ${felledCount} blocks around ${target.x}, ${target.z}.`,
                { count: felledCount },
            );
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            if (errorMsg.includes("Cancelled") || errorMsg.includes("stop")) {
                return skillResult.fail("Wood cancelled by combat");
            }
            return skillResult.fail(`Wood failed: ${errorMsg}`);
        }
    },
});

function isLog(name: string): boolean {
    return (
        name.endsWith("_log") ||
        name.endsWith("_wood") ||
        name.endsWith("_stem") ||
        name.endsWith("_hyphae")
    );
}

// 葉っぱ判定の追加
function isLeaves(name: string): boolean {
    return (
        name.endsWith("_leaves") ||
        name.endsWith("_wart_block") ||
        name === "shroomlight"
    );
}

export const woodScanner = {
    findNearbyLogs: (bot: Bot, radius = 24): Vec3[] => {
        return bot
            .findBlocks({
                matching: (block: any) => isLog(block.name),
                maxDistance: radius,
                count: 10,
            })
            .sort((a, b) => {
                return bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b);
            });
    },
};