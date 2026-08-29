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

/** 原木名から板材名を導く (birch_log -> birch_planks)。 */
function plankNameFromLog(logName: string): string {
	return `${logName.replace(/_log|_stem|_wood$/, "")}_planks`;
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
		let planks = findPlanks(agent);
		agent.log(
			`[ensureCraftingTable] Planks in inventory: found=${!!planks}, count=${planks?.count || 0}`,
		);

		if (!planks || planks.count < 4) {
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
			await driver.craft(plankItemName, 1);
			planks = findPlanks(agent);
			agent.log(`[ensureCraftingTable] After crafting planks: count=${planks?.count || 0}`);
		}

		if (planks && planks.count >= 4) {
			const canCraftTable = driver.canCraft("crafting_table");
			agent.log(`[ensureCraftingTable] Table recipe: found=${canCraftTable}`);
			if (canCraftTable) {
				await driver.craft("crafting_table", 1);
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
		const cobble = driver.inventory.items().find((i) => i.name === "cobblestone");
		agent.log(
			`[ensureFurnace] Cobble in inventory: found=${!!cobble}, count=${cobble?.count || 0}`,
		);

		// 丸石が8個以上必要
		if (!cobble || cobble.count < 8) {
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

		await driver.craft("furnace", 1, table.position);
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

	// 1. インベントリ確認
	const sticks = driver.inventory.items().find((i) => i.name === "stick");
	agent.log(
		`[ensureSticks] sticks found=${!!sticks}, count=${sticks?.count || 0}, required=${count}`,
	);
	if (sticks && sticks.count >= count) return true;

	// 2. なければ作る（板材 -> 棒）
	let planks = findPlanks(agent);
	agent.log(`[ensureSticks] planks: found=${!!planks}, count=${planks?.count || 0}`);

	// 板材がない場合は原木から作る（再帰的に板材を確保するようなロジック）
	if (!planks || planks.count < 2) {
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

		await driver.craft(plankItemName, 1);
		planks = findPlanks(agent);
		agent.log(
			`[ensureSticks] After crafting planks: found=${!!planks}, count=${planks?.count || 0}`,
		);
	}

	// 3. 棒をクラフト（2枚の板材から4本の棒）
	if (planks && planks.count >= 2) {
		// 棒は作業台不要
		const canCraftSticks = driver.canCraft("stick");

		agent.log(`[ensureSticks] stickRecipe: found=${canCraftSticks}`);

		if (canCraftSticks) {
			await driver.craft("stick", Math.ceil(count / 4));
			const sticksAfter = driver.inventory.items().find((i) => i.name === "stick");
			agent.log(`[ensureSticks] After crafting sticks: count=${sticksAfter?.count || 0}`);
			agent.log(`[ensureSticks] SUCCESS: Crafted sticks`);
			return true;
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

	const planks = findPlanks(agent);
	if (planks && planks.count >= minCount) {
		agent.log(`[ensurePlanks] Already have enough planks: ${planks.count}`);
		return true;
	}

	if (planks) {
		agent.log(`[ensurePlanks] Already have some planks: ${planks.count}, need ${minCount}`);
	}

	agent.log(
		`[ensurePlanks] Current inventory: ${driver.inventory
			.items()
			.map((i) => `${i.name}:${i.count}`)
			.join(", ")}`,
	);

	const logItem = findLog(agent);

	if (!logItem) {
		agent.log(
			`[ensurePlanks] FAIL: No logs in inventory, and not enough planks (have ${planks?.count || 0}, need ${minCount})`,
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

	// 必要な板材の数に合わせて原木の数を変える（1原木 = 4板材）
	const logsNeeded = Math.ceil(minCount / 4);
	await driver.craft(plankItemName, logsNeeded);

	const planksAfter = findPlanks(agent);
	agent.log(`[ensurePlanks] After crafting: count=${planksAfter?.count || 0}`);

	return Boolean(planksAfter && planksAfter.count >= minCount);
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
		let planks = findPlanks(agent);
		agent.log(`[ensureChest] Planks in inventory: found=${!!planks}, count=${planks?.count || 0}`);

		if (!planks || planks.count < 8) {
			agent.log(`[ensureChest] Not enough planks (need 8)`);
			const ensured = await ensurePlanks(agent, 8);
			if (!ensured) {
				agent.log(`[ensureChest] FAIL: Could not ensure planks`);
				return null;
			}
			planks = findPlanks(agent);
		}

		if (planks && planks.count >= 8) {
			const table = await ensureCraftingTable(agent);
			if (!table) {
				agent.log(`[ensureChest] FAIL: No crafting table`);
				return null;
			}

			const canCraftChest = driver.canCraft("chest", table.position);
			agent.log(`[ensureChest] Chest recipe: found=${canCraftChest}`);

			if (!canCraftChest) return null;

			await driver.craft("chest", 1, table.position);
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
