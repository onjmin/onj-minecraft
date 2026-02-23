import { AgentOrchestrator } from "../core/agent";
import { profiles } from "../profiles";
import { farmTendCropsTool } from "../tools/collecting/farming";
import { fellTreesTool } from "../tools/collecting/felling";
import { huntAnimalsTool } from "../tools/collecting/hunting";
import { mineOresTool } from "../tools/collecting/mining";
import { exploreLandTool } from "../tools/exploring/land";
import { exploreSeaTool } from "../tools/exploring/sea";
import { exploreUndergroundTool } from "../tools/exploring/underground";
import { eatFoodTool } from "../tools/maintenance/life";

const allTools = [
	farmTendCropsTool,
	huntAnimalsTool,
	mineOresTool,
	fellTreesTool,
	exploreLandTool,
	exploreSeaTool,
	exploreUndergroundTool,
	eatFoodTool,
];

/**
 * Initialize and start all agents
 * 全てのエージェントを初期化して起動
 */
(async () => {
	for (const profile of Object.values(profiles)) {
		new AgentOrchestrator(profile, allTools);
		await new Promise((resolve) => setTimeout(resolve, 3000));
	}
})();

console.log(`Started ${Object.values(profiles).length} agents.`);
