/**
 * 食べられるかを、ローカルの開発サーバーで確かめる。
 *
 * なぜ要るか。2026-09-01 に eat を入れてから、本番の全ログで食事の成功は 0 回、
 * 失敗は 63 回(「満腹度が上がらない」)。満腹度 18 未満では体力が自然回復
 * しないので、これが通らない限り一度削られた体力は死ぬまで戻らない。
 * LLM を介さず直接ドライバを叩く。思考ループ越しでは実装の欠陥と LLM の
 * 選択を切り分けられない。
 *
 * 実行(ローカル専用):
 *   docker compose -f docker-compose.bedrock-dev.yml up -d
 *   npx tsx src/core/driver/bedrock-eat-check.ts
 *   # 別の端末から、食べ物を渡して満腹度を減らす:
 *   #   docker exec onj-bedrock-dev send-command "give eatcheck cooked_beef 8"
 *   #   docker exec onj-bedrock-dev send-command "effect eatcheck hunger 5 60"
 *
 * 本番 Realm には繋がない(接続先はローカル固定)。
 */
import { BedrockDriver } from "./bedrock";

const ADDRESS = process.env.BEDROCK_ADDRESS ?? "127.0.0.1:19132";
const VIA_WSL = (process.env.BEDROCK_WSL ?? (process.platform === "win32" ? "1" : "0")) === "1";
const NAME = process.env.EAT_CHECK_NAME ?? "eatcheck";
/** 食べ物が渡され、満腹度が減るのを待つ時間。 */
const WAIT_MS = Number(process.env.WAIT_FOOD_MS ?? 90_000);
const ATTEMPTS = Number(process.env.EAT_ATTEMPTS ?? 3);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
	if (!ADDRESS.startsWith("127.0.0.1") && !ADDRESS.startsWith("localhost")) {
		throw new Error(`eat-check はローカル専用です (BEDROCK_ADDRESS=${ADDRESS})`);
	}
	const driver = new BedrockDriver({ address: ADDRESS, name: NAME, viaWsl: VIA_WSL });
	console.log(`[eat-check] ${ADDRESS} へ ${NAME} として接続します`);
	await driver.connect();
	await sleep(3000);
	console.log("READY");

	const foods = () =>
		driver.inventory
			.items()
			.filter((i) =>
				/beef|porkchop|mutton|chicken|bread|apple|carrot|potato|rotten_flesh/.test(i.name),
			);

	const until = Date.now() + WAIT_MS;
	while (Date.now() < until) {
		await (driver as unknown as { refresh(): Promise<void> }).refresh();
		const s = driver.getState();
		if (foods().length > 0 && s.food < 20) break;
		console.log(
			`  待機: 満腹度 ${s.food} 食べ物 ${
				foods()
					.map((i) => `${i.name} x${i.count}`)
					.join(", ") || "なし"
			}`,
		);
		await sleep(3000);
	}
	await (driver as unknown as { refresh(): Promise<void> }).refresh();
	if (foods().length === 0 || driver.getState().food >= 20) {
		console.log("  食べ物が無いか満腹のまま。give / effect してください");
		await driver.disconnect();
		process.exit(2);
	}

	const signal = new AbortController().signal;
	let successes = 0;
	for (let n = 1; n <= ATTEMPTS; n++) {
		await (driver as unknown as { refresh(): Promise<void> }).refresh();
		const before = driver.getState().food;
		const item = foods()[0];
		const countBefore = item?.count ?? 0;
		const t0 = Date.now();
		let ok = false;
		let err = "";
		try {
			ok = await driver.eat(signal, item?.name);
		} catch (e) {
			err = e instanceof Error ? e.message : String(e);
		}
		await sleep(1000);
		await (driver as unknown as { refresh(): Promise<void> }).refresh();
		const after = driver.getState().food;
		const countAfter = foods().find((i) => i.name === item?.name)?.count ?? 0;
		console.log(
			`  ${n}回目: ${item?.name} 満腹度 ${before} → ${after}、個数 ${countBefore} → ${countAfter}、eat()=${ok}${err ? ` エラー: ${err}` : ""} (${Date.now() - t0}ms)`,
		);
		if (after > before || countAfter < countBefore) successes++;
		if (after >= 20) break;
		await sleep(1500);
	}

	console.log("");
	console.log(
		successes > 0
			? `食事は通っている (${successes} 回)`
			: "食事が通っていない(満腹度も個数も変わらない)",
	);
	await driver.disconnect();
	process.exit(successes > 0 ? 0 : 1);
}

main().catch((err) => {
	console.error("[eat-check] 失敗:", err);
	process.exit(1);
});
