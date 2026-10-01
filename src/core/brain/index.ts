/**
 * 脳を選ぶ。BRAIN=llm(既定) / fly。
 */
import type { AgentProfile } from "../../profiles/types";
import { FlyBrain } from "./fly-brain";
import { LlmBrain } from "./llm-brain";
import type { Brain } from "./types";

export function createBrain(profile: AgentProfile, kind = process.env.BRAIN ?? "llm"): Brain {
	switch (kind) {
		case "llm":
			return new LlmBrain(profile.minecraftName);
		case "fly":
			return new FlyBrain();
		default:
			throw new Error(`BRAIN=${kind} は無い(llm か fly)`);
	}
}
