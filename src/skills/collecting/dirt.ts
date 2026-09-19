import { envNum } from "../../core/utils/env";
import { notBelowFeet } from "../dig-guard";
import { describeGain, gainedSince, snapshotInventory, totalGain } from "../inventory-delta";
import { createSkill, type SkillResponse, skillResult } from "../types";

/** 1回の採集にかける上限。 */
const DIRT_BUDGET_MS = envNum("DIRT_BUDGET_MS", 40_000);
/** 何ブロック掘るごとに落下物を拾いに行くか。 */
const PICKUP_EVERY = 5;

export const collectDirtSkill = createSkill<void, { count: number }>({
	name: "collecting.dirt",
	description:
		"Collects dirt blocks for scaffolding or building base walls. Digs nearby dirt/grass blocks.",
	inputSchema: {} as any,
	handler: async ({ agent, signal }): Promise<SkillResponse<{ count: number }>> => {
		const { driver } = agent;

		// 下へは掘らない(dig-guard.ts)。足元の土を取ると自分が沈む。
		const dirtBlocks = notBelowFeet(
			driver,
			driver.world.findBlocks(["dirt", "grass_block"], 16, 20),
		);

		if (dirtBlocks.length === 0) {
			return skillResult.fail("No dirt or grass blocks found nearby.");
		}

		agent.log(`[collecting.dirt] Found ${dirtBlocks.length} dirt blocks`);

		let collected = 0;
		const maxCollect = 16;
		// 成果は増えた持ち物で測る。壊した数を返すと、拾えていなくても
		// 「集めた」ことになってしまう。
		const before = snapshotInventory(driver);
		// 1回の採集にかける上限。土16個を追いかけて90秒使うと、
		// 思考ループから見て終わらない行動になる。
		const deadline = Date.now() + DIRT_BUDGET_MS;

		for (const block of dirtBlocks) {
			if (collected >= maxCollect) break;
			if (Date.now() > deadline) break;
			if (agent.checkAbort(signal)) break;

			if (!block.diggable) continue;

			// 詰め切れなくても諦めない。採掘は6ブロックまで届く。
			try {
				await driver.goto(signal, { kind: "near", position: block.position, distance: 1 });
			} catch (moveErr) {
				if (signal.aborted) throw moveErr;
			}

			// 移動中に地形が変わりうるので取り直す
			const currentBlock = driver.world.blockAt(block.position);
			if (currentBlock?.diggable) {
				await driver.equipBestTool(block.position);
				try {
					await driver.dig(signal, block.position);
				} catch (digErr) {
					if (signal.aborted) throw digErr;
					continue;
				}
				collected++;
				// 回収は毎回ではなく数個おきに。pickupNearbyItems は落下物が
				// 出るのを待つので、1個ごとに挟むと待ちで時間が尽きる。
				if (collected % PICKUP_EVERY === 0) {
					await driver.pickupNearbyItems(signal);
				}
			}
		}
		await driver.pickupNearbyItems(signal);

		const gained = gainedSince(driver, before);
		agent.log(`[collecting.dirt] ${collected}ブロック掘り、${describeGain(gained) || "何も"}得た`);

		if (totalGain(gained) === 0) {
			return skillResult.fail(
				collected > 0
					? `Broke ${collected} blocks but picked nothing up.`
					: "Could not dig any dirt.",
			);
		}
		return skillResult.ok(`Collected ${describeGain(gained)}.`, { count: totalGain(gained) });
	},
});
