/**
 * logs/metrics-*.json を期間で合計する。survival-report.sh から呼ばれる。
 *
 * 各セッションが自分で書いた計測を足し合わせるだけ。ログの grep では
 * 出せない「稼働時間あたりの死亡率」を出すのが目的。
 *
 *   node scripts/survival-metrics.js <logDir> <since>
 *
 * since はエポックミリ秒か、Date が解せる文字列。
 */
const fs = require("node:fs");
const path = require("node:path");

const dir = process.argv[2];
const rawSince = process.argv[3] ?? "";
const since = /^\d+$/.test(rawSince) ? Number(rawSince) : new Date(rawSince).getTime();

if (!dir || Number.isNaN(since)) {
	console.error("使い方: node scripts/survival-metrics.js <logDir> <since>");
	process.exit(1);
}

let uptimeMs = 0;
let deaths = 0;
let meals = 0;
let sessions = 0;
let longestStallMs = 0;

for (const name of fs.readdirSync(dir)) {
	if (!/^metrics-.*\.json$/.test(name)) continue;
	const file = path.join(dir, name);
	// ファイル名の数字はセッションIDで時刻ではない。更新時刻で絞る。
	if (fs.statSync(file).mtimeMs < since) continue;
	let m;
	try {
		m = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		continue;
	}
	uptimeMs += m.uptimeMs || 0;
	deaths += m.deaths || 0;
	meals += m.meals || 0;
	longestStallMs = Math.max(longestStallMs, m.longestStallMs || 0);
	sessions++;
}

const hours = uptimeMs / 3600000;
const pad = (label, value) => console.log(`${label.padEnd(20)}: ${value}`);

pad("セッション数", sessions);
pad("稼働の合計", `${hours.toFixed(2)}h`);
pad("死亡の合計", deaths);
pad("死亡率", hours > 0 ? `${(deaths / hours).toFixed(2)} 回/h` : "?");
pad("食事の合計", meals);
pad("最長停滞", `${(longestStallMs / 60000).toFixed(1)}分`);
