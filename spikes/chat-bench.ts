/**
 * 会話モデルの比較。ローカルに入っているモデルへ同じ会話を投げ、返事を並べる。
 *
 * 「どのモデルが会話に向いているか」は、想像ではなく実際の返事で決める。
 * 使い方:
 *   npx tsx spikes/chat-bench.ts                       # 既定の候補すべて
 *   npx tsx spikes/chat-bench.ts qwen/qwen3.6-27b      # モデルを指定
 *
 * LM Studio は要求されたモデルを都度ロードするので、初回は数十秒かかる。
 */
import { type ChatSituation, Conversation } from "../src/core/conversation";
import { kusabot } from "../src/profiles/kusabot";

const DEFAULT_MODELS = [
	"devstral-small-2-24b-instruct-2512",
	"qwen/qwen3.6-27b",
	"google/gemma-4-26b-a4b-qat",
	"glm-4.7-flash",
];

/** 本番で起きたやり取りに近い状況を作る。 */
const SITUATION: ChatSituation = {
	position: { x: -84, y: 65, z: 91 },
	biome: "taiga",
	timeOfDay: "sunrise",
	health: 20,
	hunger: 18,
	inventorySummary: "cobblestone x2, spruce_sapling x3",
	currentTask: "exploring.explore_land",
	recentResults: [
		"goto.surface: Success (Already on the surface at Y=65)",
		"collecting.wood: Fail (No trees within reach)",
		"exploring.explore_land: Success (Moved 18 blocks)",
	],
	skillNames: [
		"exploring.explore_land",
		"goto.surface",
		"goto.coords",
		"goto.player",
		"collecting.wood",
		"collecting.stone",
		"collecting.mining",
		"crafting.tool",
		"building.base",
	],
	nearbyPlayers: ["onjmin"],
};

/** 順に投げる発言。会話が続くか、依頼を拾えるかを見る。 */
const SCRIPT = [
	"やっほー、今なにしてるの？",
	"木が見つからないの？ 座標どこ？",
	"じゃあ石のツルハシ作っといて",
	"ところで空って飛べる？",
	"さっきの話だけど、今どこにいるって言ったっけ",
];

async function run(model: string) {
	const conversation = new Conversation(kusabot, model);
	console.log(`\n${"=".repeat(70)}\n${model}\n${"=".repeat(70)}`);

	for (const line of SCRIPT) {
		conversation.record("onjmin", line, false);
		const started = Date.now();
		try {
			const { reply, request } = await conversation.respond(SITUATION);
			const sec = ((Date.now() - started) / 1000).toFixed(1);
			console.log(`<onjmin> ${line}`);
			console.log(`<kusabot> ${reply || "(黙る)"}   [${sec}s]`);
			if (request) console.log(`         依頼として拾った: ${request}`);
			if (reply) conversation.record("kusabot", reply, true);
		} catch (err) {
			console.log(`<onjmin> ${line}`);
			console.log(`  ERROR: ${err}`);
			return;
		}
	}
}

async function main() {
	const models = process.argv.slice(2);
	for (const model of models.length > 0 ? models : DEFAULT_MODELS) {
		await run(model);
	}
}

void main();
