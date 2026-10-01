/**
 * 掘った穴から出られるかを見る。
 *
 * 採掘は必ず穴を作る。跳躍を予測に入れていないと、1段の段差すら登れず
 * その場で往復し続ける（実際にこれで移動が 83% から 4% に落ちた）。
 * 採掘と移動を組み合わせる以上、ここは通っていないと話にならない。
 *
 * 実行:
 *   BEDROCK_ADDRESS=127.0.0.1:19132 npx tsx src/core/driver/bedrock-climb-test.ts
 */
import { BedrockDriver } from "./bedrock";

const ADDRESS = process.env.BEDROCK_ADDRESS ?? "127.0.0.1:19132";
const VIA_WSL = (process.env.BEDROCK_WSL ?? (process.platform === "win32" ? "1" : "0")) === "1";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
	const driver = new BedrockDriver({ address: ADDRESS, name: "climber", viaWsl: VIA_WSL });
	console.log(`[climb-test] ${ADDRESS} へ接続します`);
	await driver.connect();

	const start = driver.getState().position;
	console.log(`  開始位置: ${start.x.toFixed(1)}, ${start.y.toFixed(1)}, ${start.z.toFixed(1)}`);

	// 足元を掘って穴に落ちる。
	const below = { x: Math.floor(start.x), y: Math.floor(start.y) - 1, z: Math.floor(start.z) };
	const block = driver.world.blockAt(below);
	if (!block) {
		console.log("  足元が読めません。中止します");
		await driver.disconnect();
		process.exit(1);
	}
	console.log(`  足元の ${block.name} を掘ります`);
	await driver.dig(new AbortController().signal, below);
	await sleep(1500);

	const inHole = driver.getState().position;
	console.log(`  穴の中: ${inHole.x.toFixed(1)}, ${inHole.y.toFixed(1)}, ${inHole.z.toFixed(1)}`);
	const dropped = start.y - inHole.y;
	console.log(`  ${dropped.toFixed(2)} ブロック落ちました`);

	// 穴から出て、少し離れた場所まで歩く。
	const goal = { x: inHole.x + 8, z: inHole.z };
	console.log(`  (${goal.x.toFixed(1)}, ${goal.z.toFixed(1)}) まで歩きます`);
	let reached = false;
	try {
		await driver.goto(new AbortController().signal, {
			kind: "xz",
			x: goal.x,
			z: goal.z,
			distance: 1.5,
		});
		reached = true;
	} catch (e) {
		console.log(`  届きませんでした: ${e}`);
	}

	const end = driver.getState().position;
	const moved = Math.hypot(end.x - inHole.x, end.z - inHole.z);
	const climbed = end.y - inHole.y;
	console.log(`  終了位置: ${end.x.toFixed(1)}, ${end.y.toFixed(1)}, ${end.z.toFixed(1)}`);
	console.log(`  水平に ${moved.toFixed(1)} ブロック、垂直に ${climbed.toFixed(2)} ブロック`);

	const ok = reached || moved > 4;
	console.log(ok ? "\n穴から出られました" : "\n穴から出られません");
	await driver.disconnect();
	process.exit(ok ? 0 : 1);
}

main().catch((e) => {
	console.error("[climb-test] 失敗:", e);
	process.exit(1);
});
