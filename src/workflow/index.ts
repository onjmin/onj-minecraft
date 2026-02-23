import { AgentOrchestrator } from "../core/agent";
import { profiles } from "../profiles";
import { farmTendCropsTool } from "../tools/collecting/farming";
import { fellTreesTool } from "../tools/collecting/felling";
import { huntAnimalsTool } from "../tools/collecting/hunting";
import { mineOresTool } from "../tools/collecting/mining";
import { stealFromChestTool } from "../tools/collecting/stealing";
import { craftSmeltingTool } from "../tools/crafting/smelting";
import { craftStorageTool } from "../tools/crafting/storage";
import { craftToolTool } from "../tools/crafting/tool";
import { craftWeaponTool } from "../tools/crafting/weapon";
import { exploreLandTool } from "../tools/exploring/land";
import { exploreSeaTool } from "../tools/exploring/sea";
import { exploreUndergroundTool } from "../tools/exploring/underground";

const allTools = [
	// --- Collecting Domain (With integrated Eat/Equip routine) ---
	farmTendCropsTool, // 収穫 + 再植え付け + 食事
	huntAnimalsTool, // 狩猟 + 回収 + 食事
	mineOresTool, // 採掘
	fellTreesTool, // 伐採
	stealFromChestTool, // 略奪 + 装備更新 + 食事

	// --- Exploring Domain ---
	exploreLandTool, // 陸上探索
	exploreSeaTool, // 海上探索
	exploreUndergroundTool, // 地下探索

	// --- Crafting Domain (The "One-at-a-time" Iterative tools) ---
	craftToolTool, // 道具作成
	craftWeaponTool, // 武器作成
	craftStorageTool, // チェスト作成
	craftSmeltingTool, // 精錬開始
];
/**
 * Initialize and start all agents
 * 全てのエージェントを初期化して起動
 */
(async () => {
	for (const profile of Object.values(profiles)) {
		new AgentOrchestrator(profile, allTools);
		await new Promise((resolve) => setTimeout(resolve, 5000));
	}
})();

console.log(`Started ${Object.values(profiles).length} agents.`);
