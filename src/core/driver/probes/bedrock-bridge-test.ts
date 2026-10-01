/**
 * 谷を渡れるかを見る。
 *
 * 落ちて登れる段差なら経路探索だけで済むが、底が無い場所は足場を置くしかない。
 * 手持ちのブロックを使って橋を架ける手が経路に含まれているかを確かめる。
 *
 * 谷と持ち物の用意はサーバーのコンソールから行う（このスクリプトの外側）。
 *   docker exec onj-bedrock-dev send-command fill 5 -64 -12 8 -60 12 air
 *   docker exec onj-bedrock-dev send-command give bridger dirt 64
 *
 * 実行:
 *   BEDROCK_ADDRESS=127.0.0.1:19132 npx tsx src/core/driver/bedrock-bridge-test.ts
 */
import { BedrockDriver } from "./bedrock";

const ADDRESS = process.env.BEDROCK_ADDRESS ?? "127.0.0.1:19132";
const VIA_WSL = (process.env.BEDROCK_WSL ?? (process.platform === "win32" ? "1" : "0")) === "1";
const GOAL_X = Number(process.env.GOAL_X ?? 12);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
	const driver = new BedrockDriver({ address: ADDRESS, name: "bridger", viaWsl: VIA_WSL });
	console.log(`[bridge-test] ${ADDRESS} へ接続します`);
	await driver.connect();

	// 持ち物が届くまで少し待つ。give はこちらの接続後に打たれる。
	for (let i = 0; i < 20 && driver.inventory.items().length === 0; i++) {
		await sleep(500);
	}
	const items = driver.inventory.items();
	console.log(`  持ち物: ${items.map((i) => `${i.name}x${i.count}`).join(", ") || "なし"}`);
	if (items.length === 0) {
		console.log("  ブロックを持っていません。give してから実行してください");
		await driver.disconnect();
		process.exit(1);
	}

	const start = driver.getState().position;
	console.log(`  開始位置: ${start.x.toFixed(1)}, ${start.y.toFixed(1)}, ${start.z.toFixed(1)}`);

	// 谷が実際にあることを確かめる。
	const gapFloor = driver.world.blockAt({ x: 6, y: start.y - 1, z: start.z });
	console.log(`  x=6 の足元: ${gapFloor?.name ?? "読めない"}`);
	if (gapFloor?.solid) {
		console.log("  谷がありません。先に fill で掘ってください");
		await driver.disconnect();
		process.exit(1);
	}

	console.log(`  谷の向こう (x=${GOAL_X}) を目指します`);
	const startedAt = Date.now();
	let reached = false;
	try {
		await driver.goto(new AbortController().signal, {
			kind: "xz",
			x: GOAL_X,
			z: start.z,
			distance: 2,
		});
		reached = true;
	} catch (e) {
		console.log(`  届きませんでした: ${e}`);
	}

	const end = driver.getState().position;
	const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
	console.log(
		`  終了位置: ${end.x.toFixed(1)}, ${end.y.toFixed(1)}, ${end.z.toFixed(1)} (${elapsed}秒)`,
	);

	// 落ちずに向こう側へ渡れたか。
	const crossed = end.x > 8.5 && end.y > start.y - 2;
	console.log(crossed ? "\n谷を渡れました" : "\n谷を渡れません");
	console.log(`  目標到達: ${reached ? "はい" : "いいえ"}`);
	await driver.disconnect();
	process.exit(crossed ? 0 : 1);
}

main().catch((e) => {
	console.error("[bridge-test] 失敗:", e);
	process.exit(1);
});
