/**
 * ローカルの開発サーバーで、決まった状況を作ってエージェントを回し、採点する。
 *
 * これまで変更の確認は「本番 Realm で8時間動かして、ログを目で読む」しか
 * 無かった。世界も時刻も湧きも毎回違うので、良くなったのか運が良かったのか
 * 区別できない。しかも1回の確認に8時間かかるので、変更の方が速く積み上がる。
 * 3週間半で判断コードが3倍に増え、死亡率が動かなかったのは、確かめ方の
 * 問題でもある。確かめられない変更は、確かめられる場所(コードの分岐)へ逃げる。
 *
 * ここは「本番へ繋ぐ前に通す関門」。状況はサーバーのコンソールコマンドで
 * 作る(時刻・地形・持ち物・満腹度)。世界の細部までは固定できないが、
 *   - 制御ループの壊れ方(止まる・握りっぱなし・空振りし続ける)
 *   - 状況を LLM が読んで、正しい行動に辿り着けるか
 * はここで捕まる。
 *
 * 実行:
 *   docker compose -f docker-compose.bedrock-dev.yml up -d
 *   pnpm scenario                                  # baseline: 何もせず10分
 *   SCENARIO=night-underground pnpm scenario       # 夜、地下20マスの石室から地上へ出られるか
 *   SCENARIO=raw-food pnpm scenario                # 生肉あり・かまど無しから食事に至れるか
 *   SCENARIO=cobble pnpm scenario                  # ツルハシ持ちで丸石8個を集められるか(掘り→拾得)
 *   SCENARIO=wood-tool pnpm scenario               # 素手・昼・木が近くにある状態から、原木を得て木の道具/剣を作れるか
 *   SCENARIO_MINUTES=15 SCENARIO=raw-food pnpm scenario
 *
 * 本番 Realm には繋がない。接続先はローカル固定にしてある。
 * サーバーへのコマンドは docker exec … send-command で送る。Windows では
 * Docker が WSL 側にいるので wsl 経由になる。
 */
import { execFileSync } from "node:child_process";
import { MinecraftAgent } from "../core/agent";
import { BedrockDriver } from "../core/driver/bedrock";
import type { BotDriver } from "../core/driver/types";
import { kusabot } from "../profiles/kusabot";
import { bedrockSkills } from "./bedrock-skills";

const ADDRESS = process.env.BEDROCK_ADDRESS ?? "127.0.0.1:19132";
// Windows から WSL の Docker へは UDP が転送されないため、既定で WSL 経由にする。
const VIA_WSL = (process.env.BEDROCK_WSL ?? (process.platform === "win32" ? "1" : "0")) === "1";
const CONTAINER = process.env.BEDROCK_DEV_CONTAINER ?? "onj-bedrock-dev";
const BOT_NAME = process.env.SCENARIO_BOT ?? "scenariobot";
const SCENARIO = process.env.SCENARIO ?? "baseline";

/**
 * 合格の条件(ループの健全性)。どの状況でも共通に見る。
 *
 * 「何回死んだか」は湧き方で変わるので、ここでは落第の理由にしない。
 */
const THRESHOLDS = {
	/** スキルが1つも動かない時間の上限。停止の検知。 */
	longestStallMs: Number(process.env.MAX_STALL_MS ?? 5 * 60_000),
	/** 反射が担当を握っていない時間の下限(割合)。握りっぱなしの検知。 */
	minSkillIdleRatio: Number(process.env.MIN_IDLE_RATIO ?? 0.3),
	/** スキルの空振り率の上限。何も変わらない行動の繰り返しの検知。 */
	maxEmptyRatio: Number(process.env.MAX_EMPTY_RATIO ?? 0.6),
	/** 最低でもこれだけはスキルが動いていること。 */
	minSkillRuns: Number(process.env.MIN_SKILL_RUNS ?? 5),
};

interface Check {
	label: string;
	ok: boolean;
	detail: string;
}

/** 状況ごとの定義。setup で世界を作り、goal で「状況を解けたか」を採点する。 */
interface Scenario {
	name: string;
	/** 何を試すか。ログの先頭に出す。 */
	intent: string;
	defaultMinutes: number;
	/** スポーン後、ループを始める前に世界を作る。agent には課題(依頼)を置ける。 */
	setup(driver: BotDriver, agent: MinecraftAgent): Promise<void>;
	/** 15秒ごとに呼ばれる。途中経過を控える。 */
	observe?(driver: BotDriver, agent: MinecraftAgent): void;
	/** 終了時の採点。ループの健全性とは別の、状況固有の合否。 */
	goal(agent: MinecraftAgent): Check[];
	/**
	 * 作った地形を戻す。世界は Docker のボリュームに残るので、戻さないと
	 * 次の回は前の回の石柱の上にスポーンし、柱が積み上がっていく(実測、
	 * 2回目は Y=-40 から始まった)。
	 */
	teardown?(): void;
}

/** サーバーのコンソールへコマンドを1つ送る。 */
function serverCommand(command: string): void {
	const args = ["exec", CONTAINER, "send-command", command];
	console.log(`[scenario] server> ${command}`);
	try {
		if (process.platform === "win32") {
			execFileSync("wsl", ["-e", "docker", ...args], { stdio: "pipe" });
		} else {
			execFileSync("docker", args, { stdio: "pipe" });
		}
	} catch (e) {
		throw new Error(`サーバーコマンドに失敗: ${command}: ${e}`);
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 渡した物が本当に持ち物に入ったかを確かめる。入っていなければ1回だけやり直す。 */
async function giveAndVerify(driver: BotDriver, item: string, count: number): Promise<void> {
	for (let attempt = 0; attempt < 2; attempt++) {
		serverCommand(`give ${BOT_NAME} ${item} ${count}`);
		await sleep(2_500);
		const have = driver.inventory
			.items()
			.filter((i) => i.name === item)
			.reduce((n, i) => n + i.count, 0);
		if (have >= count) return;
		console.log(`[scenario] ${item} が持ち物に入っていない(${have}/${count})。やり直す`);
	}
	throw new Error(`${item} を渡せなかった。前の回のボットがまだ居座っている可能性`);
}

/** 満腹度を閾値未満まで落とす。空腹の効果を掛け、効くまで待つ。 */
async function starve(driver: BotDriver, below: number): Promise<void> {
	for (let attempt = 0; attempt < 3; attempt++) {
		serverCommand(`effect ${BOT_NAME} hunger 20 255`);
		for (let i = 0; i < 10; i++) {
			await sleep(2_000);
			if (driver.getState().food < below) {
				serverCommand(`effect ${BOT_NAME} clear`);
				return;
			}
		}
		console.log(`[scenario] 満腹度がまだ ${driver.getState().food}。空腹の効果を掛け直す`);
	}
	throw new Error("満腹度を落とせなかった");
}

/** ボットの足元の整数座標。 */
function foot(driver: BotDriver) {
	const p = driver.getState().position;
	return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
}

/**
 * スポーン周辺を平地の初期状態に戻す。
 *
 * 世界は Docker のボリュームに残り、前の回の石柱・後始末で空気にした跡・
 * 浮いた石の板が積み重なる。実測 2026-09-20 02:16、cobble の石の床が
 * 前の回の柱の天面(Y=-42)に敷かれ、掘った丸石は19ブロック下の空洞へ落ちた。
 * 「掘ったが得られない」の大半がこれで、スキルの問題と区別できなかった。
 *
 * fill は1回 32768 ブロックまで、かつ読み込まれたチャンクにしか置けない
 * (ボットが接続している間だけ効く)。51x12x51=31212 に収めて層ごとに消す。
 */
/**
 * 書き換えた地形がボットの写しに届くまで待つ。
 *
 * 大きな fill は写しに届くまで3〜6秒かかる(実測 02:30、41x41 で 6秒)。届く前に
 * ループを始めると、スキルは古い写しを見て「石が無い」と言い続ける。
 */
async function waitForBlock(
	driver: BotDriver,
	at: { x: number; y: number; z: number },
	name: string,
	maxMs = 30_000,
): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < maxMs) {
		const b = driver.world.blockAt(at);
		if (b?.name === name) {
			console.log(`[scenario] 写しに ${name} が届いた (${Date.now() - started}ms)`);
			return;
		}
		await sleep(1_000);
	}
	console.log(
		`[scenario] 警告: ${maxMs / 1000}秒待っても写しの (${at.x}, ${at.y}, ${at.z}) は ${driver.world.blockAt(at)?.name ?? "?"} のまま(${name} を期待)`,
	);
}

function resetFlatWorld(driver: BotDriver): void {
	const f = foot(driver);
	const r = 25;
	// 地表の高さは決め打ちしない。世界を作り直した直後のスポーンは本当の
	// 地表に立っているので、足元から下へ辿って最初の固いブロックを地表とする。
	// 決め打ち(-62)で戻したとき、実際の地表(-61)より1段低く作り直して
	// 周囲より1段低い窪地ができた(実測 2026-09-20 02:34)。
	let groundY = f.y - 1;
	for (let y = f.y - 1; y >= f.y - 40; y--) {
		const b = driver.world.blockAt({ x: f.x, y, z: f.z });
		if (b && b.name !== "air" && b.solid) {
			groundY = y;
			break;
		}
	}
	serverCommand("kill @e[type=item]");
	for (let y0 = groundY + 1; y0 <= groundY + 40; y0 += 12) {
		const y1 = Math.min(y0 + 11, groundY + 40);
		serverCommand(`fill ${f.x - r} ${y0} ${f.z - r} ${f.x + r} ${y1} ${f.z + r} air`);
	}
	serverCommand(
		`fill ${f.x - r} ${groundY} ${f.z - r} ${f.x + r} ${groundY} ${f.z + r} grass_block`,
	);
	serverCommand(
		`fill ${f.x - r} ${groundY - 1} ${f.z - r} ${f.x + r} ${groundY - 1} ${f.z + r} dirt`,
	);
	// 浮いた板の上に立っていたなら、消えた瞬間に落ちて死ぬ。地表へ移す。
	serverCommand(`tp ${BOT_NAME} ${f.x} ${groundY + 1} ${f.z}`);
}

let rawFoodOutcrop: string | null = null;
let cobbleGround: string | null = null;
let cobbleMax = 0;

/**
 * 前の回の残骸を消す。
 *
 * 世界は Docker のボリュームに残る。前の回が置いた作業台・足場に使った板や
 * 原木・伐り残した葉は、次の回では「人工物」(agent.ts の MANMADE_BLOCKS、
 * 半径128で拾う)として LLM に渡り、「誰かの拠点へ向かえ」の指示に引かれて
 * 10分それを追いかける(実測 2026-09-19 22:32〜22:43、raw-food。丸石3個で
 * 石掘りをやめ、前の回の作業台と埋まった板へ goto を46回)。回ごとの結果を
 * 比べるには、始める前に消しておく。
 *
 * fill は1回 32768 ブロックまで。97x3x97=28227 に収めて3層ずつ消す。
 */
function sweepArtifacts(f: { x: number; y: number; z: number }): void {
	const names = ["crafting_table", "furnace", "torch", "oak_planks", "oak_log", "oak_leaves"];
	const r = 48;
	for (let y = f.y - 6; y <= f.y + 8; y += 3) {
		for (const name of names) {
			serverCommand(
				`fill ${f.x - r} ${y} ${f.z - r} ${f.x + r} ${y + 2} ${f.z + r} air replace ${name}`,
			);
		}
	}
	// 落ちている物も前の回のもの。拾うと持ち物の前提が崩れる。
	serverCommand("kill @e[type=item]");
}

const scenarios: Record<string, Scenario> = {
	baseline: {
		name: "baseline",
		intent: "何も仕込まず、ループが健全に回るかだけを見る",
		defaultMinutes: 10,
		setup: async () => {},
		goal: () => [],
	},

	"night-underground": {
		name: "night-underground",
		intent:
			"夜、地下20マスの石室に閉じ込める(持ち物は dirt 12 だけ)。2026-09-19 の死因の4/5がこの状況。地上へ出られるか",
		// 階段を切って登るのは1段あたり約35秒(実測 2026-09-19 20:38〜20:40、4段で
		// 2分半)。20段なら12分では足りない。夜(約8分)をまたいで籠る判断が入る
		// ことも見込み、夜明け後に登り切る時間まで取る。
		defaultMinutes: 20,
		setup: async (driver) => {
			resetFlatWorld(driver);
			await sleep(8_000);
			const f = foot(driver);
			// 20マスの石の柱を建て、底に 3x3x3 の空洞を作って、そこへ移す。
			// 柱の天面がこの列の「地表」になる。
			const top = f.y + 20;
			serverCommand(`fill ${f.x - 4} ${f.y} ${f.z - 4} ${f.x + 4} ${top} ${f.z + 4} stone`);
			serverCommand(`fill ${f.x - 1} ${f.y} ${f.z - 1} ${f.x + 1} ${f.y + 2} ${f.z + 1} air`);
			serverCommand(`clear ${BOT_NAME}`);
			await giveAndVerify(driver, "dirt", 12);
			// 夜の始まり。日照サイクルは止めない(約8分で明ける)。
			// 「夜に掘り上がるか、朝を待つか」は LLM が選ぶ。
			serverCommand("time set 13000");
			serverCommand(`tp ${BOT_NAME} ${f.x} ${f.y} ${f.z}`);
			// 地形の書き換えがクライアント側の写しに届くまで待つ。初回(3秒)は
			// 石室の天井が写しに無く、地表までの深さが読めずに籠りが発火した。
			await sleep(10_000);
			// 天井がボットの写しに見えているか。見えていなければ、この回の
			// 「地上へ出た」は写しの古さで歪む(壁の中を歩き抜ける)。
			const ceiling = driver.world.blockAt({ x: f.x, y: f.y + 3, z: f.z });
			console.log(
				`[scenario] 石室 (${f.x}, ${f.y}, ${f.z})、天面 Y=${top}、写しの天井=${ceiling?.name ?? "unknown"}`,
			);
			if (ceiling?.name !== "stone") {
				console.log(
					"[scenario] 警告: 石室の天井が写しに無い。サイドカーが地形の書き換えを取り込めていない",
				);
			}
			(scenarios["night-underground"] as ScenarioWithState).state = {
				top,
				maxY: f.y,
				region: `${f.x - 4} ${f.y} ${f.z - 4} ${f.x + 4} ${top} ${f.z + 4}`,
			};
		},
		teardown: () => {
			const st = (scenarios["night-underground"] as ScenarioWithState).state;
			if (st?.region) serverCommand(`fill ${st.region} air`);
		},
		observe: (driver, agent) => {
			const st = (scenarios["night-underground"] as ScenarioWithState).state;
			if (!st) return;
			// 死んでリスポーンすれば地上に立つ。それは「出た」ではないので、
			// 最初の死亡より前の高さだけを見る。
			if (agent.metricsSummary().deaths > 0) return;
			const y = foot(driver).y;
			if (y > st.maxY) st.maxY = y;
		},
		goal: () => {
			const st = (scenarios["night-underground"] as ScenarioWithState).state;
			if (!st) return [];
			return [
				{
					label: "地上(柱の天面)へ出た(最初の死亡より前)",
					ok: st.maxY >= st.top,
					detail: `最高到達 Y=${st.maxY} (天面 Y=${st.top})`,
				},
			];
		},
	},

	cobble: {
		name: "cobble",
		intent:
			"木のツルハシを持って石の地面に立つ。丸石8個(かまど1つぶん)を集められるか。collecting.stone の掘り→拾得の連鎖を単独で測る",
		defaultMinutes: 8,
		setup: async (driver, agent) => {
			resetFlatWorld(driver);
			await sleep(8_000);
			const f = foot(driver);
			serverCommand("time set 1000");
			serverCommand(`clear ${BOT_NAME}`);
			await giveAndVerify(driver, "wooden_pickaxe", 1);
			cobbleGround = `${f.x - 20} ${f.y - 1} ${f.z - 20} ${f.x + 20} ${f.y - 1} ${f.z + 20}`;
			serverCommand(`fill ${cobbleGround} stone`);
			await waitForBlock(driver, { x: f.x + 2, y: f.y - 1, z: f.z }, "stone");
			// 何を測るかを課題として渡す。渡さないと LLM は自分の優先(木・剣)で
			// 動き、石を掘る場面が来ない(実測 01:53、8分で collecting.stone 0回)。
			agent.injectRequest(
				"tester",
				"Please collect 8 cobblestone. You are standing on stone and holding a wooden pickaxe.",
			);
		},
		teardown: () => {
			if (cobbleGround) serverCommand(`fill ${cobbleGround} grass_block`);
		},
		observe: (driver) => {
			const have = driver.inventory
				.items()
				.filter((i) => i.name === "cobblestone")
				.reduce((n, i) => n + i.count, 0);
			if (have > cobbleMax) cobbleMax = have;
		},
		goal: () => [
			{
				label: "丸石を8個以上集めた",
				ok: cobbleMax >= 8,
				detail: `最大所持 ${cobbleMax} 個`,
			},
		],
	},

	"raw-food": {
		name: "raw-food",
		intent:
			"生の鶏肉とツルハシと作業台はあるがかまどが無い。空腹。2026-09-19 に反射が43回同じ失敗をした状況。石を掘り、かまどを作り、焼いて食べるまで辿れるか",
		defaultMinutes: 12,
		setup: async (driver) => {
			resetFlatWorld(driver);
			await sleep(8_000);
			const f = foot(driver);
			serverCommand("time set 1000");
			serverCommand(`clear ${BOT_NAME}`);
			await giveAndVerify(driver, "chicken", 3);
			await giveAndVerify(driver, "wooden_pickaxe", 1);
			await giveAndVerify(driver, "crafting_table", 1);
			// 平地には石が無いので、足元の地面を広く石に替える。実際の世界では
			// 石は掘れば必ずある。小さな露頭1つだと、木を探して20ブロック歩いた
			// 先で「石が無い」になり、状況の再現にならなかった(実測 19:29)。
			rawFoodOutcrop = `${f.x - 20} ${f.y - 1} ${f.z - 20} ${f.x + 20} ${f.y - 1} ${f.z + 20}`;
			serverCommand(`fill ${rawFoodOutcrop} stone`);
			// 満腹度を落とす。直接は設定できないので空腹の効果で削る。
			// 反射 eat の閾値(EAT_BELOW_FOOD)を下回るまで待つ。
			await starve(driver, 14);
			console.log(`[scenario] 満腹度 ${driver.getState().food}`);
		},
		teardown: () => {
			if (rawFoodOutcrop) serverCommand(`fill ${rawFoodOutcrop} grass_block`);
		},
		goal: (agent) => {
			const m = agent.metricsSummary();
			return [
				{
					label: "食事に至った",
					ok: m.meals >= 1,
					detail: `食事 ${m.meals} 回、回復した満腹度 ${m.foodRestored}`,
				},
			];
		},
	},

	"wood-tool": {
		name: "wood-tool",
		intent:
			"昼・素手・食料なし。10ブロック先に木を3本建てる。原木を得て木の道具か剣を作れるか。実測 9/17〜9/19 の51時間で collecting.wood 38%・crafting.tool 4%・crafting.weapon 2%。生存の鎖はここで切れている",
		// 伐採1本の予算が40秒、道具作成に作業台の作成と設置が入る。
		// 木まで歩く時間を含めても、通るなら5分で通る。通らないときの
		// 挙動(同じ木に届かない・空振り)を見るために少し余らせる。
		defaultMinutes: 12,
		setup: async (driver) => {
			const f = foot(driver);
			serverCommand("time set 1000");
			serverCommand(`clear ${BOT_NAME}`);
			// 平地には木が無い。樫を3本、8〜12ブロック離れた3方向に建てる。
			// 幹5本・葉は上2段の3x3。自然の木に近い形で、幹の根元は地面に
			// 接している(trunkBase が辿れる)。葉を先に置き、幹で上書きする。
			const trees = [
				{ x: f.x + 10, z: f.z },
				{ x: f.x - 4, z: f.z + 9 },
				{ x: f.x - 4, z: f.z - 9 },
			];
			const regions: string[] = [];
			for (const t of trees) {
				const leaves = `${t.x - 1} ${f.y + 3} ${t.z - 1} ${t.x + 1} ${f.y + 5} ${t.z + 1}`;
				const trunk = `${t.x} ${f.y} ${t.z} ${t.x} ${f.y + 4} ${t.z}`;
				serverCommand(`fill ${leaves} oak_leaves`);
				serverCommand(`fill ${trunk} oak_log`);
				regions.push(leaves, trunk);
			}
			// 作業台や落とし物が残っても次の回の邪魔にはならないが、木は
			// 残ると「近くに木がある」の前提が回ごとに変わる。戻す範囲を控える。
			(scenarios["wood-tool"] as WoodToolScenario).state = {
				regions,
				maxLogs: 0,
				toolsSeen: new Set<string>(),
			};
			await sleep(5_000);
			const trunk = driver.world.blockAt({ x: trees[0].x, y: f.y + 1, z: trees[0].z });
			console.log(
				`[scenario] 木 ${trees.map((t) => `(${t.x},${t.z})`).join(" ")}、写しの幹=${trunk?.name ?? "unknown"}`,
			);
			if (!trunk?.name.endsWith("_log")) {
				console.log(
					"[scenario] 警告: 建てた木が写しに無い。サイドカーが地形の書き換えを取り込めていない",
				);
			}
		},
		teardown: () => {
			const st = (scenarios["wood-tool"] as WoodToolScenario).state;
			for (const r of st?.regions ?? []) serverCommand(`fill ${r} air`);
		},
		observe: (driver) => {
			const st = (scenarios["wood-tool"] as WoodToolScenario).state;
			if (!st) return;
			// 持ち物は死ねば落ちる。合否は「一度でも持ったか」で見る。
			let logs = 0;
			for (const it of driver.inventory.items()) {
				if (it.name.endsWith("_log")) logs += it.count;
				if (/_(pickaxe|axe|sword|shovel)$/.test(it.name)) st.toolsSeen.add(it.name);
			}
			if (logs > st.maxLogs) st.maxLogs = logs;
		},
		goal: (agent) => {
			const st = (scenarios["wood-tool"] as WoodToolScenario).state;
			if (!st) return [];
			const m = agent.metricsSummary();
			const wood = m.skills["collecting.wood"];
			const tool = m.skills["crafting.tool"];
			const weapon = m.skills["crafting.weapon"];
			const crafted = (tool?.ok ?? 0) + (weapon?.ok ?? 0);
			return [
				{
					label: "原木を手に入れた",
					ok: st.maxLogs >= 1,
					detail: `最大所持 ${st.maxLogs} 本 (collecting.wood ${wood?.ok ?? 0}/${wood?.runs ?? 0}、得た品 ${wood?.gained ?? 0})`,
				},
				{
					label: "木の道具か剣を作った",
					ok: st.toolsSeen.size >= 1 || crafted >= 1,
					detail: `持った道具 [${[...st.toolsSeen].join(", ")}] (crafting.tool ${tool?.ok ?? 0}/${tool?.runs ?? 0}、crafting.weapon ${weapon?.ok ?? 0}/${weapon?.runs ?? 0})`,
				},
			];
		},
	},
};

type WoodToolScenario = Scenario & {
	state?: { regions: string[]; maxLogs: number; toolsSeen: Set<string> };
};

type ScenarioWithState = Scenario & {
	state?: { top: number; maxY: number; region?: string };
};

async function main() {
	if (!ADDRESS.startsWith("127.0.0.1") && !ADDRESS.startsWith("localhost")) {
		throw new Error(`scenario はローカル専用です (BEDROCK_ADDRESS=${ADDRESS})`);
	}
	const scenario = scenarios[SCENARIO];
	if (!scenario) {
		throw new Error(`知らない SCENARIO=${SCENARIO}。候補: ${Object.keys(scenarios).join(", ")}`);
	}
	const minutes = Number(process.env.SCENARIO_MINUTES ?? scenario.defaultMinutes);

	const driver = new BedrockDriver({ address: ADDRESS, viaWsl: VIA_WSL, name: BOT_NAME });
	// 名前は接続名に合わせる。思考プロンプトのログ(logs/<name>/input.md)が
	// 本番の kusabot と同じ場所に書かれ、どちらのプロンプトか読めなくなっていた。
	const profile = { ...kusabot, minecraftName: BOT_NAME };
	const agent = new MinecraftAgent(profile, bedrockSkills as any[], driver);

	console.log(`[scenario] ${scenario.name}: ${scenario.intent}`);
	console.log(`[scenario] ${ADDRESS} に接続します`);
	await driver.connect();
	console.log(`[scenario] スポーン完了: ${driver.getState().username}`);
	// 前の回の同名ボットがまだサーバー上で抜け切っていないことがある。
	// その間に give を送ると古い方に渡り、こちらの持ち物は空のまま始まる
	// (実測 2026-09-19 19:08、抜けたのは接続の15秒後だった)。
	await sleep(20_000);
	sweepArtifacts(foot(driver));
	await scenario.setup(driver, agent);
	agent.startLoops();

	const until = Date.now() + minutes * 60_000;
	while (Date.now() < until) {
		await sleep(15_000);
		scenario.observe?.(driver, agent);
	}

	agent.cancelAllTasks();
	const summary = agent.metricsSummary();
	await driver.disconnect();
	try {
		scenario.teardown?.();
	} catch (e) {
		console.error(`[scenario] 後始末に失敗: ${e}`);
	}

	const runs = Object.values(summary.skills).reduce((sum, s) => sum + s.runs, 0);
	const empty = Object.values(summary.skills).reduce((sum, s) => sum + s.empty, 0);
	const emptyRatio = runs > 0 ? empty / runs : 0;

	const health: Check[] = [
		{
			label: "スキルが止まっていない",
			ok: summary.longestStallMs <= THRESHOLDS.longestStallMs,
			detail: `最長停滞 ${(summary.longestStallMs / 60_000).toFixed(1)}分 (上限 ${(THRESHOLDS.longestStallMs / 60_000).toFixed(1)}分)`,
		},
		{
			label: "反射が担当を握りっぱなしにしていない",
			ok: summary.skillIdleRatio >= THRESHOLDS.minSkillIdleRatio,
			detail: `スキル可 ${(summary.skillIdleRatio * 100).toFixed(0)}% (下限 ${(THRESHOLDS.minSkillIdleRatio * 100).toFixed(0)}%)`,
		},
		{
			label: "スキルが実際に動いている",
			ok: runs >= THRESHOLDS.minSkillRuns,
			detail: `${runs}回 (下限 ${THRESHOLDS.minSkillRuns}回)`,
		},
		{
			label: "空振りを繰り返していない",
			ok: emptyRatio <= THRESHOLDS.maxEmptyRatio,
			detail: `空振り ${(emptyRatio * 100).toFixed(0)}% (上限 ${(THRESHOLDS.maxEmptyRatio * 100).toFixed(0)}%)`,
		},
	];
	const goal = scenario.goal(agent);

	console.log("");
	console.log(`[scenario] ${scenario.name} ${minutes}分の結果`);
	for (const r of [...goal, ...health]) {
		console.log(`${r.ok ? "  OK  " : " FAIL "} ${r.label} — ${r.detail}`);
	}
	console.log(`[scenario] 食事 ${summary.meals} 回 / 死亡 ${summary.deaths} 回`);
	console.log(`[scenario] 担当の内訳: ${JSON.stringify(summary.controlMsByRule)}`);
	console.log(
		`[scenario] スキル別: ${Object.entries(summary.skills)
			.map(([k, v]) => `${k} ${v.ok}/${v.runs}`)
			.join(", ")}`,
	);
	console.log(JSON.stringify(summary, null, 2));

	const failed = [...goal, ...health].filter((r) => !r.ok).length;
	process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
	console.error("[scenario] 失敗:", err);
	process.exit(1);
});
