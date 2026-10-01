"""刺激チャンネル x 読み出し群 の表を実測する。

各条件は reset した脳から始め、刺激を DURATION_MS だけ与えて読み出し群の平均発火率 (Hz) を取る。
1 回だと数個の細胞の群は揺れるので TRIALS 回の平均を出す。
使い方: python fly/validate.py
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from brain import Brain  # noqa: E402

DURATION_MS = float(os.environ.get("FLY_VALIDATE_MS", "500"))
TRIALS = int(os.environ.get("FLY_VALIDATE_TRIALS", "3"))


def conditions(b: Brain) -> list[tuple[str, dict]]:
    conds = [("(none)", {})]
    conds += [(ch, {ch: 1.0}) for ch in b.inputs]
    # Shiu et al. で比べられる組み合わせ: 苦味が砂糖の摂食を抑えるか、砂糖の強さで変わるか
    conds += [
        ("sugar 0.5", {"sugar": 0.5}),
        ("sugar+bitter", {"sugar": 1.0, "bitter": 1.0}),
        ("sugar+looming_L", {"sugar": 1.0, "looming_left": 1.0}),
    ]
    return conds


def main():
    b = Brain(seed=0)
    print(f"load {b.load_s:.1f}s  neurons={b.n} synapses={b.synapses} device={b.device}")
    print("inputs :", {k: g.n for k, g in b.inputs.items()})
    print("outputs:", {k: g.n for k, g in b.outputs.items()})

    groups = list(b.outputs)
    header = f"{'condition':<18}" + "".join(f"{g:>14}" for g in groups) + f"{'active':>9}"
    print(f"\n{DURATION_MS:.0f} ms, mean of {TRIALS} trials (Hz)")
    print(header)
    walls = []
    for name, stim in conditions(b):
        acc = np.zeros(len(groups))
        act = 0
        for _ in range(TRIALS):
            b.reset()
            r = b.run(stim, DURATION_MS)
            acc += [r["rates"][g] for g in groups]
            act += r["active_neurons"]
            walls.append(r["wall_ms"] / r["sim_ms"] * 100.0)
        acc /= TRIALS
        print(f"{name:<18}" + "".join(f"{v:>14.1f}" for v in acc) + f"{act // TRIALS:>9}")

    # 実時間との比。サーバーは 1 リクエストごとにこれだけ待たせる
    print(f"\nwall per 100 ms brain time: median {np.median(walls):.0f} ms (min {min(walls):.0f}, max {max(walls):.0f})")
    b.reset()
    t0 = time.perf_counter()
    b.run({}, 2000)
    print(f"idle 2000 ms brain: {(time.perf_counter() - t0) * 1000:.0f} ms wall")


if __name__ == "__main__":
    main()
