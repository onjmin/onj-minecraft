/**
 * ショウジョウバエの全脳モデルで考える脳(BRAIN=fly)。
 *
 * 脳そのものは fly/server.py(Python・GPU)で動いている。FlyWire v783 の
 * 配線図 13.9 万ニューロンを積分発火モデルで回す(Shiu et al. 2024)。ここは
 *   1. 世界を感覚刺激に変え(fly-senses.ts)
 *   2. 脳を数百ミリ秒ぶん進め(POST /step)
 *   3. 出力ニューロンの発火をスキルに変える(fly-motor.ts)
 * だけで、何をするかの選択はしない。
 *
 * 脳の状態(膜電位)は判断をまたいで続く。毎回リセットはしない。
 * 置き場所は FLY_URL(既定 http://127.0.0.1:8790)。別の GPU 機へ移すときは
 * そこだけ変える。
 */
import { restSkill } from "../../skills/survival/rest";
import { envNum } from "../utils/env";
import { type MotorProgram, type MotorRates, motorToDecision, readMotor } from "./fly-motor";
import { senseWorld } from "./fly-senses";
import type { Brain, BrainInput, Decision } from "./types";

const FLY_URL = process.env.FLY_URL ?? "http://127.0.0.1:8790";
/** 1回の判断で脳を進める時間(脳の中の時間)。 */
const FLY_STEP_MS = envNum("FLY_STEP_MS", 300);
/**
 * 匂い(odor)を脳へ入れるか。既定は入れない。
 *
 * このモデルでは匂いの受容体を 150Hz の 3% で叩くだけで約1万細胞が発火し、
 * 入力を止めても収まらない(実測 2026-10-01: odor 0.1 を 0.9 秒入れた後、
 * 無入力で 0.9 秒回しても 9,900 細胞が発火し続けた)。迫る影・接触・砂糖・
 * 苦味はどれも止めて 0.6 秒で 0 に戻る。匂いだけが脳を発作のような持続状態に
 * 落とし、その間は砂糖を入れても摂食が 26.7Hz → 4Hz に潰れ、旋回と身繕いしか
 * 出なくなる。実在のハエの挙動ではなく、重みをシナプス数で置いたモデルの癖と
 * みて外す。FLY_ODOR=1 で戻せる。
 */
const FLY_ODOR = process.env.FLY_ODOR === "1";
/** 周りの生き物を見る範囲。匂いの届く距離と揃える。 */
const SENSE_RANGE = 32;

type StepResponse = {
	rates: MotorRates;
	input_rates: Record<string, number>;
	sim_ms: number;
	wall_ms: number;
	active_neurons: number;
	top_cell_types?: [string, number][];
};

/**
 * どの行動型が何回選ばれたか。採点(SCENARIO=fly)が「刺激に対して正しい
 * 出力が出たか」を数えるのに使う。プロセスに脳は1つなので、ここに置く。
 */
export const flyProgramCounts: Record<MotorProgram, number> = {
	feed: 0,
	escape: 0,
	walk: 0,
	back: 0,
	groom: 0,
	still: 0,
};

const fmt = (r: Record<string, number>) =>
	Object.entries(r)
		.filter(([, v]) => v > 0.005)
		.map(([k, v]) => `${k}=${v < 1 ? v.toFixed(2) : v.toFixed(0)}`)
		.join(" ") || "(無)";

export class FlyBrain implements Brain {
	readonly name = "fly";
	/** ハエは速い。LLM の30秒ではなく数秒ごとに感じ直す。 */
	readonly periodMs = envNum("FLY_PERIOD_MS", 3_000);
	readonly minGapMs = 1_000;
	readonly extraSkills = [restSkill];

	/** 脳が受け付ける感覚の名前。起動時に /groups から引く。 */
	private channels: Set<string> | null = null;
	private lastHealth: number | null = null;

	private async post<T>(pathname: string, body: unknown): Promise<T> {
		const res = await fetch(`${FLY_URL}${pathname}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!res.ok) throw new Error(`ハエの脳 ${pathname} が ${res.status}: ${await res.text()}`);
		return (await res.json()) as T;
	}

	private async knownChannels(): Promise<Set<string>> {
		if (this.channels) return this.channels;
		const res = await fetch(`${FLY_URL}/groups`);
		if (!res.ok) throw new Error(`ハエの脳 /groups が ${res.status}`);
		const g = (await res.json()) as { inputs: Record<string, unknown> };
		this.channels = new Set(Object.keys(g.inputs).filter((k) => k !== "odor" || FLY_ODOR));
		// 前の接続が残した状態(とくに匂いの持続発火)を持ち込まない。
		await this.post("/reset", {});
		return this.channels;
	}

	async think(input: BrainInput): Promise<Decision> {
		const channels = await this.knownChannels();
		const snapshot = await input.snapshot();
		const state = input.driver.getState();
		const entities = input.driver.nearbyEntities(SENSE_RANGE);

		const hurt = this.lastHealth !== null && snapshot.health < this.lastHealth;
		this.lastHealth = snapshot.health;

		const sensed = senseWorld({
			snapshot,
			self: state.position,
			yaw: state.yaw,
			entities,
			hurt,
		});
		// 脳に該当する感覚ニューロンが無いものは送らない(送れば 400)。
		const stimuli = Object.fromEntries(Object.entries(sensed).filter(([k]) => channels.has(k)));

		const step = await this.post<StepResponse>("/step", {
			stimuli,
			duration_ms: FLY_STEP_MS,
		});
		const motor = readMotor(step.rates);
		flyProgramCounts[motor.program]++;
		const summary = `[ハエ] 感覚 ${fmt(stimuli)} / 発火(Hz) ${fmt(step.rates)}`;
		input.log(
			`${summary} → ${motor.program}${motor.turn ? ` turn=${motor.turn.toFixed(2)}` : ""} (${step.active_neurons}細胞発火, 脳${step.sim_ms}ms/実${Math.round(step.wall_ms)}ms)`,
		);

		return motorToDecision({
			program: motor.program,
			turn: motor.turn,
			self: state.position,
			yaw: state.yaw,
			entities,
			offered: input.offeredSkills(),
			summary,
		});
	}
}
