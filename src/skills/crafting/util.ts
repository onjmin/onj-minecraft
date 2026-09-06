import type { MinecraftAgent } from "../../core/agent";
import type { BlockInfo, Position } from "../../core/driver/types";

/**
 * 設置候補。元実装は Block オブジェクトに _needsDig / _digTarget を生やしていたが、
 * エディション固有の Block に依存しないよう独立した型にした。
 */
interface PlaceCandidate {
	block: BlockInfo;
	dist: number;
	needsDig: boolean;
	digTarget?: BlockInfo;
}

/**
 * 中断しない AbortSignal。
 * 元実装の設置・整地処理は AbortSignal を見ていなかったため、挙動を変えないために使う。
 * TODO: 呼び出し側から signal を引き回せるようになったら差し替える。
 */
const neverAbort = (): AbortSignal => new AbortController().signal;

/** 上面(0,1,0)に設置することを示すオフセット。 */
const UP: Position = { x: 0, y: 1, z: 0 };

/**
 * 設置を試みる（複数の位置でリトライ）
 * 候補が埋まっている場合は、掘ってでも設置を試みる
 */
export async function tryPlaceBlock(
	agent: MinecraftAgent,
	itemName: string,
	blockName: string,
	targetPos?: Position,
): Promise<BlockInfo | null> {
	const { driver } = agent;

	let positions: PlaceCandidate[];
	if (targetPos) {
		// 下のブロックを土台にする
		const block = driver.world.blockAt({ ...targetPos, y: targetPos.y - 1 });
		if (!block) return null;
		positions = [{ block, dist: 0, needsDig: false }];
	} else {
		positions = findAllPlaceablePositions(agent);
	}
	agent.log(`[tryPlaceBlock] Found ${positions.length} positions`);

	if (positions.length === 0) {
		agent.log(`[tryPlaceBlock] No placeable positions found!`);
		return null;
	}

	const item = driver.inventory.items().find((i) => i.name === itemName);
	if (!item) {
		agent.log(`[tryPlaceBlock] Item not found in inventory: ${itemName}`);
		return null;
	}
	agent.log(`[tryPlaceBlock] Item found: ${item.name}, count=${item.count}`);

	for (const candidate of positions) {
		const refBlock = candidate.block;
		agent.log(
			`[tryPlaceBlock] Trying at ${JSON.stringify(refBlock.position)}, ref=${refBlock.name}, needsDig=${candidate.needsDig}`,
		);

		try {
			await driver.equip(item.name, "hand");
			agent.log(`[tryPlaceBlock] Equipped ${item.name}`);

			await new Promise((r) => setTimeout(r, 500));

			if (candidate.needsDig && candidate.digTarget) {
				agent.log(`[tryPlaceBlock] Digging blocking block: ${candidate.digTarget.name}`);
				await driver.equipBestTool(candidate.digTarget.position);
				await driver.dig(neverAbort(), candidate.digTarget.position);
				await new Promise((r) => setTimeout(r, 500));
			}

			try {
				await driver.placeBlock(neverAbort(), refBlock.position, UP);
				agent.log(`[tryPlaceBlock] placeBlock returned`);
			} catch (placeErr) {
				agent.log(`[tryPlaceBlock] placeBlock error: ${placeErr}`);
				continue;
			}

			await new Promise((r) => setTimeout(r, 500));
			const placed = driver.world.findBlock([blockName], 4);

			if (placed) {
				agent.log(`[tryPlaceBlock] SUCCESS at ${JSON.stringify(refBlock.position)}`);
				return placed;
			} else {
				agent.log(`[tryPlaceBlock] Block not found after placement`);
			}
		} catch (e) {
			agent.log(`[tryPlaceBlock] Error at ${JSON.stringify(refBlock.position)}: ${e}`);
		}
	}

	agent.log(`[tryPlaceBlock] All positions failed`);
	return null;
}

const DIGGABLE_BLOCKS = [
	"dirt",
	"grass_block",
	"sand",
	"gravel",
	"cobblestone",
	"stone",
	"andesite",
	"granite",
	"diorite",
	"deepslate",
	"tuff",
	"netherrack",
	"bedrock",
	"oak_leaves",
	"birch_leaves",
	"jungle_leaves",
	"spruce_leaves",
	"dark_oak_leaves",
	"acacia_leaves",
	"moss_block",
];

function isDiggable(name: string): boolean {
	return DIGGABLE_BLOCKS.includes(name) || name.endsWith("_leaves");
}

/**
 * 設置可能な位置をすべて取得（拡張版）
 * 設置可能な場所がない場合は、掘ってでも場所を作る候補を含める
 */
export function findAllPlaceablePositions(agent: MinecraftAgent): PlaceCandidate[] {
	const { driver } = agent;
	const candidates: PlaceCandidate[] = [];

	const state = driver.getState();
	if (!state.isReady) return [];
	const agentY = Math.floor(state.position.y);
	const base = {
		x: Math.floor(state.position.x),
		y: Math.floor(state.position.y),
		z: Math.floor(state.position.z),
	};

	for (let dx = -3; dx <= 3; dx++) {
		for (let dz = -3; dz <= 3; dz++) {
			if (dx === 0 && dz === 0) continue;

			const refBlock = driver.world.blockAt({
				x: base.x + dx,
				y: base.y - 1,
				z: base.z + dz,
			});
			if (!refBlock || refBlock.name === "air") continue;

			// エージェントより下の座標は除外
			if (refBlock.position.y < agentY - 1) continue;

			const invalidBlocks = ["water", "lava", "fire", "grass", "tall_grass", "fern", "snow"];
			if (invalidBlocks.includes(refBlock.name)) continue;

			const blockAbove = driver.world.blockAt({
				...refBlock.position,
				y: refBlock.position.y + 1,
			});

			if (blockAbove && blockAbove.name === "air") {
				const dist = Math.abs(dx) + Math.abs(dz);
				candidates.push({ block: refBlock, dist, needsDig: false });
			} else if (blockAbove && isDiggable(blockAbove.name) && blockAbove.diggable) {
				const dist = Math.abs(dx) + Math.abs(dz);
				candidates.push({ block: refBlock, dist, needsDig: true, digTarget: blockAbove });
			}
		}
	}

	candidates.sort((a, b) => a.dist - b.dist);
	return candidates;
}

/**
 * 原木名から板材名を導く (birch_log -> birch_planks)。
 *
 * 接尾辞は末尾でのみ落とす。以前は `/_log|_stem|_wood$/` と書いていて、
 * `$` が最後の選択肢にしか掛からず `_log` はどこにあっても消えていた。
 *
 * 皮を剥いだ原木も同じ板材になる。stripped_ を付けたままだと
 * stripped_oak_planks という存在しない名前を作り、レシピが引けずに
 * 「木は持っているのに板材が作れない」で連鎖が止まる。
 */
function plankNameFromLog(logName: string): string {
	const base = logName.replace(/^stripped_/, "").replace(/(_log|_stem|_wood|_hyphae)$/, "");
	return `${base}_planks`;
}

/** インベントリから最初に見つかった原木を返す。 */
function findLog(agent: MinecraftAgent) {
	return agent.driver.inventory
		.items()
		.find((i) => i.name.endsWith("_log") || i.name.endsWith("_stem") || i.name.endsWith("_wood"));
}

/** インベントリから最初に見つかった板材を返す。 */
function findPlanks(agent: MinecraftAgent) {
	return agent.driver.inventory.items().find((i) => i.name.endsWith("_planks"));
}

/**
 * 板材の合計枚数。種類も山も問わずに数える。
 *
 * findPlanks() は最初の1山しか返さない。樫と白樺を両方持っていると
 * oak_planks:2 と birch_planks:3 が別の山になり、合計5枚あるのに
 * 「2枚しかない」と判定される。作業台は板材4枚だが、板材のレシピは
 * タグ指定なので種類が混ざっていても作れる。数えるときも混ぜて数える。
 *
 * これを1山で見ていたため、材料が足りているのに作業台が用意できず、
 * 木の剣が最後まで作れないことがあった。
 */
export function countPlanks(agent: MinecraftAgent): number {
	return agent.driver.inventory
		.items()
		.filter((i) => i.name.endsWith("_planks"))
		.reduce((sum, i) => sum + i.count, 0);
}

/** 原木の合計本数。1本で板材4枚になる。 */
export function countLogs(agent: MinecraftAgent): number {
	return agent.driver.inventory
		.items()
		.filter((i) => i.name.endsWith("_log") || i.name.endsWith("_stem") || i.name.endsWith("_wood"))
		.reduce((sum, i) => sum + i.count, 0);
}

/** 品目の合計。同じ物が複数スロットに散っていても数え落とさない。 */
export function countItem(agent: MinecraftAgent, name: string): number {
	return agent.driver.inventory
		.items()
		.reduce((sum, i) => (i.name === name ? sum + i.count : sum), 0);
}

/**
 * driver.craft() を安全に呼ぶ。
 *
 * 統合版はサーバーに拒否されると例外を投げる(BedrockDriver.craft は
 * sidecar.send を経由し、送信側が ok:false を reject にしている)。
 * ここの ensureXxx 系はどれもその前提を忘れて素通しにしていたため、
 * 拒否が丸ごと ensureSticks/ensurePlanks の外まで抜け、呼び出し元の
 * crafting.tool / crafting.weapon の try ブロックにも入らずに
 * MinecraftAgent の反射ループまで届いていた。そこでは「aborted」と
 * 誤表記された上で例外を再送出し、指数バックオフ(最大30秒)だけがかかって
 * 同じ拒否を延々と繰り返す。skillStats にも一切残らないので、LLM から見て
 * 「crafting.weapon が失敗し続けている」ことにすら気づけなかった。
 * 失敗は例外ではなく戻り値の false で返し、ここで一度だけログする。
 */
async function tryCraft(
	agent: MinecraftAgent,
	label: string,
	itemName: string,
	count: number,
	craftingTable?: Position,
): Promise<boolean> {
	try {
		await agent.driver.craft(itemName, count, craftingTable);
		return true;
	} catch (err) {
		agent.log(`[${label}] クラフトが拒否された: ${itemName} x${count}: ${err}`);
		return false;
	}
}

/**
 * 共通ロジック：作業台を確保する（周辺スキャン -> 作成 -> 設置）
 * @returns 確保された作業台のブロック、確保失敗時は null
 */
export async function ensureCraftingTable(agent: MinecraftAgent): Promise<BlockInfo | null> {
	const { driver } = agent;

	// 1. 周辺スキャン
	const tableBlock = driver.world.findBlock(["crafting_table"], 4);

	agent.log(`[ensureCraftingTable] Scanning nearby: found=${!!tableBlock}`);
	if (tableBlock) return tableBlock;

	// 2. インベントリ確認
	let tableItem = driver.inventory.items().find((i) => i.name === "crafting_table");
	agent.log(`[ensureCraftingTable] In inventory: found=${!!tableItem}`);

	// 3. なければ作る（原木 -> 板材 -> 作業台）
	if (!tableItem) {
		agent.log(`[ensureCraftingTable] Planks in inventory: total=${countPlanks(agent)}`);

		if (countPlanks(agent) < 4) {
			const logItem = findLog(agent);

			agent.log(
				`[ensureCraftingTable] Logs in inventory: found=${!!logItem}, name=${logItem?.name}`,
			);
			if (!logItem) {
				agent.log(`[ensureCraftingTable] FAIL: No logs`);
				return null;
			}

			const plankItemName = plankNameFromLog(logItem.name);
			const canCraftPlanks = driver.canCraft(plankItemName);
			agent.log(`[ensureCraftingTable] Plank recipe: found=${canCraftPlanks}`);

			if (!canCraftPlanks) {
				agent.log(`[ensureCraftingTable] FAIL: No plank recipe`);
				return null;
			}
			await tryCraft(agent, "ensureCraftingTable", plankItemName, 1);
			agent.log(`[ensureCraftingTable] After crafting planks: total=${countPlanks(agent)}`);
		}

		if (countPlanks(agent) >= 4) {
			const canCraftTable = driver.canCraft("crafting_table");
			agent.log(`[ensureCraftingTable] Table recipe: found=${canCraftTable}`);
			if (canCraftTable) {
				await tryCraft(agent, "ensureCraftingTable", "crafting_table", 1);
			}
			tableItem = driver.inventory.items().find((i) => i.name === "crafting_table");
			agent.log(`[ensureCraftingTable] Crafted table item: found=${!!tableItem}`);
		}
	}

	// 4. 設置する
	if (tableItem) {
		const placed = await tryPlaceBlock(agent, tableItem.name, "crafting_table");
		agent.log(`[ensureCraftingTable] Placed: found=${!!placed}`);
		return placed;
	}

	agent.log(`[ensureCraftingTable] FAIL: Cannot place table`);
	return null;
}

/**
 * 共通ロジック：かまどを確保する（周辺スキャン -> 作成 -> 設置）
 * @returns 確保されたかまどのブロック、確保失敗時は null
 */
export async function ensureFurnace(agent: MinecraftAgent): Promise<BlockInfo | null> {
	const { driver } = agent;

	// 1. 周辺スキャン
	const furnaceBlock = driver.world.findBlock(["furnace"], 4);

	agent.log(`[ensureFurnace] Scanning nearby: found=${!!furnaceBlock}`);
	if (furnaceBlock) return furnaceBlock;

	// 2. インベントリ確認
	let furnaceItem = driver.inventory.items().find((i) => i.name === "furnace");
	agent.log(`[ensureFurnace] In inventory: found=${!!furnaceItem}`);

	// 3. なければ作る（丸石 x 8 -> かまど）
	if (!furnaceItem) {
		// 山ごとではなく合計で数える。丸石が 4+4 の2山に分かれているとき、
		// 最初の山だけを見て「8個に足りない」と判定していた。
		const cobble = countItem(agent, "cobblestone");
		agent.log(`[ensureFurnace] Cobble in inventory: total=${cobble}`);

		// 丸石が8個以上必要
		if (cobble < 8) {
			agent.log(`[ensureFurnace] FAIL: Not enough cobble (need 8)`);
			return null;
		}

		// かまど作成には作業台が必要
		const table = await ensureCraftingTable(agent);
		if (!table) {
			agent.log(`[ensureFurnace] FAIL: No crafting table`);
			return null;
		}

		const canCraftFurnace = driver.canCraft("furnace", table.position);
		agent.log(`[ensureFurnace] Furnace recipe: found=${canCraftFurnace}`);

		if (!canCraftFurnace) return null;

		await tryCraft(agent, "ensureFurnace", "furnace", 1, table.position);
		furnaceItem = driver.inventory.items().find((i) => i.name === "furnace");
		agent.log(`[ensureFurnace] Crafted furnace: found=${!!furnaceItem}`);
	}

	// 4. 設置する
	if (furnaceItem) {
		const placed = await tryPlaceBlock(agent, furnaceItem.name, "furnace");
		agent.log(`[ensureFurnace] Placed: found=${!!placed}`);
		return placed;
	}

	agent.log(`[ensureFurnace] FAIL: Cannot place furnace`);
	return null;
}

/**
 * 共通ロジック：棒を確保する（インベントリ確認 -> 作成）
 * 作業台は不要ですが、材料（板材/原木）がない場合は作成を試みます。
 * @returns 確保成功時は true
 */
export async function ensureSticks(agent: MinecraftAgent, count = 4): Promise<boolean> {
	const { driver } = agent;

	// 1. インベントリ確認。棒も複数の山に分かれうるので合計で見る。
	agent.log(`[ensureSticks] sticks total=${countItem(agent, "stick")}, required=${count}`);
	if (countItem(agent, "stick") >= count) return true;

	// 2. なければ作る（板材 -> 棒）
	let planks = findPlanks(agent);
	agent.log(`[ensureSticks] planks: total=${countPlanks(agent)}`);

	// 板材がない場合は原木から作る（再帰的に板材を確保するようなロジック）
	if (countPlanks(agent) < 2) {
		const logItem = findLog(agent);

		agent.log(
			`[ensureSticks] logs: found=${!!logItem}, name=${logItem?.name}, count=${logItem?.count || 0}`,
		);

		if (!logItem) {
			agent.log(`[ensureSticks] FAIL: No logs in inventory`);
			return false; // 原木もなければ不可
		}

		// 原木の種類に合わせて板材名を作る (birch_log -> birch_planks)
		const plankItemName = plankNameFromLog(logItem.name);
		agent.log(`[ensureSticks] Looking for plank: ${plankItemName}`);
		const canCraftPlanks = driver.canCraft(plankItemName);
		agent.log(`[ensureSticks] plankRecipe: found=${canCraftPlanks}`);

		if (!canCraftPlanks) return false;

		if (!(await tryCraft(agent, "ensureSticks", plankItemName, 1))) return false;
		planks = findPlanks(agent);
		agent.log(
			`[ensureSticks] After crafting planks: found=${!!planks}, count=${planks?.count || 0}`,
		);
	}

	// 3. 棒をクラフト（2枚の板材から4本の棒）
	if (countPlanks(agent) >= 2) {
		// 棒は作業台不要
		const canCraftSticks = driver.canCraft("stick");

		agent.log(`[ensureSticks] stickRecipe: found=${canCraftSticks}`);

		if (canCraftSticks) {
			await tryCraft(agent, "ensureSticks", "stick", Math.ceil(count / 4));
			// 作ったつもりで数を確かめずに true を返していた。クラフトが
			// 弾かれても成功として返るので、呼び出し側は棒があるものとして
			// 剣の作成へ進み、そこで初めて失敗する。実際に増えたかで答える。
			const after = countItem(agent, "stick");
			agent.log(`[ensureSticks] After crafting sticks: total=${after}`);
			return after >= count;
		}
	}

	agent.log(`[ensureSticks] FAIL: Cannot craft sticks`);
	return false;
}

/**
 * 共通ロジック：板材を確保する（原木から変換）
 * @param agent エージェント
 * @param minCount 必要な板材の数
 * @returns 確保成功時は true
 */
export async function ensurePlanks(agent: MinecraftAgent, minCount = 4): Promise<boolean> {
	const { driver } = agent;

	const have = countPlanks(agent);
	if (have >= minCount) {
		agent.log(`[ensurePlanks] Already have enough planks: ${have}`);
		return true;
	}
	agent.log(`[ensurePlanks] Have ${have} planks, need ${minCount}`);

	agent.log(
		`[ensurePlanks] Current inventory: ${driver.inventory
			.items()
			.map((i) => `${i.name}:${i.count}`)
			.join(", ")}`,
	);

	const logItem = findLog(agent);

	if (!logItem) {
		agent.log(
			`[ensurePlanks] FAIL: No logs in inventory, and not enough planks (have ${have}, need ${minCount})`,
		);
		return false;
	}

	// 原木の種類に合わせて板材名を作る
	const plankItemName = plankNameFromLog(logItem.name);

	agent.log(`[ensurePlanks] Converting ${logItem.name} to ${plankItemName}`);

	if (!driver.canCraft(plankItemName)) {
		agent.log(`[ensurePlanks] FAIL: No recipe for ${plankItemName}`);
		return false;
	}

	// 足りないぶんだけ作る。1原木 = 板材4枚。
	// 既に持っているぶんを引かずに minCount 全部を作ろうとしていたので、
	// 原木を余計に潰していた。
	const logsNeeded = Math.ceil((minCount - have) / 4);
	await tryCraft(agent, "ensurePlanks", plankItemName, Math.max(1, logsNeeded));

	const after = countPlanks(agent);
	agent.log(`[ensurePlanks] After crafting: total=${after}`);

	return after >= minCount;
}

/**
 * 共通ロジック：チェストを確保する（周辺スキャン -> 作成 -> 設置）
 * @returns 確保されたチェストのブロック、確保失敗時は null
 */
export async function ensureChest(agent: MinecraftAgent): Promise<BlockInfo | null> {
	const { driver } = agent;

	// 1. 周辺スキャン
	const chestBlock = driver.world.findBlock(["chest"], 4);

	agent.log(`[ensureChest] Scanning nearby: found=${!!chestBlock}`);
	if (chestBlock) return chestBlock;

	// 2. インベントリ確認
	let chestItem = driver.inventory.items().find((i) => i.name === "chest");
	agent.log(`[ensureChest] In inventory: found=${!!chestItem}`);

	// 3. なければ作る（板材 x 8 -> チェスト）
	if (!chestItem) {
		// 板材はタグ指定なので種類が混ざっていても作れる。数えるときも
		// 山ごとではなく合計で見る。樫4枚と白樺4枚を持っているとき、
		// 山で見ると8枚あるのに「足りない」と判定していた。
		agent.log(`[ensureChest] Planks in inventory: total=${countPlanks(agent)}`);

		if (countPlanks(agent) < 8) {
			agent.log(`[ensureChest] Not enough planks (need 8)`);
			const ensured = await ensurePlanks(agent, 8);
			if (!ensured) {
				agent.log(`[ensureChest] FAIL: Could not ensure planks`);
				return null;
			}
		}

		if (countPlanks(agent) >= 8) {
			const table = await ensureCraftingTable(agent);
			if (!table) {
				agent.log(`[ensureChest] FAIL: No crafting table`);
				return null;
			}

			const canCraftChest = driver.canCraft("chest", table.position);
			agent.log(`[ensureChest] Chest recipe: found=${canCraftChest}`);

			if (!canCraftChest) return null;

			await tryCraft(agent, "ensureChest", "chest", 1, table.position);
			chestItem = driver.inventory.items().find((i) => i.name === "chest");
			agent.log(`[ensureChest] Crafted chest: found=${!!chestItem}`);
		}
	}

	// 4. 設置する
	if (chestItem) {
		const placed = await tryPlaceBlock(agent, chestItem.name, "chest");
		agent.log(`[ensureChest] Placed: found=${!!placed}`);
		return placed;
	}

	agent.log(`[ensureChest] FAIL: Cannot place chest`);
	return null;
}
