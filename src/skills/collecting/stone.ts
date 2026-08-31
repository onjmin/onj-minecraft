import type { BlockInfo, BotDriver } from "../../core/driver/types";
import { describeGain, gainedSince, snapshotInventory, totalGain } from "../inventory-delta";
import { createSkill, type SkillResponse, skillResult } from "../types";

/** 1回の採集にかける上限。長すぎると思考ループから見て終わらない行動になる。 */
const STONE_BUDGET_MS = Number(process.env.STONE_BUDGET_MS ?? 40_000);
/** 何ブロック掘るごとに落下物を拾いに行くか。 */
const PICKUP_EVERY = 4;

export const collectStoneSkill = createSkill<void, { minedCount: number }>({
	name: "collecting.stone",
	description: "Collects stone-type blocks. Requires a pickaxe to successfully obtain stone.",
	inputSchema: {} as any,
	handler: async ({ agent, signal }): Promise<SkillResponse<{ minedCount: number }>> => {
		const { driver } = agent;

		// 石系ブロックを近場からスキャン
		const stonePositions = stoneScanner.findNearbyStone(driver);

		if (stonePositions.length === 0) {
			return skillResult.fail("No stone blocks found nearby. Try moving to a lower altitude.");
		}

		let minedCount = 0;
		// 成果は壊した数ではなく増えた持ち物で測る。ツルハシ無しで石を掘っても
		// 何も落ちないので、壊した数を返すと「集めた」と嘘をつくことになる。
		const before = snapshotInventory(driver);
		const deadline = Date.now() + STONE_BUDGET_MS;

		try {
			// 石は数が必要なので、上位10個をターゲットにする
			for (const stone of stonePositions) {
				if (Date.now() > deadline) break;
				// 詰め切れなくても諦めない。採掘は6ブロックまで届くので、
				// 少し手前で止まっていても掘れることが多い。届かなければ
				// 下の dig が個別に失敗するだけで済む。
				try {
					await driver.goto(signal, { kind: "near", position: stone.position, distance: 2 });
				} catch (moveErr) {
					if (signal.aborted) throw moveErr;
				}

				const block = driver.world.blockAt(stone.position);
				// 移動中にブロックが変わっていないかチェック
				if (block && stoneScanner.isStone(block.name)) {
					// 適切なツール（ツルハシ）を装備
					await driver.equipBestTool(block.position);
					try {
						await driver.dig(signal, block.position);
					} catch (digErr) {
						if (signal.aborted) throw digErr;
						continue;
					}
					minedCount++;
					// 落下物は足元に落ちるとは限らない。数個おきに拾いに行く。
					if (minedCount % PICKUP_EVERY === 0) {
						await driver.pickupNearbyItems(signal);
					}
				}
			}
			await driver.pickupNearbyItems(signal);

			const gained = gainedSince(driver, before);
			if (totalGain(gained) === 0) {
				// 壊せたのに何も手に入らないのは、ほぼツルハシが無いから。
				// 成功として返すと、持っていない石を前提に次の行動が組まれる。
				return skillResult.fail(
					minedCount > 0
						? `Broke ${minedCount} stone blocks but obtained nothing. Stone requires a pickaxe to drop; craft one first.`
						: "No stone could be mined.",
				);
			}
			return skillResult.ok(`Collected ${describeGain(gained)}.`, {
				minedCount: totalGain(gained),
			});
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			if (errorMsg.includes("Cancelled") || errorMsg.includes("stop")) {
				return skillResult.fail("Stone collection interrupted by combat or system stop.");
			}
			return skillResult.fail(`Stone collection failed: ${errorMsg}`);
		}
	},
});

export const stoneScanner = {
	// 採集対象とする石系ブロックの定義
	stoneBlocks: ["stone", "cobblestone", "deepslate", "andesite", "diorite", "granite", "tuff"],

	isStone: (name: string): boolean => {
		return stoneScanner.stoneBlocks.includes(name);
	},

	findNearbyStone: (driver: BotDriver, radius = 8): BlockInfo[] => {
		// 鉱石より出現率が高いため、一度の取得数を多めに設定
		return driver.world.findBlocks(stoneScanner.stoneBlocks, radius, 10);
	},
};
