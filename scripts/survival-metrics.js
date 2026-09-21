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
// 空振り(empty)の合計。「走ったが世界が何も変わらなかった」回数。
//
// 成否(ok/fail)では空振りが見えない。スキルは自分の中の都合で成功を返すので、
// 到達圏内で即 ok を返す goto.coords が表では最高成績になる。実測 2026-09-21、
// goto.coords は 152 回中 113 回、goto.surface は 99 回中 75 回が empty だった。
let runs = 0;
let empty = 0;
const perSkill = new Map();

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
	for (const [name, s] of Object.entries(m.skills || {})) {
		runs += s.runs || 0;
		empty += s.empty || 0;
		const acc = perSkill.get(name) || { runs: 0, empty: 0 };
		acc.runs += s.runs || 0;
		acc.empty += s.empty || 0;
		perSkill.set(name, acc);
	}
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
pad("空振り", runs > 0 ? `${empty}/${runs} (${((empty / runs) * 100).toFixed(0)}%)` : "?");

// 空振りの多い順。どのスキルが時間を捨てているかを見る。
// 母数の小さいものは率が暴れるので 10 回以上に絞る。
const worst = [...perSkill.entries()]
	.filter(([, s]) => s.runs >= 10 && s.empty > 0)
	.sort((a, b) => b[1].empty - a[1].empty)
	.slice(0, 5);
if (worst.length > 0) {
	console.log("空振りの多い順:");
	for (const [name, s] of worst) {
		console.log(`  ${name.padEnd(24)} ${s.empty}/${s.runs} (${((s.empty / s.runs) * 100).toFixed(0)}%)`);
	}
}
