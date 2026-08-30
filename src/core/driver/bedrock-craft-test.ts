/**
 * 木を掘って木材にするところまでを通しで見る。
 *
 * クラフトの検証にはサーバーのコンソールからアイテムを配るのが早いが、
 * Windows で直接動かしているサーバーにはこちらから打てない。採掘と回収は
 * 動いているので、ボット自身に丸太を集めさせて自己完結させる。
 *
 * 実行:
 *   BEDROCK_ADDRESS=127.0.0.1:19132 npx tsx src/core/driver/bedrock-craft-test.ts
 */
import { BedrockDriver } from "./bedrock";

const ADDRESS = process.env.BEDROCK_ADDRESS ?? "127.0.0.1:19132";
// Windows で直接動かしているサーバーへ繋ぐので、既定では WSL を経由しない。
const VIA_WSL = (process.env.BEDROCK_WSL ?? "0") === "1";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
	const driver = new BedrockDriver({ address: ADDRESS, name: "crafter", viaWsl: VIA_WSL });
	console.log(`[craft-test] ${ADDRESS} へ接続します`);
	await driver.connect();
	await sleep(2000);

	const ac = new AbortController();

	// サーバーのコンソールから配ってもらう場合はここで待つ。
	// GIVE_WAIT_SECONDS を指定すると、その間だけ持ち物が増えるのを待つ。
	const waitFor = Number(process.env.GIVE_WAIT_SECONDS ?? 0);
	if (waitFor > 0) {
		console.log(
			`  サーバーのコンソールで give crafter oak_log 8 を打ってください（${waitFor}秒待ちます）`,
		);
		for (let i = 0; i < waitFor * 2; i++) {
			if (driver.inventory.items().length > 0) break;
			await sleep(500);
		}
	}

	// 丸太を持っていなければ掘りに行く。
	let logs = driver.inventory.items().filter((i) => i.name.endsWith("_log"));
	if (logs.length === 0 && waitFor === 0) {
		const target = driver.world.findBlocksMatching((n) => n.endsWith("_log"), 24, 1)[0];
		if (!target) {
			console.log("  近くに木がありません");
			await driver.disconnect();
			process.exit(1);
		}
		console.log(
			`  ${target.name} を掘りに行きます (${target.position.x}, ${target.position.y}, ${target.position.z})`,
		);
		try {
			await driver.goto(ac.signal, {
				kind: "xz",
				x: target.position.x,
				z: target.position.z,
				distance: 2,
			});
		} catch (e) {
			console.log(`  近づけませんでした: ${e}`);
		}
		await driver.dig(ac.signal, target.position);
		await driver.pickupNearbyItems(ac.signal);
		logs = driver.inventory.items().filter((i) => i.name.endsWith("_log"));
	}

	console.log(
		`  持ち物: ${
			driver.inventory
				.items()
				.map((i) => `${i.name}x${i.count}`)
				.join(", ") || "なし"
		}`,
	);
	if (logs.length === 0) {
		console.log("  丸太を集められませんでした");
		await driver.disconnect();
		process.exit(1);
	}

	const planks = `${logs[0].name.replace(/_log$/, "")}_planks`;
	console.log(`  ${planks} が作れるか: ${driver.canCraft(planks)}`);

	try {
		await driver.craft(planks, 1);
		const after = driver.inventory.items().find((i) => i.name === planks);
		if (after) {
			console.log(`\nクラフトできました: ${after.name} x${after.count}`);
			await driver.disconnect();
			process.exit(0);
		}
		console.log("\n拒否はされなかったが、持ち物に増えていません");
	} catch (e) {
		console.log(`\nクラフトできません: ${e}`);
	}
	await driver.disconnect();
	process.exit(1);
}

main().catch((e) => {
	console.error("[craft-test] 失敗:", e);
	process.exit(1);
});
