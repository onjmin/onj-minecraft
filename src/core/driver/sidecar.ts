/**
 * Go サイドカーとの橋渡し。
 *
 * 統合版のプロトコルは JS 側のライブラリでは送信が成立しないため、接続そのものを
 * Go(gophertunnel) に持たせている。Realm には同時に1接続しか張れないので、
 * 読み取りも含めて全てこのプロセス越しになる。
 *
 * やり取りは標準入出力の改行区切り JSON。こちらから出すのがコマンド、
 * 向こうから来るのがイベント。コマンドの結果は id で対応付ける。
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import path from "node:path";

export interface SidecarEvent {
	event: string;
	data?: Record<string, any>;
	error?: string;
}

export interface SidecarOptions {
	realmInvite: string;
	/** 認証トークンのキャッシュ先。既定はプロジェクト直下の .bedrock-auth */
	tokenCache?: string;
	/** デバイスコード認証が必要になったときの通知 */
	onMsaCode?: (message: string) => void;
	/** 実行ファイルの場所を明示したい場合 */
	binaryPath?: string;
}

type Pending = {
	resolve: (data: Record<string, any>) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout;
};

/** サイドカーの実行ファイルの既定の置き場所。 */
function defaultBinary(): string {
	const name = process.platform === "win32" ? "onj-bedrock.exe" : "onj-bedrock";
	return path.resolve(process.cwd(), "sidecar", "bedrock", "bin", name);
}

export class BedrockSidecar {
	private proc: ChildProcess | null = null;
	private reader: Interface | null = null;
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private listeners = new Map<string, Set<(data: any) => void>>();
	private options: SidecarOptions;
	private stopped = false;

	/** 直近のイベントを残しておく。切断時の原因追跡に使う。 */
	public recentEvents: string[] = [];

	constructor(options: SidecarOptions) {
		this.options = options;
	}

	on(event: string, listener: (data: any) => void): void {
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
		}
		set.add(listener);
	}

	off(event: string, listener: (data: any) => void): void {
		this.listeners.get(event)?.delete(listener);
	}

	private fire(event: string, data: any): void {
		for (const l of this.listeners.get(event) ?? []) {
			try {
				l(data);
			} catch (e) {
				console.error(`[sidecar] ${event} の購読者が例外を投げました:`, e);
			}
		}
	}

	/**
	 * サイドカーを起動し、行動できる状態になるまで待つ。
	 * 認証からスポーンまで数十秒かかるので、待ち時間は長めに取っている。
	 */
	async start(timeoutMs = 180_000): Promise<void> {
		if (this.proc) throw new Error("サイドカーは既に起動しています");

		const bin = this.options.binaryPath ?? defaultBinary();
		const args = ["-invite", this.options.realmInvite];
		if (this.options.tokenCache) args.push("-token-cache", this.options.tokenCache);

		const proc = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
		this.proc = proc;

		proc.on("error", (e) => {
			this.failAll(new Error(`サイドカーを起動できません(${bin}): ${e.message}`));
			this.fire("end", `サイドカーの起動に失敗: ${e.message}`);
		});
		proc.on("exit", (code) => {
			if (!this.stopped) this.fire("end", `サイドカーが終了しました(code=${code})`);
			this.failAll(new Error("サイドカーが終了しました"));
			this.proc = null;
		});
		// Go 側のログは標準エラーに出る。デバイスコードもここ。
		proc.stderr?.on("data", (b: Buffer) => {
			const text = b.toString().trim();
			if (text) console.error(`[sidecar] ${text}`);
		});

		this.reader = createInterface({ input: proc.stdout! });
		this.reader.on("line", (line) => this.onLine(line));

		await this.waitFor("ready_to_act", timeoutMs);
	}

	/** 特定のイベントが来るまで待つ。 */
	private waitFor(event: string, timeoutMs: number): Promise<any> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.off(event, onEvent);
				this.off("end", onEnd);
				reject(new Error(`${event} を ${timeoutMs}ms 待ちましたが来ませんでした`));
			}, timeoutMs);
			const onEvent = (data: any) => {
				clearTimeout(timer);
				this.off(event, onEvent);
				this.off("end", onEnd);
				resolve(data);
			};
			const onEnd = (reason: any) => {
				clearTimeout(timer);
				this.off(event, onEvent);
				this.off("end", onEnd);
				reject(new Error(`待機中に接続が終わりました: ${reason}`));
			};
			this.on(event, onEvent);
			this.on("end", onEnd);
		});
	}

	private onLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) return;
		let ev: SidecarEvent;
		try {
			ev = JSON.parse(trimmed);
		} catch {
			// JSON でない行はそのまま流す。Go のランタイムログなど。
			console.error(`[sidecar] ${trimmed}`);
			return;
		}

		this.recentEvents.push(trimmed.slice(0, 300));
		if (this.recentEvents.length > 100) this.recentEvents.shift();

		if (ev.event === "result") {
			const id = ev.data?.id as number | undefined;
			if (typeof id === "number") {
				const p = this.pending.get(id);
				if (p) {
					this.pending.delete(id);
					clearTimeout(p.timer);
					if (ev.data?.ok) p.resolve(ev.data);
					else p.reject(new Error(String(ev.data?.error ?? "失敗しました")));
				}
			}
			return;
		}

		if (ev.event === "auth_required" && this.options.onMsaCode) {
			this.options.onMsaCode(String(ev.data?.message ?? "サインインが必要です"));
		}
		if (ev.event === "error") {
			console.error(`[sidecar] エラー: ${ev.error}`);
		}
		this.fire(ev.event, ev.event === "end" ? (ev.data?.reason ?? "") : ev.data);
	}

	/**
	 * コマンドを送り、結果を待つ。
	 * goto のように完了まで時間がかかるものがあるので、待ち時間は呼び出し側が決める。
	 */
	send(cmd: string, args: Record<string, any> = {}, timeoutMs = 15_000): Promise<Record<string, any>> {
		const proc = this.proc;
		if (!proc || !proc.stdin?.writable) {
			return Promise.reject(new Error("サイドカーが起動していません"));
		}
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${cmd} が ${timeoutMs}ms 以内に応答しませんでした`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			proc.stdin!.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
		});
	}

	/** 応答を待たずに投げっぱなしにする。中断など、結果に意味が無いものに使う。 */
	fire_and_forget(cmd: string, args: Record<string, any> = {}): void {
		const proc = this.proc;
		if (!proc?.stdin?.writable) return;
		proc.stdin.write(`${JSON.stringify({ id: this.nextId++, cmd, ...args })}\n`);
	}

	private failAll(err: Error): void {
		for (const [, p] of this.pending) {
			clearTimeout(p.timer);
			p.reject(err);
		}
		this.pending.clear();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		const proc = this.proc;
		if (!proc) return;
		try {
			await this.send("quit", {}, 3000);
		} catch {
			// 応答が無くても構わない。この後で止める。
		}
		this.reader?.close();
		proc.stdin?.end();
		// 素直に終わらないときのために少し待ってから落とす。
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				proc.kill();
				resolve();
			}, 3000);
			proc.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
		this.proc = null;
	}
}
