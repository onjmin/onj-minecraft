import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { MinecraftAgent } from "../../core/agent";

type Block = NonNullable<ReturnType<Bot["blockAt"]>>;

interface PlaceableBlock extends Block {
	_needsDig?: boolean;
	_digTarget?: Block;
}

/**
 * 設置を試みる（複数の位置でリトライ）
 * 候補が埋まっている場合は、掘ってでも設置を試みる
 */
export async function tryPlaceBlock(
	bot: Bot,
	itemName: string,
	blockId: number,
	agent: MinecraftAgent,
	targetPos?: Vec3,
): Promise<Block | null> {
	let positions: PlaceableBlock[];
	if (targetPos) {
		const block = bot.blockAt(targetPos.offset(0, -1, 0)); // 下のブロックを土台にする
		if (!block) return null;
		positions = [block as PlaceableBlock];
	} else {
		positions = findAllPlaceablePositions(bot) as PlaceableBlock[];
	}
	agent.log(`[tryPlaceBlock] Found ${positions.length} positions`);

	if (positions.length === 0) {
		agent.log(`[tryPlaceBlock] No placeable positions found!`);
		return null;
	}

	const item = bot.inventory.items().find((i) => i.name === itemName);
	if (!item) {
		agent.log(`[tryPlaceBlock] Item not found in inventory: ${itemName}`);
		return null;
	}
	agent.log(`[tryPlaceBlock] Item found: ${item.name}, count=${item.count}`);

	for (const refBlock of positions) {
		agent.log(
			`[tryPlaceBlock] Trying at ${refBlock.position}, ref=${refBlock.name}, needsDig=${refBlock._needsDig}`,
		);

		try {
			await bot.equip(item, "hand");
			agent.log(`[tryPlaceBlock] Equipped ${item.name}`);

			await new Promise((r) => setTimeout(r, 500));

			if (refBlock._needsDig && refBlock._digTarget) {
				agent.log(`[tryPlaceBlock] Digging blocking block: ${refBlock._digTarget.name}`);
				const toolPlugin = (bot as any).tool;
				if (toolPlugin) {
					await toolPlugin.equipForBlock(refBlock._digTarget);
				}
				await bot.dig(refBlock._digTarget);
				await new Promise((r) => setTimeout(r, 500));
			}

			try {
				await bot.placeBlock(refBlock, new Vec3(0, 1, 0));
				agent.log(`[tryPlaceBlock] placeBlock returned`);
			} catch (placeErr) {
				agent.log(`[tryPlaceBlock] placeBlock error: ${placeErr}`);
				continue;
			}

			await new Promise((r) => setTimeout(r, 500));
			const placed = bot.findBlock({
				matching: blockId,
				maxDistance: 4,
			});

			if (placed) {
				agent.log(`[tryPlaceBlock] SUCCESS at ${refBlock.position}`);
				return placed;
			} else {
				agent.log(`[tryPlaceBlock] Block not found after placement`);
			}
		} catch (e) {
			agent.log(`[tryPlaceBlock] Error at ${refBlock.position}: ${e}`);
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
export function findAllPlaceablePositions(bot: Bot): Block[] {
	const candidates: { block: Block; dist: number; needsDig: boolean; digTarget?: Block }[] = [];
	const agentY = Math.floor(bot.entity.position.y);

	for (let dx = -3; dx <= 3; dx++) {
		for (let dz = -3; dz <= 3; dz++) {
			if (dx === 0 && dz === 0) continue;

			const refBlock = bot.blockAt(bot.entity.position.offset(dx, -1, dz));
			if (!refBlock || refBlock.name === "air") continue;

			// エージェントより下の座標は除外
			if (refBlock.position.y < agentY - 1) continue;

			const invalidBlocks = ["water", "lava", "fire", "grass", "tall_grass", "fern", "snow"];
			if (invalidBlocks.includes(refBlock.name)) continue;

			const blockAbove = bot.blockAt(refBlock.position.offset(0, 1, 0));

			if (blockAbove && blockAbove.name === "air") {
				const dist = Math.abs(dx) + Math.abs(dz);
				candidates.push({ block: refBlock, dist, needsDig: false });
			} else if (blockAbove && isDiggable(blockAbove.name) && bot.canDigBlock(blockAbove)) {
				const dist = Math.abs(dx) + Math.abs(dz);
				candidates.push({ block: refBlock, dist, needsDig: true, digTarget: blockAbove });
			}
		}
	}

	candidates.sort((a, b) => a.dist - b.dist);
	return candidates.map((c) => ({
		...c.block,
		_needsDig: c.needsDig,
		_digTarget: c.digTarget,
	})) as unknown as Block[];
}

/**
 * 共通ロジック：作業台を確保する（周辺スキャン -> 作成 -> 設置）
 * @returns 確保された作業台のBlockオブジェクト、確保失敗時は null
 */
export async function ensureCraftingTable(agent: MinecraftAgent): Promise<Block | null> {
	const { bot } = agent;

	// 1. 周辺スキャン
	const tableBlock = bot.findBlock({
		matching: bot.registry.blocksByName.crafting_table.id,
		maxDistance: 4,
	});

	agent.log(`[ensureCraftingTable] Scanning nearby: found=${!!tableBlock}`);
	if (tableBlock) return tableBlock;

	// 2. インベントリ確認
	let tableItem = bot.inventory.items().find((i) => i.name === "crafting_table");
	agent.log(`[ensureCraftingTable] In inventory: found=${!!tableItem}`);

	// 3. なければ作る（原木 -> 板材 -> 作業台）
	if (!tableItem) {
		let planks = bot.inventory.items().find((i) => i.name.endsWith("_planks"));
		agent.log(
			`[ensureCraftingTable] Planks in inventory: found=${!!planks}, count=${planks?.count || 0}`,
		);

		if (!planks || planks.count < 4) {
			const logItem = bot.inventory
				.items()
				.find(
					(i) => i.name.endsWith("_log") || i.name.endsWith("_stem") || i.name.endsWith("_wood"),
				);

			agent.log(
				`[ensureCraftingTable] Logs in inventory: found=${!!logItem}, name=${logItem?.name}`,
			);
			if (!logItem) {
				agent.log(`[ensureCraftingTable] FAIL: No logs`);
				return null;
			}

			const logBaseName = logItem.name.replace(/_log|_stem|_wood$/, "");
			const plankItemName = `${logBaseName}_planks`;
			const plankItem = bot.registry.itemsByName[plankItemName];
			const recipes = bot.recipesFor(plankItem?.id, null, 1, null);
			agent.log(`[ensureCraftingTable] Plank recipes: count=${recipes.length}`);

			const plankRecipe = recipes[0];
			if (!plankRecipe) {
				agent.log(`[ensureCraftingTable] FAIL: No plank recipe`);
				return null;
			}
			await bot.craft(plankRecipe, 1);
			planks = bot.inventory.items().find((i) => i.name.endsWith("_planks"));
			agent.log(`[ensureCraftingTable] After crafting planks: count=${planks?.count || 0}`);
		}

		if (planks && planks.count >= 4) {
			const tableRecipe = bot.recipesFor(
				bot.registry.itemsByName.crafting_table.id,
				null,
				1,
				null,
			)[0];
			agent.log(`[ensureCraftingTable] Table recipe: found=${!!tableRecipe}`);
			await bot.craft(tableRecipe, 1);
			tableItem = bot.inventory.items().find((i) => i.name === "crafting_table");
			agent.log(`[ensureCraftingTable] Crafted table item: found=${!!tableItem}`);
		}
	}

	// 4. 設置する
	if (tableItem) {
		const placed = await tryPlaceBlock(
			bot,
			tableItem.name,
			bot.registry.blocksByName.crafting_table.id,
			agent,
		);
		agent.log(`[ensureCraftingTable] Placed: found=${!!placed}`);
		return placed;
	}

	agent.log(`[ensureCraftingTable] FAIL: Cannot place table`);
	return null;
}

/**
 * 共通ロジック：かまどを確保する（周辺スキャン -> 作成 -> 設置）
 * @returns 確保されたかまどのBlockオブジェクト、確保失敗時は null
 */
export async function ensureFurnace(agent: MinecraftAgent): Promise<Block | null> {
	const { bot } = agent;

	// 1. 周辺スキャン
	const furnaceBlock = bot.findBlock({
		matching: bot.registry.blocksByName.furnace.id,
		maxDistance: 4,
	});

	agent.log(`[ensureFurnace] Scanning nearby: found=${!!furnaceBlock}`);
	if (furnaceBlock) return furnaceBlock;

	// 2. インベントリ確認
	let furnaceItem = bot.inventory.items().find((i) => i.name === "furnace");
	agent.log(`[ensureFurnace] In inventory: found=${!!furnaceItem}`);

	// 3. なければ作る（丸石 x 8 -> かまど）
	if (!furnaceItem) {
		const cobble = bot.inventory.items().find((i) => i.name === "cobblestone");
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

		const furnaceRecipe = bot.recipesFor(bot.registry.itemsByName.furnace.id, null, 1, table)[0];
		agent.log(`[ensureFurnace] Furnace recipe: found=${!!furnaceRecipe}`);

		if (!furnaceRecipe) return null;

		await bot.craft(furnaceRecipe, 1, table);
		furnaceItem = bot.inventory.items().find((i) => i.name === "furnace");
		agent.log(`[ensureFurnace] Crafted furnace: found=${!!furnaceItem}`);
	}

	// 4. 設置する
	if (furnaceItem) {
		const placed = await tryPlaceBlock(
			bot,
			furnaceItem.name,
			bot.registry.blocksByName.furnace.id,
			agent,
		);
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
	const { bot } = agent;

	// 1. インベントリ確認
	const sticks = bot.inventory.items().find((i) => i.name === "stick");
	agent.log(
		`[ensureSticks] sticks found=${!!sticks}, count=${sticks?.count || 0}, required=${count}`,
	);
	if (sticks && sticks.count >= count) return true;

	// 2. なければ作る（板材 -> 棒）
	let planks = bot.inventory.items().find((i) => i.name.endsWith("_planks"));
	agent.log(`[ensureSticks] planks: found=${!!planks}, count=${planks?.count || 0}`);

	// 板材がない場合は原木から作る（再帰的に板材を確保するようなロジック）
	if (!planks || planks.count < 2) {
		const logItem = bot.inventory
			.items()
			.find((i) => i.name.endsWith("_log") || i.name.endsWith("_stem") || i.name.endsWith("_wood"));

		agent.log(
			`[ensureSticks] logs: found=${!!logItem}, name=${logItem?.name}, count=${logItem?.count || 0}`,
		);

		if (!logItem) {
			agent.log(`[ensureSticks] FAIL: No logs in inventory`);
			return false; // 原木もなければ不可
		}

		// 原木の種類に合わせて板材名を作る (birch_log -> birch_planks)
		const logBaseName = logItem.name.replace(/_log|_stem|_wood$/, "");
		const plankItemName = `${logBaseName}_planks`;
		agent.log(`[ensureSticks] Looking for plank: ${plankItemName}`);
		const plankItem = bot.registry.itemsByName[plankItemName];
		agent.log(`[ensureSticks] plankItem: ${plankItem?.name}, id=${plankItem?.id}`);
		const recipes = bot.recipesFor(plankItem?.id, null, 1, null);
		agent.log(`[ensureSticks] Found ${recipes.length} plank recipes, idUsed=${plankItem?.id}`);

		const plankRecipe = recipes[0];

		agent.log(`[ensureSticks] plankRecipe: found=${!!plankRecipe}`);
		if (!plankRecipe) return false;

		await bot.craft(plankRecipe, 1);
		planks = bot.inventory.items().find((i) => i.name.endsWith("_planks"));
		agent.log(
			`[ensureSticks] After crafting planks: found=${!!planks}, count=${planks?.count || 0}`,
		);
	}

	// 3. 棒をクラフト（2枚の板材から4本の棒）
	if (planks && planks.count >= 2) {
		const stickRecipe = bot.recipesFor(
			bot.registry.itemsByName.stick.id,
			null,
			1,
			null, // 棒は作業台不要
		)[0];

		agent.log(`[ensureSticks] stickRecipe: found=${!!stickRecipe}`);

		if (stickRecipe) {
			await bot.craft(stickRecipe, Math.ceil(count / 4));
			const sticksAfter = bot.inventory.items().find((i) => i.name === "stick");
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
	const { bot } = agent;

	const planks = bot.inventory.items().find((i) => i.name.endsWith("_planks"));
	if (planks && planks.count >= minCount) {
		agent.log(`[ensurePlanks] Already have enough planks: ${planks.count}`);
		return true;
	}

	if (planks) {
		agent.log(`[ensurePlanks] Already have some planks: ${planks.count}, need ${minCount}`);
	}

	agent.log(
		`[ensurePlanks] Current inventory: ${bot.inventory
			.items()
			.map((i) => `${i.name}:${i.count}`)
			.join(", ")}`,
	);

	const logItem = bot.inventory
		.items()
		.find((i) => i.name.endsWith("_log") || i.name.endsWith("_stem") || i.name.endsWith("_wood"));

	if (!logItem) {
		agent.log(
			`[ensurePlanks] FAIL: No logs in inventory, and not enough planks (have ${planks?.count || 0}, need ${minCount})`,
		);
		return false;
	}

	// 原木の種類に合わせて板材名を作る
	const logBaseName = logItem.name.replace(/_log|_stem|_wood$/, "");
	const plankItemName = `${logBaseName}_planks`;
	const plankItem = bot.registry.itemsByName[plankItemName];

	agent.log(`[ensurePlanks] Converting ${logItem.name} to ${plankItemName}`);

	const recipes = bot.recipesFor(plankItem?.id, null, 1, null);
	if (recipes.length === 0) {
		agent.log(`[ensurePlanks] FAIL: No recipe for ${plankItemName}`);
		return false;
	}

	// 必要な板材の数に合わせて原木の数を変える（1原木 = 4板材）
	const logsNeeded = Math.ceil(minCount / 4);
	await bot.craft(recipes[0], logsNeeded);

	const planksAfter = bot.inventory.items().find((i) => i.name.endsWith("_planks"));
	agent.log(`[ensurePlanks] After crafting: count=${planksAfter?.count || 0}`);

	return Boolean(planksAfter && planksAfter.count >= minCount);
}

/**
 * 共通ロジック：チェストを確保する（周辺スキャン -> 作成 -> 設置）
 * @returns 確保されたチェストのBlockオブジェクト、確保失敗時は null
 */
export async function ensureChest(agent: MinecraftAgent): Promise<Block | null> {
	const { bot } = agent;

	// 1. 周辺スキャン
	const chestBlock = bot.findBlock({
		matching: bot.registry.blocksByName.chest.id,
		maxDistance: 4,
	});

	agent.log(`[ensureChest] Scanning nearby: found=${!!chestBlock}`);
	if (chestBlock) return chestBlock;

	// 2. インベントリ確認
	let chestItem = bot.inventory.items().find((i) => i.name === "chest");
	agent.log(`[ensureChest] In inventory: found=${!!chestItem}`);

	// 3. なければ作る（板材 x 8 -> チェスト）
	if (!chestItem) {
		let planks = bot.inventory.items().find((i) => i.name.endsWith("_planks"));
		agent.log(
			`[ensureChest] Planks in inventory: found=${!!planks}, count=${planks?.count || 0}`,
		);

		if (!planks || planks.count < 8) {
			agent.log(`[ensureChest] Not enough planks (need 8)`);
			const ensured = await ensurePlanks(agent, 8);
			if (!ensured) {
				agent.log(`[ensureChest] FAIL: Could not ensure planks`);
				return null;
			}
			planks = bot.inventory.items().find((i) => i.name.endsWith("_planks"));
		}

		if (planks && planks.count >= 8) {
			const table = await ensureCraftingTable(agent);
			if (!table) {
				agent.log(`[ensureChest] FAIL: No crafting table`);
				return null;
			}

			const chestRecipe = bot.recipesFor(
				bot.registry.itemsByName.chest.id,
				null,
				1,
				table,
			)[0];
			agent.log(`[ensureChest] Chest recipe: found=${!!chestRecipe}`);

			if (!chestRecipe) return null;

			await bot.craft(chestRecipe, 1, table);
			chestItem = bot.inventory.items().find((i) => i.name === "chest");
			agent.log(`[ensureChest] Crafted chest: found=${!!chestItem}`);
		}
	}

	// 4. 設置する
	if (chestItem) {
		const placed = await tryPlaceBlock(
			bot,
			chestItem.name,
			bot.registry.blocksByName.chest.id,
			agent,
		);
		agent.log(`[ensureChest] Placed: found=${!!placed}`);
		return placed;
	}

	agent.log(`[ensureChest] FAIL: Cannot place chest`);
	return null;
}
