/**
 * 壁の向こうへ行けるかを見る。
 *
 * 歩ける道だけを探す経路探索では、塞がれていれば永久に辿り着けない。
 * 掘って抜ける手が経路に含まれているかを、実際に壁を立てて確かめる。
 *
 * 壁の用意はサーバーのコンソールから行う（このスクリプトの外側）。
 *   docker exec onj-bedrock-dev send-command fill 5 -60 -12 5 -58 12 dirt
 *
 * 実行:
 *   BEDROCK_ADDRESS=127.0.0.1:19132 npx tsx src/core/driver/bedrock-tunnel-test.ts
 */
import { BedrockDriver } from "./bedrock";

const ADDRESS = process.env.BEDROCK_ADDRESS ?? "127.0.0.1:19132";
const VIA_WSL = (process.env.BEDROCK_WSL ?? (process.platform === "win32" ? "1" : "0")) === "1";
/** 壁の向こう側の目標。 */
const GOAL_X = Number(process.env.GOAL_X ?? 12);

async function main() {
	const driver = new BedrockDriver({ address: ADDRESS, name: "tunneler", viaWsl: VIA_WSL });
	console.log(`[tunnel-test] ${ADDRESS} へ接続します`);
	await driver.connect();

	const start = driver.getState().position;
	console.log(`  開始位置: ${start.x.toFixed(1)}, ${start.y.toFixed(1)}, ${start.z.toFixed(1)}`);

	// 壁が実際にあることを確かめる。無ければ検証にならない。
	const wall = driver.world.blockAt({ x: 5, y: start.y, z: start.z });
	console.log(`  x=5 の壁: ${wall?.name ?? "読めない"}`);
	if (!wall || !wall.solid) {
		console.log("  壁がありません。先に fill で立ててください");
		await driver.disconnect();
		process.exit(1);
	}

	console.log(`  壁の向こう (x=${GOAL_X}) を目指します`);
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

	const through = end.x > 5.5;
	console.log(through ? "\n壁を越えました" : "\n壁を越えられません");
	console.log(`  目標到達: ${reached ? "はい" : "いいえ"}`);
	await driver.disconnect();
	process.exit(through ? 0 : 1);
}

main().catch((e) => {
	console.error("[tunnel-test] 失敗:", e);
	process.exit(1);
});
