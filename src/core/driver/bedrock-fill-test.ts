/**
 * /fill でまとめて書き換えた地形が、ボットの写しに届くかを確かめる。
 *
 * 実測 2026-09-20 02:24、足元の草を 41x41 の石に fill しても、スキルは
 * 「石が無い」と言い続けた。石室(数列 x 21層)の fill は写しに届いていた
 * (写しの天井=stone)ので、広い一層の書き換えだけが落ちている疑い。
 *
 * 実行: npx tsx src/core/driver/bedrock-fill-test.ts
 */
import { execFileSync } from "node:child_process";
import { BedrockDriver } from "./bedrock";

const ADDRESS = process.env.BEDROCK_ADDRESS ?? "127.0.0.1:19132";
const VIA_WSL = (process.env.BEDROCK_WSL ?? (process.platform === "win32" ? "1" : "0")) === "1";
const NAME = "filltester";
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
	await sleep(15_000);
	const p = driver.getState().position;
	const f = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
	console.log(`[fill-test] 足元 (${f.x}, ${f.y}, ${f.z}) 足元ブロック=${driver.world.blockAt({ x: f.x, y: f.y - 1, z: f.z })?.name}`);
	const probe = [
		{ x: f.x, y: f.y - 1, z: f.z },
		{ x: f.x + 3, y: f.y - 1, z: f.z },
		{ x: f.x + 12, y: f.y - 1, z: f.z + 12 },
		{ x: f.x - 18, y: f.y - 1, z: f.z + 5 },
	];
	const show = (label: string) => {
		const names = probe.map((q) => `${driver.world.blockAt(q)?.name ?? "?"}`).join(" ");
		const found = driver.world.findBlocks(["stone"], 8, 10).length;
		console.log(`  ${label}: 写し[${names}] findBlocks(stone,8)=${found}`);
	};

	for (const [label, size] of [
		["小(5x5)", 2],
		["中(21x21)", 10],
		["大(41x41)", 20],
	] as const) {
		server(`fill ${f.x - size} ${f.y - 1} ${f.z - size} ${f.x + size} ${f.y - 1} ${f.z + size} stone`);
		for (const t of [1, 3, 6, 10]) {
			await sleep(t === 1 ? 1000 : (t - (t === 3 ? 1 : t === 6 ? 3 : 6)) * 1000);
			show(`${label} ${t}s`);
		}
		server(`fill ${f.x - size} ${f.y - 1} ${f.z - size} ${f.x + size} ${f.y - 1} ${f.z + size} grass_block`);
		await sleep(3000);
	}
	await driver.disconnect();
	process.exit(0);
}

main().catch((e) => {
	console.error("[fill-test] 失敗:", e);
	process.exit(1);
});
