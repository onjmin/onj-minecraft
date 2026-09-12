/**
 * 埋め戻しの判定を、実 Realm の地形で「置かずに」確かめる。
 *
 * 実行:
 *   npx tsx --env-file=.env src/core/driver/bedrock-repair-check.ts
 *   REPAIR_X=0 REPAIR_Z=70 REPAIR_RADIUS=16 npx tsx --env-file=.env src/core/driver/bedrock-repair-check.ts
 *
 * ブロックは1つも置かない。読み取りだけ。
 *
 * なぜ置かずに確かめるか。building.repair は「周りの地面より低く沈んだ列」を
 * 穴と見なして蓋をする。この判定を誤ると、他人の建物の出入口や地下室への
 * 降り口を塞ぐことになり、埋め戻しのつもりで新しい荒らしをすることになる。
 * 一度置いたブロックは、また壊さないと戻せない。先に何を穴と読むのかを
 * 目で見ておく。
 *
 * 判定は building.repair が使うものをそのまま呼ぶ。テスト側に写しを作ると、
 * 確かめたことにならない。
 *
 * LLM を介さず直接ドライバを叩く（bedrock-check.ts と同じ方針）。
 * 思考ループ越しに待つと、失敗が「LLMが選ばなかった」のか「実装が壊れて
 * いる」のか切り分けられない。
 */
import { findHoleColumns, intactSurfaceY } from "../../skills/building/repair";
import { BedrockDriver } from "./bedrock";

const INVITE = process.env.REALM_INVITE ?? "";
const ADDRESS = process.env.BEDROCK_ADDRESS ?? "";
const VIA_WSL = (process.env.BEDROCK_WSL ?? (process.platform === "win32" ? "1" : "0")) === "1";
const RADIUS = Number(process.env.REPAIR_RADIUS ?? 16);

async function main() {
	if (!INVITE && !ADDRESS) {
		throw new Error("REALM_INVITE か BEDROCK_ADDRESS を指定してください");
	}

	const driver = new BedrockDriver({
		realmInvite: INVITE || undefined,
		address: ADDRESS || undefined,
		name: ADDRESS ? "kusabot" : undefined,
		viaWsl: ADDRESS ? VIA_WSL : false,
	});

	console.log("[repair-check] 接続します…");
	await driver.connect();
	const state = driver.getState();
	console.log(`[repair-check] 接続アカウント: ${state.username}`);
	console.log(
		`[repair-check] 現在地: (${state.position.x.toFixed(0)}, ${state.position.y.toFixed(0)}, ${state.position.z.toFixed(0)})`,
	);

	// チャンクが届くまで少し待つ。届く前に数えても「読めていない」だけ。
	await new Promise((r) => setTimeout(r, 5000));

	// 現地まで行く。
	//
	// surfaceScan が数えるのは常に自分の周りなので、離れた場所の地形は
	// 行かないと読めない。初期リスの穴を確かめたいのに、ボットが別の場所に
	// いれば「無傷の地形」しか見えない。実際それで一度空振りした。
	const wantX = process.env.REPAIR_X;
	const wantZ = process.env.REPAIR_Z;
	if (wantX !== undefined && wantZ !== undefined) {
		const tx = Number(wantX);
		const tz = Number(wantZ);
		console.log(`[repair-check] (${tx}, ${tz}) へ移動します…`);
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), 120_000);
		try {
			await driver.goto(ac.signal, { kind: "xz", x: tx, z: tz, distance: 4 });
		} catch (e) {
			console.log(`[repair-check] 移動しきれませんでした: ${e}`);
		} finally {
			clearTimeout(timer);
		}
		const now = driver.getState().position;
		console.log(
			`[repair-check] 移動後: (${now.x.toFixed(0)}, ${now.y.toFixed(0)}, ${now.z.toFixed(0)})`,
		);
		// 移動先のチャンクが届くのを待つ。
		await new Promise((r) => setTimeout(r, 5000));
	}

	const columns = await driver.world.surfaceScan(RADIUS);
	console.log(`[repair-check] 読めた列: ${columns.length}（半径 ${RADIUS}）`);
	if (columns.length === 0) {
		console.log("[repair-check] 地形を読めていません。チャンクが届いていない可能性。");
		await driver.disconnect();
		return;
	}

	const ys = columns.map((c) => c.y);
	const groundY = intactSurfaceY(ys);
	const min = Math.min(...ys);
	const max = Math.max(...ys);
	console.log(`[repair-check] 地表の高さ: 最低 ${min} / 最高 ${max} / 本来とみなす高さ ${groundY}`);

	const center = {
		x: Number(process.env.REPAIR_X ?? Math.floor(state.position.x)),
		z: Number(process.env.REPAIR_Z ?? Math.floor(state.position.z)),
	};
	console.log(`[repair-check] 判定の中心: (${center.x}, ${center.z})`);

	// 人工物も実際に探して、除外が効いているかを見る。
	const manmade = await driver.world.findBlocksFar(
		["crafting_table", "furnace", "chest", "bed", "torch", "oak_planks", "spruce_planks"],
		48,
		8,
	);
	console.log(`[repair-check] 近くの人工物: ${manmade.length} 件`);
	for (const m of manmade.slice(0, 5)) {
		console.log(`    ${m.name} (${m.position.x}, ${m.position.y}, ${m.position.z})`);
	}

	const holes = findHoleColumns(
		columns,
		center,
		RADIUS,
		groundY,
		manmade.map((m) => ({ position: m.position })),
	);

	console.log(`\n[repair-check] 穴と判定した列: ${holes.length} / ${columns.length}`);
	console.log("[repair-check] 蓋をする高さは列ごとに、周りの地面に合わせます。");
	for (const h of holes.slice(0, 20)) {
		console.log(
			`    (${h.x}, ${h.z}) 地表 Y=${h.y} → 周りの地面 Y=${h.fillY} より ${h.fillY - h.y} 段低い（上の空き ${h.open}）`,
		);
	}
	if (holes.length > 20) console.log(`    …ほか ${holes.length - 20} 列`);

	// 除外が効いているかを、人工物の近さで数え直して見せる。
	const withoutKeepout = findHoleColumns(columns, center, RADIUS, groundY, []);
	console.log(
		`\n[repair-check] 人工物そばの除外で守った列: ${withoutKeepout.length - holes.length}`,
	);

	console.log("\n[repair-check] ブロックは1つも置いていません。");
	await driver.disconnect();
}

main().catch((e) => {
	console.error("[repair-check] 失敗:", e);
	process.exit(1);
});
