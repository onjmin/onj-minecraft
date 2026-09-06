/**
 * ゲーム内チャットを unj（うんでも実況J / board_id=1）のスレへそのまま中継する。
 * 発言に解説等を加えているわけではなく無加工の転記なので、本文は「実況」ではなく
 * 「中継」と表記する（タイトルの「実況」は板文化上のジャンル呼称として維持。実際に
 * 流しているのはkusa鯖のログなので、タイトル・本文とも「マイクラ」ではなく
 * サーバー名の「kusa鯖」で呼ぶ）。
 *
 * unj側に用意された管理API（/thread/make, /thread/res）へ直接resをINSERTする。
 * 次スレへの切り替えはunj側のnext-thread.ts（1000/1001レス目到達で自動生成）に
 * 一任している。/thread/res のレスポンスに nextThreadId が入っていたら、以後は
 * そちらへ投稿する（board_id=1は人間も書き込む共有板なので、レス数はこちら発
 * 以外の投稿でも進む。ローカルで回数を数えて先回りローテーションはしない）。
 *
 * UNJ_BASE_URL / UNJ_ADMIN_API_KEY が未設定なら何もしない
 * （discord-webhook.tsと同じ「webhook未設定なら黙って何もしない」流儀）。
 */
import fs from "node:fs";
import path from "node:path";
import { envStr } from "./env.js";

const UNJ_BASE_URL = envStr("UNJ_BASE_URL", "");
const UNJ_ADMIN_API_KEY = envStr("UNJ_ADMIN_API_KEY", "");

const UNJ_BOARD_ID = 1; // うんでも実況J
// isMax()は1000到達で締まる。admin/thread/res.tsはisOwner=false固定で判定される
// ため+5の猶予も無く、上限到達後は応答すら返ってこない（res.status()を呼ばず
// returnするだけの実装）。ただしそのちょうど1000到達の投稿自体はnext-thread.tsが
// 拾って次スレを自動生成し、レスポンスのnextThreadIdで教えてくれるので、通常は
// このタイムアウトに引っかかる前に次スレへ切り替わる。
const FETCH_TIMEOUT_MS = 8000;

const statePath = path.join(process.cwd(), "logs", "unj-thread.json");

interface ThreadState {
	threadId: string; // unjが払い出す符号化済みID
	part: number; // 表示用の通し番号（kusa鯖実況 part1, part2, ...）
	lastSeenNum?: number; // unj-relay.tsが中継済みのres番号（人間発言のみ。スレが変われば0からやり直す）
}

function loadState(): ThreadState | null {
	try {
		return JSON.parse(fs.readFileSync(statePath, "utf8")) as ThreadState;
	} catch {
		return null;
	}
}

function saveState(state: ThreadState): void {
	try {
		fs.mkdirSync(path.dirname(statePath), { recursive: true });
		// writeFileSyncの直接上書きは非atomicで、書き込み途中にプロセスが
		// 落ちると壊れたJSONが残り、次回loadState()がparse失敗→nullを
		// 返して「スレ無し」と誤認し、新スレを作ってしまう。tmpに書いてから
		// renameすれば、renameはOSレベルでatomicなので中途半端な状態が
		// 残らない（多重プロセス化の再発防止とは別レイヤーの保険）。
		const tmpPath = `${statePath}.${process.pid}.tmp`;
		fs.writeFileSync(tmpPath, JSON.stringify(state), "utf8");
		fs.renameSync(tmpPath, statePath);
	} catch (e) {
		console.error("[UnjBridge] Failed to save state:", e);
	}
}

interface ApiResponse<T> {
	/** HTTPステータス。0は応答すら得られなかった場合（通信失敗・タイムアウト）。 */
	status: number;
	data: T | null;
}

// エラー応答でも本文を読む。unj側は「スレが埋まった」を409+reasonで返すので、
// 通信失敗（status=0）と区別できないと次スレへ移る判断ができない。
async function callAdminApi<T>(apiPath: string, body: unknown): Promise<ApiResponse<T>> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(new URL(apiPath, UNJ_BASE_URL), {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: UNJ_ADMIN_API_KEY,
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		const data = (await res.json().catch(() => null)) as T | null;
		if (!res.ok) console.error(`[UnjBridge] ${apiPath} -> HTTP ${res.status}`);
		return { status: res.status, data };
	} catch (e) {
		console.error(`[UnjBridge] ${apiPath} failed:`, e);
		return { status: 0, data: null };
	} finally {
		clearTimeout(timer);
	}
}

/** GET版。unj-relay.ts（unj→Minecraft方向のポーリング）から使う。 */
async function callAdminApiGet<T>(
	apiPath: string,
	params: Record<string, string>,
): Promise<T | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const url = new URL(apiPath, UNJ_BASE_URL);
		for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
		const res = await fetch(url, {
			method: "GET",
			headers: { Authorization: UNJ_ADMIN_API_KEY },
			signal: controller.signal,
		});
		if (!res.ok) {
			console.error(`[UnjBridge] GET ${apiPath} -> HTTP ${res.status}`);
			return null;
		}
		return (await res.json()) as T;
	} catch (e) {
		console.error(`[UnjBridge] GET ${apiPath} failed:`, e);
		return null;
	} finally {
		clearTimeout(timer);
	}
}

// 同時に複数チャットが飛んできても新スレ作成が重複しないよう、1本化する
let creating: Promise<ThreadState | null> | null = null;

function createThread(): Promise<ThreadState | null> {
	if (creating) return creating;
	const prevPart = loadState()?.part ?? 0;
	const part = prevPart + 1;
	// 実際に流しているのはkusa鯖のログなので、汎用的な「マイクラ」ではなく
	// サーバー名で呼ぶ。
	//
	// 番号は「(2)」ではなく「part2」形式。unjの一覧はタイトル末尾に
	// レス数を (N) で出すため、(2) 形式だと「kusa鯖実況 (2) (5)」と二重に
	// なって紛らわしい。初代もpart1とする（番号なしにすると、unj側の
	// next-thread.tsが次スレを自動命名するときに part 形式を継げない）。
	const title = `kusa鯖実況 part${part}`.slice(0, 32);

	const task = (async (): Promise<ThreadState | null> => {
		const result = await callAdminApi<{ thread: { id: string } }>("/api/admin/thread/make", {
			boardId: UNJ_BOARD_ID,
			title,
			ccUserId: "",
			ccUserName: "kusabot",
			ccUserAvatar: 0,
			contentText: "kusa鯖の会話をそのまま中継するスレ。埋まったら次スレへ。",
			contentUrl: "",
			contentData: "",
			contentType: 1, // Enum.Text
			// admin/thread/make.tsはccBitmask省略時1(ID表示のみ)をデフォルトにするが、
			// これはWeb UIのスレ立てページの初期値[1,4,8]=13(ID表示+コテハン可+
			// アイコン可)と異なる。ccBitmaskはスレ側の設定としてDBに保存され、人間が
			// このスレへ返信する時の名前欄・アイコン欄の可否を左右する(bot自身の投稿は
			// admin/thread/res.tsがccUserName/ccUserAvatarをそのまま素通しするので
			// 無関係)。省略すると人間の返信時にコテ禁・アイコン禁止になってしまうため、
			// Web UI標準と揃える。
			ccBitmask: 1 | 4 | 8,
		});
		if (result.status !== 200 || !result.data) return null;
		const state: ThreadState = { threadId: result.data.thread.id, part };
		saveState(state);
		return state;
	})();

	creating = task;
	task.finally(() => {
		creating = null;
	});
	return task;
}

/** 成功(200)と拒否(409/410)の両方を1つの形で受ける。 */
interface PostResBody {
	res?: { num: number };
	// 今回の投稿が1000/1001レス目になり、unj側が次スレを自動生成したときに入る。
	// 409(reason=max)でも、既に次スレがあれば入る。
	nextThreadId?: string | null;
	// もう書けない理由。unj側 admin/thread/res.ts が返す。
	reason?: "max" | "bals" | "deleted";
	error?: unknown;
}

async function postRes(
	state: ThreadState,
	speaker: string,
	message: string,
): Promise<ApiResponse<PostResBody>> {
	return await callAdminApi<PostResBody>("/api/admin/thread/res", {
		threadId: state.threadId,
		ccUserId: "",
		ccUserName: speaker.slice(0, 32),
		ccUserAvatar: 0,
		contentText: message.slice(0, 1024),
		contentUrl: "",
		contentData: "",
		contentType: 1, // Enum.Text
		// このスレは実況を見てもらうためのものなので上げてよい（ユーザー指示）。
		// 省略時はunj側がtrue（上げない）を既定にするので、明示的にfalseを渡す。
		sage: false,
	});
}

// 投稿は必ず1件ずつ直列に送る。
//
// 呼び出し元(chat-log.ts)は `void postToUnj(...)` と投げっぱなしにするため、
// 何もしないと複数のチャット行が同時にunjへ飛ぶ。admin/thread/res.tsはレス番号を
// (SELECT COALESCE(MAX(num), 1) + 1 FROM res WHERE thread_id = $1) で採番し、
// resテーブルには UNIQUE (thread_id, num) が張られているので、同時に走った2件は
// 同じnumを掴んで一意制約違反になり、片方がROLLBACKされて発言が消える。
// 直列化すれば採番が衝突しないうえ、チャットの並び順もそのまま保たれる。
let queue: Promise<void> = Promise.resolve();

/**
 * ゲーム内チャット1行をunjのスレへレスとして流す。
 * 失敗しても呼び出し元を止めない（記録目的の副作用のため）。
 */
export function postToUnj(speaker: string, message: string): Promise<void> {
	if (!UNJ_BASE_URL || !UNJ_ADMIN_API_KEY) return Promise.resolve();
	const task = queue.then(() => postOne(speaker, message));
	// 1件が失敗しても後続を止めない（queueは常に解決済みで繋ぐ）
	queue = task.catch(() => {});
	return task;
}

async function postOne(speaker: string, message: string): Promise<void> {
	let state = loadState();
	if (!state) {
		state = await createThread();
		if (!state) return;
	}

	const result = await postRes(state, speaker, message);

	if (result.status === 200) {
		// unj側(next-thread.ts)が1000/1001レス目で次スレを自動生成した場合、以後はそちらへ
		if (result.data?.nextThreadId) {
			saveState({ threadId: result.data.nextThreadId, part: state.part + 1 });
		}
		return;
	}

	// スレが埋まった。新スレへ移ってよいのはこの場合だけ。
	//
	// 自分の投稿が1000レス目になったときは200+nextThreadIdで拾えるが、
	// board_id=1は共有板なので人間が1000レス目を取ることもある。そのときは
	// 次の投稿がここに来る（unj側が409/reason=maxで明示的に教えてくれる）。
	if (result.status === 409 && result.data?.reason === "max") {
		const next = result.data.nextThreadId;
		if (next) {
			saveState({ threadId: next, part: state.part + 1 });
		} else if (!(await createThread())) {
			return; // 立て直せなければ諦める
		}
		const moved = loadState();
		if (moved) await postRes(moved, speaker, message); // 移った先へ送り直す
		return;
	}

	// 消えた/バルス/通信失敗/タイムアウト/unjダウン等。
	// 通信失敗やタイムアウトはDB自体が死んでいるのと同じで、新スレを立てても
	// 同じ理由で失敗するだけ（かつ無駄なスレを増やす）。削除・バルスは応答が
	// 返っている以上DBは生きているが、「埋まった以外を理由に新スレを立てない」
	// 方針に従い、ここでは何もしない。記録目的の副作用なので諦めてよい。
	if (result.data?.reason) {
		console.error(`[UnjBridge] このスレにはもう書けない (reason=${result.data.reason})`);
	}
}

export interface UnjHumanRes {
	num: number;
	ccUserName: string;
	contentText: string;
}

/** unj連携が設定済みかどうか。unj-relay.ts側のポーリング要否の判定に使う。 */
export function isUnjBridgeConfigured(): boolean {
	return !!(UNJ_BASE_URL && UNJ_ADMIN_API_KEY);
}

/**
 * 現在postToUnjが投稿しているスレのうち、まだ中継していない人間発言を取得する。
 * まだスレが無い（一度も発言していない）ならnull。
 * threadIdも一緒に返す。取得後にmarkRelayed()へそのまま渡すことで、
 * 巡回中にスレが切り替わっても誤ったスレの既読位置を進めないようにする。
 */
export async function fetchNewHumanRes(): Promise<{
	threadId: string;
	list: UnjHumanRes[];
} | null> {
	const state = loadState();
	if (!state) return null;
	const result = await callAdminApiGet<{ list: UnjHumanRes[] }>("/api/admin/thread/res", {
		threadId: state.threadId,
		sinceNum: String(state.lastSeenNum ?? 0),
	});
	if (!result?.list) return null;
	return { threadId: state.threadId, list: result.list };
}

/**
 * 中継済みのres番号を記録する。取得後にスレが切り替わっていたら
 * （postToUnjが並行して次スレへ移った等）、古いスレの番号を書き込んで
 * 事故らないよう、対象スレIDが今と一致するときだけ書き込む。
 */
export function markRelayed(threadId: string, num: number): void {
	const state = loadState();
	if (!state || state.threadId !== threadId) return;
	if ((state.lastSeenNum ?? 0) >= num) return;
	saveState({ ...state, lastSeenNum: num });
}
