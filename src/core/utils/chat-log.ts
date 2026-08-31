/**
 * ゲーム内のやり取りを日付ごとのファイルに残す。
 *
 * 標準出力のログは実行のたびに流れて消えるうえ、思考やスキルの記録と
 * 混ざって読み返せない。会話だけを日付で分けて置いておく。
 */
import fs from "node:fs";
import path from "node:path";

const dir = path.join(process.cwd(), "logs", "chat");

/** その日のファイル名。日付が変わったら自動で次のファイルへ。 */
function fileForToday(): string {
	const now = new Date();
	const stamp = new Intl.DateTimeFormat("sv-SE", {
		timeZone: "Asia/Tokyo",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(now);
	return path.join(dir, `${stamp}.log`);
}

function timestamp(): string {
	return new Intl.DateTimeFormat("ja-JP", {
		timeZone: "Asia/Tokyo",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	}).format(new Date());
}

/**
 * 1行書く。direction は "in"(受信) か "out"(送信)。
 * 書けなくても呼び出し元を止めない。記録のために本筋が落ちるのは本末転倒。
 */
export function appendChatLog(direction: "in" | "out", speaker: string, message: string): void {
	try {
		fs.mkdirSync(dir, { recursive: true });
		const arrow = direction === "in" ? "<-" : "->";
		fs.appendFileSync(
			fileForToday(),
			`[${timestamp()}] ${arrow} <${speaker}> ${message}\n`,
			"utf8",
		);
	} catch {
		// 記録に失敗しても会話は続ける。
	}
}
