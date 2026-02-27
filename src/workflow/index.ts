import { AgentOrchestrator } from "../core/agent";
import { profiles } from "../profiles";
import { farmTendCropsTool } from "../skills/collecting/farming";
import { fellTreesTool } from "../skills/collecting/felling";
import { huntAnimalsTool } from "../skills/collecting/hunting";
import { mineOresTool } from "../skills/collecting/mining";
import { stealFromChestTool } from "../skills/collecting/stealing";
import { craftSmeltingTool } from "../skills/crafting/smelting";
import { craftStorageTool } from "../skills/crafting/storage";
import { craftToolTool } from "../skills/crafting/tool";
import { craftWeaponTool } from "../skills/crafting/weapon";
import { exploreLandTool } from "../skills/exploring/land";
import { exploreSeaTool } from "../skills/exploring/sea";
import { exploreUndergroundTool } from "../skills/exploring/underground";

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
