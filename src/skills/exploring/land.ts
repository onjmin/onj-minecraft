import { goals } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { createSkill, type SkillResponse, skillResult } from "../types";

export const exploreLandSkill = createSkill<void, { x: number; z: number }>({
    name: "exploring.explore_land",
    description: "Explores the surface by sampling nearby safe ground. Avoids walls and steep cliffs.",
    inputSchema: {} as any,
    handler: async ({ agent, signal }): Promise<SkillResponse<{ x: number; z: number }>> => {
        const { bot } = agent;

        // --- 1. インテリジェント・サンプリング ---
        const candidates: Vec3[] = [];
        const radius = 15;
        const currentY = Math.floor(bot.entity.position.y);
        
        for (let i = 0; i < 20; i++) {
            const dx = Math.floor((Math.random() - 0.5) * radius * 2);
            const dz = Math.floor((Math.random() - 0.5) * radius * 2);
            const tx = Math.floor(bot.entity.position.x + dx);
            const tz = Math.floor(bot.entity.position.z + dz);

            // getHighestBlockYAt の代替ロジック：
            // 現在の高さから上下5ブロックの範囲で地面を探す
            let foundY: number | null = null;
            for (let dy = 5; dy >= -5; dy--) {
                const checkPos = new Vec3(tx, currentY + dy, tz);
                const block = bot.blockAt(checkPos);
                const up1 = bot.blockAt(checkPos.offset(0, 1, 0));
                const up2 = bot.blockAt(checkPos.offset(0, 2, 0));

                // 「足場が実体」かつ「その上が2マス空き」ならそこを地面とする
                if (block && block.boundingBox === 'block' && 
                    up1?.boundingBox === 'empty' && 
                    up2?.boundingBox === 'empty') {
                    foundY = currentY + dy + 1;
                    break;
                }
            }

            if (foundY === null) continue;

            const finalPos = new Vec3(tx, foundY, tz);
            const groundBlock = bot.blockAt(finalPos.offset(0, -1, 0));
            
            // 水などは除外
            if (groundBlock && groundBlock.name !== 'water' && groundBlock.name !== 'lava') {
                candidates.push(finalPos);
            }
        }

        let targetPos = candidates.length > 0 
            ? candidates[Math.floor(Math.random() * candidates.length)]
            : null;

        if (!targetPos) {
            return skillResult.fail("No safe ground found in sampling.");
        }

        const { x, y, z } = targetPos;

        try {
            // --- 2. 3次元目的地による移動 ---
            await Promise.race([
                agent.safeGoto(new goals.GoalNear(x, y, z, 1), signal),
                new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 30000)),
            ]);

            return skillResult.ok("Reached destination.", { x, z });
        } catch (err) {
            // --- 3. リカバリ処理 ---
            bot.clearControlStates();
            const escapeYaw = bot.entity.yaw + (Math.random() > 0.5 ? 1 : -1);
            await bot.look(escapeYaw, bot.entity.pitch, true);
            bot.setControlState("forward", true);
            bot.setControlState("jump", true);
            
            await new Promise((r) => setTimeout(r, 600));
            bot.clearControlStates();

            return skillResult.fail("Movement failed.");
        }
    },
});