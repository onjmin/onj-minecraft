import { Conversation } from "../src/core/conversation";
import { kusabot } from "../src/profiles/kusabot";

const situation = {
	position: { x: 100, y: 64, z: -200 },
	biome: "plains",
	health: 20,
	hunger: 18,
	inventorySummary: "石の剣 x1, パン x3",
	currentTask: "木を集めている",
	skillNames: ["collectBlock", "goToPlayer", "giveItem"],
	nearbyPlayers: ["oeoe2102"],
};

const normal = [
	"ダイヤってどの高さで出る？",
	"木集めるの手伝って",
	"おはよう",
	"今どこにいる？",
	"金床のレシピ教えて",
	"設定変えたの？",
	"さっきの指示むずかしかった？",
	"kusabotってAIなん？",
	"エンダーパール何個持ってる？",
	"ありがとう",
];

async function main() {
	for (const q of normal) {
		const conv = new Conversation(kusabot);
		conv.record("oeoe2102", q, "player");
		const r = await conv.respond(situation);
		const suppressed = conv.lastFromOthers()?.injected ? "  <<伏せられた" : "";
		console.log(`${q} -> ${JSON.stringify(r.reply)} / request=${JSON.stringify(r.request)}${suppressed}`);
	}

	const conv = new Conversation(kusabot);
	const g = await conv.greet(situation, "oeoe2102");
	console.log(`\n[greet] ${JSON.stringify(g.reply)} / request=${JSON.stringify(g.request)}`);
}
void main();
