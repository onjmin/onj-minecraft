/**
 * ゲーム内チャットを unj（うんでも実況J / board_id=1）のスレへ実況として流す。
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
	part: number; // 表示用の通し番号（マイクラ実況 part1, part2, ...）
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
		fs.writeFileSync(statePath, JSON.stringify(state), "utf8");
	} catch (e) {
		console.error("[UnjBridge] Failed to save state:", e);
	}
}

async function callAdminApi<T>(apiPath: string, body: unknown): Promise<T | null> {
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
		if (!res.ok) {
			console.error(`[UnjBridge] ${apiPath} -> HTTP ${res.status}`);
			return null;
		}
		return (await res.json()) as T;
	} catch (e) {
		console.error(`[UnjBridge] ${apiPath} failed:`, e);
		return null;
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
	// unj側(next-thread.ts)の「スレタイ (2)」命名と揃える。初代のみ番号なし。
	const title = (part === 1 ? "マイクラ実況" : `マイクラ実況 (${part})`).slice(0, 32);

	const task = (async (): Promise<ThreadState | null> => {
		const result = await callAdminApi<{ thread: { id: string } }>("/api/admin/thread/make", {
			boardId: UNJ_BOARD_ID,
			title,
			ccUserId: "",
			ccUserName: "onj-minecraft",
			ccUserAvatar: 0,
			contentText: "マイクラの会話ログを実況するスレ。埋まったら次スレへ。",
			contentUrl: "",
			contentData: "",
			contentType: 1, // Enum.Text
		});
		if (!result) return null;
		const state: ThreadState = { threadId: result.thread.id, part };
		saveState(state);
		return state;
	})();

	creating = task;
	task.finally(() => {
		creating = null;
	});
	return task;
}

interface PostResResult {
	res: { num: number };
	// 今回の投稿が1000/1001レス目になり、unj側が次スレを自動生成したときだけ入る。
	nextThreadId: string | null;
}

async function postRes(
	state: ThreadState,
	speaker: string,
	message: string,
): Promise<PostResResult | null> {
	return await callAdminApi<PostResResult>("/api/admin/thread/res", {
		threadId: state.threadId,
		ccUserId: "",
		ccUserName: speaker.slice(0, 32),
		ccUserAvatar: 0,
		contentText: message.slice(0, 1024),
		contentUrl: "",
		contentData: "",
		contentType: 1, // Enum.Text
	});
}

/**
 * ゲーム内チャット1行をunjのスレへレスとして流す。
 * 失敗しても呼び出し元を止めない（記録目的の副作用のため）。
 */
export async function postToUnj(speaker: string, message: string): Promise<void> {
	if (!UNJ_BASE_URL || !UNJ_ADMIN_API_KEY) return;

	let state = loadState();
	if (!state) {
		state = await createThread();
		if (!state) return;
	}

	let result = await postRes(state, speaker, message);
	if (!result) {
		// 埋まった(unj側の次スレ生成が間に合わず取り残された等)/消えた/タイムアウトの
		// いずれか。復旧のため新しいスレを立てて1回だけ再送する。
		state = await createThread();
		if (!state) return;
		result = await postRes(state, speaker, message);
		if (!result) return;
	}

	// unj側(next-thread.ts)が1000/1001レス目で次スレを自動生成した場合、以後はそちらへ
	if (result.nextThreadId) {
		saveState({ threadId: result.nextThreadId, part: state.part + 1 });
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
	if (!result) return null;
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
