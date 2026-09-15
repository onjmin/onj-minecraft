import fs from "node:fs";
import path from "node:path";
import { looksLikeInjection, neutralizePlayerText } from "../src/core/conversation";

const dir = "logs/chat";
const msgs: { file: string; name: string; text: string }[] = [];
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".log"))) {
	const body = fs.readFileSync(path.join(dir, f), "utf8");
	for (const line of body.split(/\r?\n/)) {
		const m = line.match(/^\[[\d:]+\]\s+<-\s+<([^>]+)>\s+([\s\S]*)$/);
		if (!m) continue;
		if (m[1] === "サーバー") continue;
		msgs.push({ file: f, name: m[1], text: m[2] });
	}
}

let flagged = 0;
for (const m of msgs) {
	const body = neutralizePlayerText(m.text);
	if (!body) continue;
	if (looksLikeInjection(body)) {
		flagged++;
		console.log(`[${m.file}] <${m.name}> ${m.text.slice(0, 110)}`);
	}
}
console.log(`\n実発言 ${msgs.length} 件中 ${flagged} 件を検知`);
