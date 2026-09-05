/**
 * 実際のチャットログを、今の割り込み判定にそのまま食わせて確かめる道具。
 *
 * LLM もサーバーも使わない。looksAddressedToSelf / noteAddressed /
 * looksLikeMuteRequest という本物の関数を、ログの時刻を偽の時計にして回す。
 * 「どの発言に返事をするつもりだったか」を、実運用の前に目で見るためのもの。
 *
 * 使い方:
 *   npx tsx spikes/chat-gating-replay.ts logs/chat/2026-09-04.log
 *
 * 2026-09-04 のログは、修正前は「人間の発言 76 に対して返事 60」だった。
 * 他人同士の会話に割り込んで「てめーじゃねえよ」と言われている区間が
 * そのまま入っているので、直ったかどうかの物差しに使える。
 */
import fs from "node:fs";

// Date.now() を偽装してから読み込む。判定は全部これを見ている。
let fakeNow = 0;
const realNow = Date.now;
Date.now = () => fakeNow;

/** 判定に必要な口だけを持つ、繋がらない Driver。 */
const stubDriver = {
	on: () => {},
	off: () => {},
	getState: () => ({ username: "kusabot2361", isReady: true, health: 20 }),
	world: { findBlocksMatching: () => [] },
	chat: async () => {},
	// biome-ignore lint/suspicious/noExplicitAny: 検証用のはりぼて
} as any;

const LINE = /^\[(\d\d):(\d\d):(\d\d)\] <- <([^>]+)> (.*)$/;

// tsx が CJS で走るためトップレベル await が使えない。読み込みは中で行う。
async function main(): Promise<void> {
	const { MinecraftAgent } = await import("../src/core/agent.js");
	const { kusabot } = await import("../src/profiles/kusabot.js");

	const path = process.argv[2];
	if (!path) {
		console.error("使い方: npx tsx spikes/chat-gating-replay.ts <チャットログ>");
		process.exit(1);
	}

	// biome-ignore lint/suspicious/noExplicitAny: private を直に叩いて確かめる
	const agent = new MinecraftAgent(kusabot, [], stubDriver) as any;
	const conv = agent.conversation;

	let heard = 0;
	let answered = 0;
	let muteRequests = 0;

	for (const raw of fs.readFileSync(path, "utf8").split("\n")) {
		const m = raw.match(LINE);
		if (!m) continue;
		const [, hh, mm, ss, speaker, message] = m;
		// サーバー通知は会話ではない。返事の宛先にならないので数えない。
		if (speaker === "サーバー") continue;

		fakeNow = (Number(hh) * 3600 + Number(mm) * 60 + Number(ss)) * 1000;
		heard++;
		conv.record(speaker, message, "player");

		const head = `${hh}:${mm}:${ss} <${speaker}> ${message}`;

		if (agent.looksLikeMuteRequest(message) && agent.referencesBot(message)) {
			muteRequests++;
			agent.mutedUntil = fakeNow + 10 * 60_000;
			console.log(`${head}\n    -> 一度だけ謝って、以後10分黙る`);
			continue;
		}
		if (!agent.looksAddressedToSelf(speaker, message)) {
			console.log(`${head}\n    ... 黙る（自分宛ではない）`);
			continue;
		}
		if (fakeNow < agent.mutedUntil) {
			console.log(`${head}\n    ... 黙る（黙るように言われた直後）`);
			continue;
		}

		// 返事をしたことにして、本物の記録処理を通す。
		answered++;
		conv.record(kusabot.minecraftName, "(返事)", "self");
		agent.noteAddressed(speaker);
		console.log(`${head}\n    -> 返事する`);
	}

	Date.now = realNow;
	console.log(`\n人間の発言 ${heard} / 返事 ${answered} / 黙れと言われた ${muteRequests}`);
	process.exit(0);
}

void main();
