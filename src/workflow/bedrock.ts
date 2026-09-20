/**
 * 統合版(Bedrock)Realms でエージェントを1体動かす入り口。
 *
 * 実行:
 *   REALM_INVITE=https://realms.gg/xxxx npx tsx src/workflow/bedrock.ts
 *
 * Java版(src/workflow/index.ts)との違いは、mineflayer のボットを作らず
 * BedrockDriver を注入する点だけ。LLM層・プロフィール・スキルは共通のものを使う。
 *
 * 接続とプロトコルは Go サイドカーが持つ。移動・状態・持ち物・エンティティ・
 * 発言・ワールド読み取り・採掘・設置・クラフト・攻撃まで通っている。
 */
import { MinecraftAgent } from "../core/agent";
import { BedrockDriver } from "../core/driver/bedrock";
import { envNum } from "../core/utils/env";
import { kusabot } from "../profiles/kusabot";
import { isAddressedToBot, isLeaveRequest, shouldYieldSeat } from "./bedrock-session";
import { bedrockSkills } from "./bedrock-skills";

/** 席を譲って抜けたときの終了コード。呼び出し側が再入場の判断に使う。 */
const EXIT_YIELDED = 3;

async function main() {
	const invite = process.env.REALM_INVITE;
	if (!invite) throw new Error("REALM_INVITE を指定してください");

	// 統合版は1体だけで、話し相手は日本語話者の人間。
	// 複数体の社会シミュレーション向けに書かれた既存キャラではなく専用の人格を使う。
	const profile = kusabot;

	const driver = new BedrockDriver({
		realmInvite: invite,
		onMsaCode: (m) => console.log("要サインイン:", m),
	});

	const agent = new MinecraftAgent(profile, bedrockSkills as any[], driver);

	console.log(`[bedrock] ${profile.displayName} を Realm に接続します...`);
	await driver.connect();
	// どのアカウントで入ったかを必ず残す。トークンファイルの存在は根拠に
	// ならない(AGENTS.md)。管理者アカウントで本番の世界に入っていないかを、
	// ログを見るだけで確かめられるようにしておく。
	console.log(
		`[bedrock] スポーン完了。接続アカウント: ${driver.getState().username}。ループを開始します。`,
	);

	// 統合版は接続完了のタイミングを呼び出し側が握っているので明示的に起動する
	agent.startLoops();

	// Realms は10人まで。ボットが1枠を占め続けると人が入れなくなるので、
	// 混んできたら自分から抜けて、空いたころに戻る。
	let yielding = false;
	// say は抜ける前の一言。理由が違うのに「混んできた」と言うと嘘になる。
	const yieldSeat = async (why: string, say = "混んできたので抜けるね。また来る") => {
		if (yielding) return;
		yielding = true;
		console.log(`[bedrock] ${why}。席を譲って抜けます`);
		try {
			await driver.chat(say);
		} catch {
			// 言えなくても抜ける方が大事。
		}
		agent.cancelAllTasks();
		await driver.disconnect();
		// 抜けたあとは、この工程を終える。戻るのは呼び出し側の仕事。
		process.exit(EXIT_YIELDED);
	};

	driver.on("players", (names: string[]) => {
		const self = driver.getState().username;
		if (shouldYieldSeat(driver, self)) {
			void yieldSeat(`${names.length}人になった`);
		}
	});

	// 自分がいつ発言したかを控える。直後の「やめて」は自分への返事の可能性が高い。
	let botSpokeAt: number | null = null;
	const originalChat = driver.chat.bind(driver);
	driver.chat = async (message: string) => {
		botSpokeAt = Date.now();
		return originalChat(message);
	};

	// 「抜けて」と言われたら、次の思考を待たずに抜ける。
	//
	// ただし自分宛てのときだけ。他プレイヤー同士の PK で出た「やめてね」を
	// 拾って抜けたことがある(2026-09-19)。宛先の判断は isAddressedToBot。
	driver.on("chat", (from: string, message: string) => {
		if (!isLeaveRequest(message)) return;
		const speaker = driver
			.nearbyEntities(64)
			.find((e) => e.kind === "player" && e.username === from);
		const me = driver.getState().position;
		const speakerDistance = speaker
			? Math.hypot(speaker.position.x - me.x, speaker.position.y - me.y, speaker.position.z - me.z)
			: null;
		const addressed = isAddressedToBot(message, {
			selfName: driver.getState().username,
			botSpokeAgoMs: botSpokeAt === null ? null : Date.now() - botSpokeAt,
			speakerDistance,
		});
		if (!addressed) {
			console.log(`[bedrock] ${from} の「${message}」は自分宛てではないと判断して残る`);
			return;
		}
		void yieldSeat(`${from} に退出を頼まれた`);
	});

	// 誰かが寝ているのに近くにベッドが無くて自分は寝られなかったら、
	// 居座らず席を譲って抜ける。agent 側は近くのベッドを探して自分も
	// 寝ようとするが、届く範囲に無ければそこで諦める(agent.ts の
	// sleepIfOthersSleeping)。その通知をここで受けて実際に抜ける。
	agent.onNoBedForSleep = () => {
		void yieldSeat("寝られる場所が無い");
	};

	// 死に続けているなら一度抜ける。死亡ログは周りの全員のチャット欄に
	// 流れるので、直せないまま居座ると迷惑をかけ続けることになる。
	// 戻るのは run-bedrock.sh(終了コード3)が時間を置いてやる。
	agent.onDeathStorm = (count: number) => {
		void yieldSeat(`短時間に${count}回死んだ`, "何度も死んで邪魔になってるから一旦抜ける");
	};

	// 切断に気づかず空回りし続けるのを防ぐ。
	// BedrockX は接続断を必ずしもイベントで教えてくれないため、
	// Driver 側の無通信監視も含めてここで受ける。
	driver.on("end", (reason: string) => {
		// 自分から席を譲って切った場合は、その終了コード(EXIT_YIELDED)で終える。
		// disconnect() の途中でここが先に走り、code=1 で「異常終了」扱いになって
		// 30秒で戻っていた(実測 2026-09-20 21:27)。譲ったのなら2分置く。
		if (yielding) {
			console.log(`[bedrock] 席を譲って切断した: ${reason}`);
			process.exit(EXIT_YIELDED);
		}
		console.log(`[bedrock] 切断されました: ${reason}`);
		console.log("[bedrock] 直近に受信したパケット:");
		for (const line of driver.recentPackets.slice(-25)) console.log(`  ${line}`);
		agent.cancelAllTasks();
		process.exit(1);
	});

	const shutdown = async () => {
		console.log("\n[bedrock] 終了します");
		agent.cancelAllTasks();
		await driver.disconnect();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	// 実行時間の上限。未指定なら回し続ける。
	const limit = envNum("RUN_SECONDS", 0);
	if (limit > 0) {
		setTimeout(shutdown, limit * 1000);
	}
}

main().catch((e) => {
	console.error("[bedrock] 起動に失敗:", e);
	process.exit(1);
});
