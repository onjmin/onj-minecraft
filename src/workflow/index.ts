import { Agent } from "../core/agent";
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
 * Agent profiles for the simulation (Project Sid style)
 * シミュレーション用のエージェントプロフィール
 */
const profiles = [
	{ name: "onj_miner", personality: "Obsessed with mining ores and deep exploration." },
	{ name: "onj_farmer", personality: "Finds joy in tending crops and ensuring food security." },
	{ name: "onj_destroyer", personality: "Wants to break everything in sight and cause chaos." },
];

/**
 * Initialize and start all agents
 * 全てのエージェントを初期化して起動
 */
const agents = profiles.map((p) => {
	// Pass the tool list to the orchestrator
	// オーケストレーターにツールリストを渡してインスタンス化
	return new Agent(p, allTools);
});

console.log(`Started ${agents.length} agents.`);
