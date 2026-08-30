/**
 * 攻撃が通るかを見る。
 *
 * 統合版の攻撃は InventoryTransaction に載せる。届く距離まで寄ってから殴る
 * 必要があり、離れていると黙って無視される。ここでは近くの生き物を1体選び、
 * 寄って殴り、相手が減るか消えるかを見る。
 *
 * 実行:
 *   BEDROCK_ADDRESS=127.0.0.1:19132 npx tsx src/core/driver/bedrock-attack-test.ts
 */
import { BedrockDriver } from "./bedrock";

const ADDRESS = process.env.BEDROCK_ADDRESS ?? "127.0.0.1:19132";
const VIA_WSL = (process.env.BEDROCK_WSL ?? (process.platform === "win32" ? "1" : "0")) === "1";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
	const driver = new BedrockDriver({ address: ADDRESS, name: "attacker", viaWsl: VIA_WSL });
	console.log(`[attack-test] ${ADDRESS} へ接続します`);
	await driver.connect();
	await sleep(3000);

	const here = driver.getState().position;
	const targets = driver
		.nearbyEntities(48)
		.filter((e) => e.kind === "mob")
		.sort(
			(a, b) =>
				Math.hypot(a.position.x - here.x, a.position.z - here.z) -
				Math.hypot(b.position.x - here.x, b.position.z - here.z),
		);
	if (targets.length === 0) {
		console.log("  近くに生き物がいません");
		await driver.disconnect();
		process.exit(1);
	}

	const target = targets[0];
	const dist = Math.hypot(target.position.x - here.x, target.position.z - here.z);
	console.log(`  対象: ${target.name} (id=${target.id}) ${dist.toFixed(1)} ブロック先`);

	const ac = new AbortController();
	let hits = 0;
	let lastError = "";
	// 1発では倒れないので何度か殴る。相手も動くので都度寄り直す。
	for (let i = 0; i < 6; i++) {
		try {
			await driver.attack(ac.signal, target.id);
			hits++;
			console.log(`  ${i + 1}発目: 通った`);
		} catch (e) {
			lastError = String(e);
			console.log(`  ${i + 1}発目: ${lastError}`);
		}
		await sleep(700);
		// 相手が消えていれば倒せている。
		if (!driver.nearbyEntities(48).some((e) => e.id === target.id)) {
			console.log("  対象が消えました");
			break;
		}
	}

	console.log(hits > 0 ? `\n攻撃が通りました (${hits}回)` : "\n攻撃が通りません");
	await driver.disconnect();
	process.exit(hits > 0 ? 0 : 1);
}

main().catch((e) => {
	console.error("[attack-test] 失敗:", e);
	process.exit(1);
});
