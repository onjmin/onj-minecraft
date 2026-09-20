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
import path from "node:path";
import { createInterface, type Interface } from "node:readline";

export interface SidecarEvent {
	event: string;
	data?: Record<string, any>;
	error?: string;
}

export interface SidecarOptions {
	/** Realm の招待コード。address を指定する場合は不要。 */
	realmInvite?: string;
	/**
	 * 開発用。統合版サーバーへ直に繋ぐ (例: 127.0.0.1:19132)。
	 * Realms は NetherNet だがローカルサーバーは RakNet なので経路が違う。
	 */
	address?: string;
	/** 開発用の表示名。online-mode=false のサーバーで複数体を繋ぎ分けるのに使う。 */
	name?: string;
	/** 認証トークンのキャッシュ先。既定はプロジェクト直下の .bedrock-auth */
	tokenCache?: string;
	/** デバイスコード認証が必要になったときの通知 */
	onMsaCode?: (message: string) => void;
	/** 実行ファイルの場所を明示したい場合 */
	binaryPath?: string;
	/**
	 * WSL 経由で起動する。
	 * ローカル開発サーバーは WSL の Docker 上にあり、WSL2 は UDP のポート転送が
	 * 効かないため、Windows から直に繋ぐと RakNet が届かない。サイドカー自体を
	 * WSL 側で動かして回避する。
	 */
	viaWsl?: boolean;
	/** WSL のディストリビューション名。既定は Ubuntu。 */
	wslDistro?: string;
}

type Pending = {
	resolve: (data: Record<string, any>) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout;
};

/** サイドカーの実行ファイルの既定の置き場所。 */
function defaultBinary(viaWsl: boolean): string {
	const name = !viaWsl && process.platform === "win32" ? "onj-bedrock.exe" : "onj-bedrock";
	return path.resolve(process.cwd(), "sidecar", "bedrock", "bin", name);
}

/**
 * 招待リンクから招待コードだけを取り出す。
 *
 * gophertunnel の realms クライアントはコードをそのまま URL に埋めるため、
 * "https://realms.gg/xxxx" を丸ごと渡すと Realm の取得が 404 になる。
 * 人間が受け取るのは共有される URL の方なので、こちら側で剥がす。
 */
function inviteCode(invite: string): string {
	const text = invite.trim();
	// 共有リンクには2つの形がある。realms.gg の短縮形と、
	// minecraft.net/…/open?inviteCode=XXXX のクエリ形。後者を剥がせずに
	// 丸ごと渡すと 404 になり、Realm が消えたのかリンクが古いのか区別がつかない。
	const q = /[?&]inviteCode=([^&#\s]+)/i.exec(text);
	if (q) return q[1];
	return text.replace(/^https?:\/\/(?:www\.)?realms\.gg\//i, "");
}

/** C:\foo\bar → /mnt/c/foo/bar。WSL に渡すパスの変換。 */
function toWslPath(winPath: string): string {
	const m = /^([A-Za-z]):[\\/](.*)$/.exec(winPath);
	if (!m) return winPath.replace(/\\/g, "/");
	return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
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

		const o = this.options;
		if (!o.address && !o.realmInvite) {
			throw new Error("realmInvite か address のどちらかを指定してください");
		}

		const viaWsl = o.viaWsl ?? false;
		const bin = o.binaryPath ?? defaultBinary(viaWsl);
		const args: string[] = [];
		if (o.address) args.push("-address", o.address);
		else args.push("-invite", inviteCode(o.realmInvite!));
		if (o.name) args.push("-name", o.name);
		if (o.tokenCache) args.push("-token-cache", o.tokenCache);

		// 検証用の環境変数を WSL 側へ持ち込む。
		//
		// Windows の環境変数は wsl 経由では引き継がれない。攻撃の送り方を
		// 切り替えて実測するのに、その都度ビルドし直すのは無駄なので、
		// ONJ_ で始まるものと、サイドカーの追跡出力(BEDROCK_TRACE_*)だけを
		// 明示的に渡す。追跡は WSL 経由のローカル採点でも要る。実測 2026-09-19、
		// 作業台のクラフトが status=50 で7回続けて拒否されたが、送った要求と
		// 持ち物の写しが出ておらず、どの枠を指したのかが読めなかった。
		const passthrough = Object.entries(process.env)
			.filter(([k, v]) => (k.startsWith("ONJ_") || k.startsWith("BEDROCK_TRACE_")) && v)
			.map(([k, v]) => `${k}=${v}`);
		const [file, spawnArgs] = viaWsl
			? [
					"wsl",
					[
						"-d",
						o.wslDistro ?? "Ubuntu",
						"--",
						...(passthrough.length > 0 ? ["env", ...passthrough] : []),
						toWslPath(bin),
						...args,
					],
				]
			: [bin, args];

		const proc = spawn(file as string, spawnArgs as string[], {
			stdio: ["pipe", "pipe", "pipe"],
		});
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
	send(
		cmd: string,
		args: Record<string, any> = {},
		timeoutMs = 15_000,
	): Promise<Record<string, any>> {
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
