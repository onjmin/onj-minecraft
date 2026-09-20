/**
 * 石を掘ったら丸石が落ちるかを、それだけ切り出して確かめる。
 *
 * 実測 2026-09-20 01:59、木のツルハシを持って石を6個壊し、丸石0・落下物0。
 * サーバーは約1.2秒で壊している(素手なら7.5秒)ので、持ち替えは届いている
 * はず。それでも落ちないなら、壊し方(PlayerAuthInput の BlockActions だけで、
 * 破壊の InventoryTransaction を送っていない)の側を疑う。ここでは
 *   1. 土を素手で掘る(必ず落ちる。回収経路の生存確認)
 *   2. 石をツルハシで掘る(落ちるべき)
 * を1ブロックずつ行い、落下物(isItem)と持ち物の差分を出す。
 *
 * 実行(ローカル Docker の開発サーバー、WSL 経由):
 *   npx tsx src/core/driver/bedrock-drop-test.ts
 */
import { execFileSync } from "node:child_process";
import { BedrockDriver } from "./bedrock";

const ADDRESS = process.env.BEDROCK_ADDRESS ?? "127.0.0.1:19132";
const VIA_WSL = (process.env.BEDROCK_WSL ?? (process.platform === "win32" ? "1" : "0")) === "1";
const NAME = "droptester";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function server(cmd: string) {
	const args = ["exec", "onj-bedrock-dev", "send-command", cmd];
	console.log(`  server> ${cmd}`);
	if (process.platform === "win32") execFileSync("wsl", ["-e", "docker", ...args]);
	else execFileSync("docker", args);
}

async function main() {
	const driver = new BedrockDriver({ address: ADDRESS, name: NAME, viaWsl: VIA_WSL });
	await driver.connect();
	await sleep(15_000); // 前の同名セッションが抜けるのを待つ
	const p = driver.getState().position;
	const f = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
	console.log(`[drop-test] 足元 (${f.x}, ${f.y}, ${f.z})`);
	server(`clear ${NAME}`);
	server("kill @e[type=item]");
	server(`give ${NAME} wooden_pickaxe 1`);
	// 目の前(2ブロック先、足の高さ)に土と石を1つずつ置く。
	const dirt = { x: f.x + 2, y: f.y, z: f.z };
	const stone = { x: f.x + 2, y: f.y, z: f.z + 2 };
	// 床の石。掘ると丸石は穴の底に落ちる。採点の cobble はこの形で 0/6 だった。
	const floor = { x: f.x - 2, y: f.y - 1, z: f.z };
	server(`setblock ${dirt.x} ${dirt.y} ${dirt.z} dirt`);
	server(`setblock ${stone.x} ${stone.y} ${stone.z} stone`);
	server(`setblock ${floor.x} ${floor.y} ${floor.z} stone`);
	await sleep(4_000);

	const ac = new AbortController();
	const items = () =>
		driver
			.nearbyEntities(8)
			.filter((e) => e.kind === "item" || (e as { isItem?: boolean }).isItem)
			.map((e) => e.name);
	const inv = () =>
		driver.inventory
			.items()
			.map((i) => `${i.name}x${i.count}`)
			.join(",");

	for (const [label, pos, tool] of [
		["dirt(素手)", dirt, false],
		["stone(木のツルハシ)", stone, true],
		["床のstone(木のツルハシ、穴の底に落ちる)", floor, true],
	] as const) {
		console.log(`\n== ${label} at (${pos.x}, ${pos.y}, ${pos.z})`);
		console.log(`  写し: ${driver.world.blockAt(pos)?.name ?? "unknown"}`);
		if (tool) {
			await driver.equipBestTool(pos);
			await sleep(500);
		} else {
			await driver.equip("wooden_pickaxe", "hand").catch(() => {});
			// 素手にしたいので、空の枠を持つ: 8番は空のはず
			await (driver as unknown as { sidecar: { send: (c: string, a: object) => Promise<unknown> } }).sidecar.send(
				"hold",
				{ count: 8 },
			);
			await sleep(500);
		}
		console.log(`  持ち物(前): ${inv()}`);
		const t = Date.now();
		try {
			await driver.dig(ac.signal, pos);
			console.log(`  掘れた (${Date.now() - t}ms)`);
		} catch (e) {
			console.log(`  掘れない: ${e}`);
			continue;
		}
		for (let i = 0; i < 6; i++) {
			await sleep(500);
			await (driver as unknown as { refresh: () => Promise<void> }).refresh();
			const seen = items();
			if (seen.length > 0) {
				console.log(`  落下物 ${(i + 1) * 500}ms後: ${seen.join(",")}`);
				break;
			}
			if (i === 5) console.log("  落下物: 3秒待っても現れない");
		}
		await driver.pickupNearbyItems(ac.signal).catch(() => {});
		await sleep(1_000);
		console.log(`  持ち物(後): ${inv()}`);
	}

	server(`setblock ${dirt.x} ${dirt.y} ${dirt.z} air`);
	server(`setblock ${stone.x} ${stone.y} ${stone.z} air`);
	server(`setblock ${floor.x} ${floor.y} ${floor.z} grass_block`);
	await driver.disconnect();
	process.exit(0);
}

main().catch((e) => {
	console.error("[drop-test] 失敗:", e);
	process.exit(1);
});
