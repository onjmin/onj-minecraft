/**
 * bedrockx に TURN(ICE) の修正を当てるスクリプト。
 *
 * なぜ .patch ではなくスクリプトなのか:
 *   bedrockx のソースは環境によって CRLF になったり LF になったりする。
 *   diff ベースの .patch は改行が一致しないと "different line endings" で
 *   丸ごと失敗するため、Windows で作った patch が Linux コンテナで当たらない。
 *   ここでは改行を正規化して照合し、元の改行を保って書き戻す。
 *
 * 何を直しているか:
 *   Realms が使うシグナリング(signal-jsonrpc.js)は、サーバーから受け取った
 *   TURN 認証情報を this.emit("credentials", []) と空配列で捨てていた。
 *   さらに nethernet のクライアントは RTCPeerConnection を
 *   iceServers: [] 固定で作っていた。
 *   結果として WebRTC が直接経路のみに依存し、中継へフォールバックできない。
 *   旧シグナリング(signal.js)には正しい実装があるので、それに揃える。
 *
 * 何度実行しても安全（適用済みなら何もしない）。
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = process.argv[2] ?? "node_modules/bedrockx";

/** 改行を LF に揃えた文字列を返す。照合用。 */
const normalize = (s) => s.replace(/\r\n/g, "\n");

/**
 * 改行の違いを無視して置換する。
 * 元ファイルが CRLF なら CRLF のまま書き戻す。
 */
function replaceInFile(relPath, edits) {
	const file = path.join(ROOT, relPath);
	if (!fs.existsSync(file)) {
		throw new Error(`対象が見つからない: ${file}`);
	}

	const raw = fs.readFileSync(file, "utf8");
	const isCrlf = raw.includes("\r\n");
	let body = normalize(raw);

	let applied = 0;
	for (const { find, replace, marker } of edits) {
		if (body.includes(marker)) continue; // 適用済み
		const needle = normalize(find);
		if (!body.includes(needle)) {
			throw new Error(`${relPath}: 想定する箇所が見つからない\n---\n${find.slice(0, 120)}`);
		}
		body = body.replace(needle, normalize(replace));
		applied++;
	}

	if (applied === 0) {
		console.log(`  ${relPath}: 適用済み（変更なし）`);
		return;
	}

	fs.writeFileSync(file, isCrlf ? body.replace(/\n/g, "\r\n") : body, "utf8");
	console.log(`  ${relPath}: ${applied}箇所を適用`);
}

console.log("bedrockx に TURN 修正を適用します");

replaceInFile("src/websocket/signal-jsonrpc.js", [
	{
		marker: "this.credentials = []",
		find: "        this.lastLiveness = 0\n        this.connectionId = null",
		replace:
			"        this.lastLiveness = 0\n        this.connectionId = null\n        this.credentials = []",
	},
	{
		marker: "this.emit(\"credentials\", this.credentials)",
		find:
			'        if (Array.isArray(message.result?.TurnAuthServers)) {\n' +
			'            this.emit("credentials", [])\n' +
			"            return\n        }",
		replace:
			"        if (Array.isArray(message.result?.TurnAuthServers)) {\n" +
			"            // TURN サーバーを受け取りながら捨てていたため、WebRTC が直接経路のみに\n" +
			"            // 依存し、経路が切れると connectionState=failed で復帰できなかった。\n" +
			"            this.credentials = message.result.TurnAuthServers\n" +
			"                .map(server => ({\n" +
			"                    urls: server?.Urls ?? [],\n" +
			'                    username: typeof server?.Username === "string" ? server.Username : undefined,\n' +
			'                    credential: typeof server?.Password === "string" ? server.Password\n' +
			'                        : (typeof server?.Credential === "string" ? server.Credential : undefined)\n' +
			"                }))\n" +
			"                .filter(server => Array.isArray(server.urls) ? server.urls.length > 0 : Boolean(server.urls))\n" +
			'            this.emit("credentials", this.credentials)\n' +
			"            return\n        }",
	},
]);

replaceInFile("src/nethernet/src/client.js", [
	{
		marker: "const iceServers = Array.isArray(this.credentials)",
		find:
			"    this.rtcConnection = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' })",
		replace:
			"    // 取得済みの TURN サーバーを渡す。空のままだと直接経路が切れた時点で\n" +
			"    // 中継へフォールバックできず connectionState=failed になる。\n" +
			"    const iceServers = Array.isArray(this.credentials) ? this.credentials : []\n" +
			"    this.rtcConnection = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' })",
	},
]);

console.log("完了");
