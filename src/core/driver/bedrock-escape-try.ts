/**
 * 囲いの外へ出られるかを、中断なしで試す。
 *
 * エージェントループ越しだと30秒で別スキルに切り替えられてしまい、
 * 「経路探索に脱出能力が無い」のか「時間が足りないだけ」なのかが分からない。
 * ここでは1回の goto に十分な時間を与えて、その区別をつける。
 */
import { gotoSurfaceSkill } from "../../skills/goto/surface";
import { BedrockDriver } from "./bedrock";

const INVITE = process.env.REALM_INVITE ?? "";
const TIMEOUT_MS = Number(process.env.ESCAPE_TIMEOUT_MS ?? 120_000);
/** 目標までの水平距離。囲いより十分外に取る。 */
const AWAY = Number(process.env.ESCAPE_DISTANCE ?? 30);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
	if (!INVITE) throw new Error("REALM_INVITE を指定してください");
	const driver = new BedrockDriver({ realmInvite: INVITE });
	driver.on("end", (r: string) => console.log(`[escape] 切断: ${r}`));

	console.log("[escape] 接続中...");
	await driver.connect();
	await sleep(5000);

	const from = driver.getState().position;
	console.log(
		`[escape] 開始 (${from.x.toFixed(1)}, ${from.y.toFixed(1)}, ${from.z.toFixed(1)})  持ち物: ${
			driver.inventory
				.items()
				.map((i) => `${i.name}x${i.count}`)
				.join(", ") || "空"
		}`,
	);

	// 四方向それぞれに、囲いの外まで行けるか試す。
	const dirs: [string, number, number][] = [
		["北(-Z)", 0, -AWAY],
		["南(+Z)", 0, AWAY],
		["東(+X)", AWAY, 0],
		["西(-X)", -AWAY, 0],
	];

	for (const [label, dx, dz] of dirs) {
		const start = driver.getState().position;
		const goal = { x: start.x + dx, z: start.z + dz };
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
		const began = Date.now();
		console.log(`\n[escape] ${label} へ ${AWAY} ブロック（上限 ${TIMEOUT_MS / 1000}秒）...`);
		try {
			await driver.goto(ac.signal, { kind: "xz", x: goal.x, z: goal.z, distance: 2 });
			const to = driver.getState().position;
			console.log(
				`  到達。(${to.x.toFixed(1)}, ${to.y.toFixed(1)}, ${to.z.toFixed(1)}) ${Math.round((Date.now() - began) / 1000)}秒`,
			);
			clearTimeout(timer);
			break;
		} catch (e) {
			const to = driver.getState().position;
			const moved = Math.hypot(to.x - start.x, to.z - start.z);
			console.log(
				`  失敗(${Math.round((Date.now() - began) / 1000)}秒, ${moved.toFixed(1)}ブロック進んだ): ${e}`,
			);
		}
		clearTimeout(timer);
	}

	// goto.surface を中断なしで1回だけ通す。ループでは30秒で切られて
	// 一度も完走しなかったので、時間さえあれば通るのかを見る。
	{
		const start = driver.getState().position;
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
		const began = Date.now();
		console.log(`
[escape] goto.surface を中断なしで実行（上限 ${TIMEOUT_MS / 1000}秒）...`);
		const fakeAgent = { driver, log: (...a: unknown[]) => console.log("   ", ...a) } as any;
		try {
			const r = await gotoSurfaceSkill.handler({
				agent: fakeAgent,
				signal: ac.signal,
				args: undefined as any,
			});
			const to = driver.getState().position;
			console.log(
				`  ${r.success ? "成功" : "失敗"}: ${r.summary} (${Math.round((Date.now() - began) / 1000)}秒, Y ${start.y.toFixed(1)} → ${to.y.toFixed(1)})`,
			);
		} catch (e) {
			console.log(`  例外(${Math.round((Date.now() - began) / 1000)}秒): ${e}`);
		}
		clearTimeout(timer);
	}

	const end = driver.getState().position;
	const total = Math.hypot(end.x - from.x, end.z - from.z);
	console.log(
		`\n[escape] 最終 (${end.x.toFixed(1)}, ${end.y.toFixed(1)}, ${end.z.toFixed(1)}) 開始地点から ${total.toFixed(1)} ブロック`,
	);

	await driver.disconnect();
	process.exit(0);
}

main().catch((e) => {
	console.error("[escape] 失敗:", e);
	process.exit(1);
});
