/**
 * 移動速度だけを測る。
 *
 * サーバー権限型の移動は、こちらの予測が妥当だとサーバーが認めたぶんしか進まない。
 * 「進んだ距離 / 経過秒」がバニラの歩行速度(4.317 ブロック/秒)にどれだけ近いかで、
 * 予測の作り方が合っているかを判定する。
 *
 * 実行:
 *   BEDROCK_ADDRESS=127.0.0.1:19132 npx tsx src/core/driver/bedrock-move-test.ts
 */
import { BedrockDriver } from "./bedrock";

const ADDRESS = process.env.BEDROCK_ADDRESS ?? "127.0.0.1:19132";
const VIA_WSL = (process.env.BEDROCK_WSL ?? (process.platform === "win32" ? "1" : "0")) === "1";
const SECONDS = Number(process.env.MOVE_SECONDS ?? 8);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WALK_SPEED = 4.317;

async function main() {
	const driver = new BedrockDriver({ address: ADDRESS, name: "kusabot", viaWsl: VIA_WSL });
	console.log(`[move-test] ${ADDRESS} へ接続します`);
	await driver.connect();

	// 障害物に当たると測定にならないので、四方向で測って一番進んだ向きを見る。
	const dirs: [string, number, number][] = [
		["南(+Z)", 0, 1],
		["北(-Z)", 0, -1],
		["東(+X)", 1, 0],
		["西(-X)", -1, 0],
	];

	let best = 0;
	for (const [label, dx, dz] of dirs) {
		const from = driver.getState().position;
		const ac = new AbortController();
		// 到達しない遠い目標を置いて、ひたすら歩かせる。
		const far = { x: from.x + dx * 200, z: from.z + dz * 200 };
		const started = Date.now();
		driver.goto(ac.signal, { kind: "xz", x: far.x, z: far.z, distance: 1 }).catch(() => {});
		await sleep(SECONDS * 1000);
		ac.abort();
		driver.stopMoving();
		await sleep(500);

		const to = driver.getState().position;
		const moved = Math.hypot(to.x - from.x, to.z - from.z);
		const elapsed = (Date.now() - started) / 1000;
		const speed = moved / elapsed;
		best = Math.max(best, speed);
		console.log(
			`  ${label}: ${moved.toFixed(1)} ブロック / ${elapsed.toFixed(1)} 秒 = ` +
				`${speed.toFixed(2)} ブロック/秒 (バニラ比 ${((speed / WALK_SPEED) * 100).toFixed(0)}%)`,
		);
	}

	console.log(
		`\n最良 ${best.toFixed(2)} ブロック/秒 — バニラ歩行 ${WALK_SPEED} の ` +
			`${((best / WALK_SPEED) * 100).toFixed(0)}%`,
	);
	// 補正がどれだけ効いているかを見る。移動が伸びない原因の切り分け用。
	const diag = driver.lastDiagnostics;
	if (diag) {
		console.log(
			`  診断: 送信tick ${diag.ticksSent} / 補正 ${diag.corrections} 回 / ` +
				`引き戻し合計 ${diag.driftTotal.toFixed(1)} ブロック ` +
				`(履歴一致 ${diag.histHits} / 不一致 ${diag.histMisses} / 最大ずれ ${diag.maxDrift.toFixed(2)})`,
		);
	}

	await driver.disconnect();
	// 半分も出ていなければ予測の作り方が間違っている。
	process.exit(best > WALK_SPEED * 0.5 ? 0 : 1);
}

main().catch((e) => {
	console.error("[move-test] 失敗:", e);
	process.exit(1);
});
