import type { BlockInfo, BotDriver } from "../../core/driver/types";
import { envNum } from "../../core/utils/env";
import { notBelowFeet } from "../dig-guard";
import { describeGain, gainedSince, snapshotInventory, totalGain } from "../inventory-delta";
import { createSkill, type SkillResponse, skillResult } from "../types";

/** 1回の採集にかける上限。長すぎると思考ループから見て終わらない行動になる。 */
const STONE_BUDGET_MS = envNum("STONE_BUDGET_MS", 40_000);
/** 何ブロック掘るごとに落下物を拾いに行くか。 */
const PICKUP_EVERY = 4;
/**
 * 歩かずに掘れる距離。サイドカーの採掘は目線から6ブロックまで届く
 * (session.go digReach)。境界ぎりぎりは丸めで弾かれるので少し内側にする。
 */
const DIG_REACH = envNum("STONE_DIG_REACH", 5.5);
/** 目線の高さ。位置は足元で来るので、届く距離はここから測る。 */
const EYE_HEIGHT = 1.6;
/**
 * 石まで歩く1回の上限。
 *
 * 石は足元の高さに並んでいて、掘るたびに穴が開く。次の石へ goto すると
 * 経路探索が穴を橋渡ししようとして(stepBridge)12秒待ち、3回諦めて 30秒で
 * 失敗する。これが石1個ごとに入り、40秒予算の1回が136秒かかって丸石2個
 * だった(実測 2026-09-19 20:50、raw-food)。届く石は歩かずに掘り、歩く
 * ときも短く切る。
 */
const STONE_GOTO_TIMEOUT_MS = envNum("STONE_GOTO_TIMEOUT_MS", 8_000);
/** 掘った穴へ一歩入る上限。隣の1マスなので、これで着かないなら諦める。 */
const STONE_HOLE_STEP_MS = envNum("STONE_HOLE_STEP_MS", 4_000);

export const collectStoneSkill = createSkill<void, { minedCount: number }>({
	name: "collecting.stone",
	// 何が手に入り、それで何が作れるかまで書く。「石を集める」だけでは、
	// 生肉を焼くためにかまど(丸石8個)が要ると分かっていても、この
	// スキルがその丸石を出すことに LLM が結び付けない。実測 2026-09-19、
	// ローカルの採点で丸石が要ると知りながら木を探し続けた。
	description:
		"Mines nearby stone with your pickaxe and yields COBBLESTONE. 8 cobblestone + a crafting table = a furnace (for cooking raw meat); cobblestone also makes stone tools. Requires a pickaxe.",
	inputSchema: {} as any,
	handler: async ({ agent, signal }): Promise<SkillResponse<{ minedCount: number }>> => {
		const { driver } = agent;

		// 石系ブロックを近場からスキャン。下へは掘らない(dig-guard.ts)。
		const rawStone = stoneScanner.findNearbyStone(driver);
		const stonePositions = notBelowFeet(driver, rawStone);

		if (stonePositions.length === 0) {
			// 何が無かったのかを残す。写しに石が無いのか、足元より下に弾かれたのか。
			// 実測 2026-09-20 02:24、石の床の上で4分間「石が無い」が続いたが、
			// どちらだったのか読めなかった。
			const me = driver.getState().position;
			agent.log(
				`[collecting.stone] 石が見つからない: 写しの石 ${rawStone.length} 個、足元より下を除くと 0 個 (足元 Y=${Math.floor(me.y)}, 足元ブロック=${driver.world.blockAt({ x: Math.floor(me.x), y: Math.floor(me.y) - 1, z: Math.floor(me.z) })?.name ?? "?"})`,
			);
			return skillResult.fail(
				rawStone.length > 0
					? `Stone is only below your feet here (${rawStone.length} blocks). Digging down is not done without an iron pickaxe, torches and food; find stone in a wall, cliff or cave instead.`
					: "No stone blocks found nearby. Try moving to a lower altitude.",
			);
		}

		let minedCount = 0;
		// 成果は壊した数ではなく増えた持ち物で測る。ツルハシ無しで石を掘っても
		// 何も落ちないので、壊した数を返すと「集めた」と嘘をつくことになる。
		const before = snapshotInventory(driver);
		const startedAt = Date.now();
		const deadline = startedAt + STONE_BUDGET_MS;
		// どこに時間が消えたかを残す。1回の成果が丸石2〜3個で頭打ちなのに、
		// 40秒予算のはずが74〜136秒かかっていた。歩き・掘り・回収のどれかが
		// 分からないと直しようがない。
		let gotoMs = 0;
		let digMs = 0;
		let pickupMs = 0;
		let holeMs = 0;
		let skippedFar = 0;
		let digFailed = 0;

		try {
			// 石は数が必要なので、上位10個をターゲットにする
			for (const stone of stonePositions) {
				if (Date.now() > deadline) break;
				// 届く石は歩かない。半径8で拾った石の大半は目線から6ブロック以内に
				// あり、歩く必要が無い。歩くと掘った穴の縁で経路探索が止まる。
				const me = driver.getState().position;
				const reach = Math.hypot(
					me.x - (stone.position.x + 0.5),
					me.y + EYE_HEIGHT - (stone.position.y + 0.5),
					me.z - (stone.position.z + 0.5),
				);
				if (reach > DIG_REACH) {
					// 詰め切れなくても諦めない。採掘は6ブロックまで届くので、
					// 少し手前で止まっていても掘れることが多い。届かなければ
					// 下の dig が個別に失敗するだけで済む。
					const t = Date.now();
					try {
						await driver.goto(
							signal,
							{ kind: "near", position: stone.position, distance: 2 },
							{ timeoutMs: STONE_GOTO_TIMEOUT_MS },
						);
					} catch (moveErr) {
						if (signal.aborted) throw moveErr;
					}
					gotoMs += Date.now() - t;
				} else {
					skippedFar++;
				}

				const block = driver.world.blockAt(stone.position);
				// 移動中にブロックが変わっていないかチェック
				if (block && stoneScanner.isStone(block.name)) {
					// 適切なツール（ツルハシ）を装備
					await driver.equipBestTool(block.position);
					const t = Date.now();
					try {
						await driver.dig(signal, block.position);
					} catch (digErr) {
						if (signal.aborted) throw digErr;
						digFailed++;
						digMs += Date.now() - t;
						continue;
					}
					digMs += Date.now() - t;
					minedCount++;
					// 床の高さの石を掘ると、丸石はその穴の底に落ちる。統合版の
					// 自動回収はおよそ1ブロックで、穴の縁からは届かない。回収の
					// goto は穴の縁で橋渡しを試みて空回りする(実測 2026-09-19
					// 23:00、掘り5秒に回収105秒、4個掘って2個)。掘った直後に
					// 穴へ一歩入れば、落ちた瞬間に拾える。1段の穴は跳んで出られる。
					if (block.position.y < Math.floor(driver.getState().position.y)) {
						const th = Date.now();
						try {
							await driver.goto(
								signal,
								{
									kind: "near",
									position: { ...block.position },
									distance: 0.6,
									dig: false,
								},
								{ timeoutMs: STONE_HOLE_STEP_MS },
							);
						} catch (stepErr) {
							if (signal.aborted) throw stepErr;
						}
						holeMs += Date.now() - th;
					}
					// 落下物は足元に落ちるとは限らない。数個おきに拾いに行く。
					if (minedCount % PICKUP_EVERY === 0) {
						const tp = Date.now();
						await driver.pickupNearbyItems(signal);
						pickupMs += Date.now() - tp;
					}
				}
			}
			{
				const tp = Date.now();
				await driver.pickupNearbyItems(signal);
				pickupMs += Date.now() - tp;
			}
			agent.log(
				`[collecting.stone] 掘った ${minedCount}(失敗 ${digFailed}) 届いた ${skippedFar} 所要 ${Date.now() - startedAt}ms (歩き ${gotoMs}ms 掘り ${digMs}ms 穴へ ${holeMs}ms 回収 ${pickupMs}ms)`,
			);

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
