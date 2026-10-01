"""ショウジョウバエ全脳 LIF モデル (FlyWire v783 / Shiu et al. 2024 Nature) の PyTorch 版。

元実装は Brian2 (github.com/philshiu/Drosophila_brain_model の model.py)。
パラメータと式はそのまま移している。違うのは数値計算の器だけ:
  - 結合は torch の疎行列 (CSR, float32) で GPU に載せる
  - 遅延 1.8 ms = 18 step は「18 step 分の発火をまとめて 1 回の疎行列積で配る」
    ことで実現する。発火から到着までがちょうど 18 step なので、ある 18 step の
    ブロックで出た発火は全部、次のブロックの同じ位置に着く。逐次 18 回の積と
    数学的に同じで、疎行列積の回数が 1/18 になる。
  - 状態 (v, g, 不応期, 遅延バッファ) は呼び出しをまたいで保持する。脳は連続している。
"""

from __future__ import annotations

import math
import os
import time
import warnings
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd
import torch

# torch の疎 CSR は beta 扱いで毎回警告が出る。動作は確かめてあるので黙らせる
warnings.filterwarnings("ignore", message="Sparse CSR tensor support is in beta")

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
CACHE_DIR = HERE / ".cache"


def data_dir() -> Path:
    # cwd ではなくリポジトリ基準で解決する。サーバーをどこから起動しても同じデータを読むため。
    raw = os.environ.get("FLY_DATA_DIR", "../fly-data")
    p = Path(raw)
    return p if p.is_absolute() else (REPO_ROOT / p).resolve()


# ---- Shiu et al. 2024 (Methods, model.py の default_params) の値 ----
V_0 = -52.0  # mV 静止電位
V_RST = -52.0  # mV リセット電位
V_TH = -45.0  # mV 閾値
T_MBR = 20.0  # ms 膜時定数
TAU = 5.0  # ms シナプスコンダクタンスの時定数
T_RFC = 2.2  # ms 不応期
T_DLY = 1.8  # ms シナプス遅延
W_SYN = 0.275  # mV シナプス1個あたりの重み ('Excitatory x Connectivity' に掛ける)
R_POI_MAX = 150.0  # Hz 刺激チャンネル 1.0 のときのポアソン入力の頻度
F_POI = 250.0  # ポアソン入力の重みは F_POI * W_SYN = 68.75 mV。1発で必ず閾値を超える
DT = 0.1  # ms


# ---- 入力チャンネル: 注釈表 (annotations.tsv) の列に対する条件 ----
# 列名: cell_class / cell_sub_class / cell_type / side。値は実際の表で確かめたもの。
# 味覚は唇弁 (labellum) の GRN。Shiu et al. の sugar / bitter と同じ系統。
INPUTS: dict[str, dict] = {
    # LB3c: cell_sub_class == "sugar"。sugar/low_salt (LB3b) は塩にも応じるので入れない
    "sugar": {"cell_sub_class": ["sugar"]},
    # LB1a-d: cell_sub_class == "bitter"
    "bitter": {"cell_sub_class": ["bitter"]},
    # LB3a: cell_sub_class == "water"
    "water": {"cell_sub_class": ["water"]},
    # 迫ってくる物体の検出器 (LPLC2 と LC4)。視葉の細胞なので side は見ている側の目
    "looming_left": {"cell_type": ["LPLC2", "LC4"], "side": ["left"]},
    "looming_right": {"cell_type": ["LPLC2", "LC4"], "side": ["right"]},
    # ジョンストン器官の C/E 群 (Shiu et al. の "JO-CE")。触角が押される・風
    "touch": {"cell_type_prefix": ["JO-C", "JO-E"]},
    # 果実・酢に誘引される嗅覚受容細胞 (Or42b=DM1, Or59b=DM4, Or22a=DM2, Or43b=VM2, Or92a=VA2)。
    # 左右に分けて試したが出力がほぼ同じだった (ORN は両側の触角葉へ投射する)。
    # 左右差を返せないチャンネルを左右に分けると LLM を誤らせるので 1 本にしている
    "odor": {"cell_type": ["ORN_DM1", "ORN_DM4", "ORN_DM2", "ORN_VM2", "ORN_VA2"]},
}

# ---- 読み出し群 ----
# FlyWire の注釈には MN9 (吻伸展の運動ニューロン) という名前が無い。
# 砂糖で発火した型を選ぶと「砂糖で feed が上がる」が作りの結果になり検証にならないので、
# 吻の運動ニューロン全部 (cell_sub_class == "proboscis_motor_neuron", 唇弁神経 MxLbN, 24個)
# の平均を取る。MN9 はこの中にいるはず。平均なので値は薄まる。
#
# grooming も注釈に Hampel 2015 の aDN / aBN の名前が無い。DNg12 を最初に試したが
# 何を入れても 0 Hz だった。仕方なく touch (JO-CE) の単独刺激で発火し、looming・
# 砂糖では発火しない DN を選んだ。つまり groom の touch 行は作りの結果で、検証ではない。
OUTPUTS: dict[str, dict] = {
    "feed": {"cell_sub_class": ["proboscis_motor_neuron"]},
    # DNp01 = giant fiber。DNp02/04/06/11 は迫る刺激に応じる DN (von Reyn 2017, Ache 2019)
    "escape": {"cell_type": ["DNp01", "DNp02", "DNp04", "DNp06", "DNp11"]},
    # DNp09 = P9 (Bidaye 2020 の前進)。oDN1 / BPN は FlyWire の注釈に見つからない
    "walk_forward": {"cell_type": ["DNp09"]},
    # MDN = moonwalker (後退)
    "walk_backward": {"cell_type": ["MDN"]},
    # DNa01 / DNa02 は同側への旋回 (Rayshubskiy 2020)
    "turn_left": {"cell_type": ["DNa01", "DNa02"], "side": ["left"]},
    "turn_right": {"cell_type": ["DNa01", "DNa02"], "side": ["right"]},
    "groom": {"cell_type": ["DNg29", "DNb06", "DNbe001", "DNp40"]},
}


@dataclass
class Group:
    name: str
    idx: torch.Tensor  # GPU 上の neuron index
    cell_types: list[str]
    n: int = field(init=False)

    def __post_init__(self):
        self.n = int(self.idx.numel())


def _select(ann: pd.DataFrame, spec: dict) -> pd.DataFrame:
    m = pd.Series(True, index=ann.index)
    for col in ("cell_class", "cell_sub_class", "cell_type", "side", "super_class"):
        if col in spec:
            m &= ann[col].isin(spec[col])
    if "cell_type_prefix" in spec:
        ct = ann["cell_type"].fillna("")
        pm = pd.Series(False, index=ann.index)
        for p in spec["cell_type_prefix"]:
            pm |= ct.str.startswith(p)
        m &= pm
    return ann[m]


def load_tables():
    d = data_dir()
    comp = pd.read_csv(d / "Completeness_783.csv", index_col=0)
    ann = pd.read_csv(d / "annotations.tsv", sep="\t", low_memory=False)
    ann = ann.drop_duplicates("root_id").set_index("root_id")
    # 行順 = neuron index。Connectivity の Presynaptic_Index もこの順 (確認済み)
    ann = ann.reindex(comp.index)
    ann["idx"] = np.arange(len(comp))
    return comp, ann


def load_weights(n: int, device: torch.device) -> torch.Tensor:
    """W[post, pre] (mV)。CSR を .cache に保存して 2 回目以降は読むだけにする。"""
    CACHE_DIR.mkdir(exist_ok=True)
    cache = CACHE_DIR / "w_csr_783.pt"
    if cache.exists():
        obj = torch.load(cache)
    else:
        df = pd.read_parquet(
            data_dir() / "Connectivity_783.parquet",
            columns=["Presynaptic_Index", "Postsynaptic_Index", "Excitatory x Connectivity"],
        )
        post = torch.from_numpy(df["Postsynaptic_Index"].to_numpy(np.int64))
        pre = torch.from_numpy(df["Presynaptic_Index"].to_numpy(np.int64))
        # 重みはシナプス数 x 符号 (神経伝達物質の予測から) x 0.275 mV。実測の強さではない
        val = torch.from_numpy(df["Excitatory x Connectivity"].to_numpy(np.float32)) * W_SYN
        coo = torch.sparse_coo_tensor(torch.stack([post, pre]), val, (n, n)).coalesce()
        csr = coo.to_sparse_csr()
        obj = {
            "crow": csr.crow_indices(),
            "col": csr.col_indices(),
            "val": csr.values(),
            "n": n,
        }
        torch.save(obj, cache)
    # 添字を int32 にすると cuSPARSE の積が 2割ほど速い (2.9 → 2.4 ms / 18 列, 実測)
    return torch.sparse_csr_tensor(
        obj["crow"].to(device, torch.int32),
        obj["col"].to(device, torch.int32),
        obj["val"].to(device),
        (n, n),
    )


class Brain:
    def __init__(self, device: str | None = None, seed: int | None = None, use_graph: bool = True):
        self.device = torch.device(device or ("cuda" if torch.cuda.is_available() else "cpu"))
        t0 = time.time()
        comp, ann = load_tables()
        self.n = len(comp)
        self.ann = ann
        self.W = load_weights(self.n, self.device)
        self.synapses = int(self.W.values().numel())
        self.load_s = time.time() - t0
        if seed is not None:
            torch.manual_seed(seed)

        # 細胞型ごとの集計用。型の無い細胞は super_class で代用する
        ct = ann["cell_type"].fillna(ann["super_class"]).fillna("unknown").astype(str)
        codes, uniques = pd.factorize(ct)
        self.type_codes = codes
        self.type_names = list(uniques)

        self.inputs = {k: self._group(k, v) for k, v in INPUTS.items()}
        self.outputs = {k: self._group(k, v) for k, v in OUTPUTS.items()}

        # 指数的な減衰を厳密に解いた係数 (Brian2 の method='linear' と同じ解)
        self.D = int(round(T_DLY / DT))  # 18 step
        self.rfc_steps = int(round(T_RFC / DT))  # 22 step
        self.eg = math.exp(-DT / TAU)
        self.ev = math.exp(-DT / T_MBR)
        self.cg = TAU / (TAU - T_MBR) * (self.eg - self.ev)  # g が v に効く分

        # ポアソン入力を受けうる細胞 (全チャンネルの和集合) を固定しておく。
        # CUDA Graph は番地の変わらないテンソルしか扱えないので、刺激の強さは p_in の中身だけで変える
        self.in_idx = torch.cat([g.idx for g in self.inputs.values()]).unique()
        self.p_in = torch.zeros(self.in_idx.numel(), device=self.device)
        self.w_poi = F_POI * W_SYN

        n, dev = self.n, self.device
        self.v = torch.empty(n, device=dev)
        self.g = torch.empty(n, device=dev)
        self.rfc = torch.empty(n, dtype=torch.int32, device=dev)  # 不応期の残り step
        # 遅延: 今のブロックで出た発火 (S) と、前のブロックの発火から計算した今のブロックへの到着 (A)
        self.S = torch.empty(n, self.D, device=dev)
        self.A = torch.empty(n, self.D, device=dev)
        self.counts = torch.zeros(n, dtype=torch.int32, device=dev)
        self.reset()

        # 1 step は小さなカーネルを十数個呼ぶだけなので、起動の手間が計算より重い。
        # 18 step (= 遅延 1 ブロック) を CUDA Graph に録って 1 回で流す
        self.graph = None
        if use_graph and dev.type == "cuda":
            self._capture()

    def _group(self, name: str, spec: dict) -> Group:
        sel = _select(self.ann, spec)
        idx = torch.tensor(sel["idx"].to_numpy(), dtype=torch.long, device=self.device)
        types = sorted(sel["cell_type"].dropna().unique().tolist())
        return Group(name, idx, types)

    def reset(self):
        self.v.fill_(V_0)
        self.g.zero_()
        self.rfc.zero_()
        self.S.zero_()
        self.A.zero_()
        self.k = 0  # ブロック内の位置。リクエストが 1.8 ms の倍数でなくても続きから進める
        self.t_ms = 0.0

    def _substep(self, k: int):
        # 1) 遅延して届いたシナプス入力。不応期中でも g には足す (Brian2 の on_pre と同じ)
        self.g.add_(self.A[:, k])
        # 2) ポアソン入力は v に直接足す (Shiu: PoissonInput target_var='v')。1 発で閾値を超える重さ
        hit = torch.rand(self.in_idx.numel(), device=self.device) < self.p_in
        self.v.index_add_(0, self.in_idx, hit.float() * self.w_poi)
        # 3) 不応期でない細胞だけ積分する ("unless refractory")
        active = self.rfc <= 0
        v_new = V_0 + (self.v - V_0) * self.ev + self.g * self.cg
        self.v.copy_(torch.where(active, v_new, self.v))
        self.g.copy_(torch.where(active, self.g * self.eg, self.g))
        # 4) 閾値とリセット。リセットで g も 0 に戻す (Shiu の reset 式)
        spk = (self.v > V_TH) & active
        self.v.masked_fill_(spk, V_RST)
        self.g.masked_fill_(spk, 0.0)
        self.rfc.copy_(torch.where(spk, self.rfc_steps, self.rfc - 1).to(torch.int32))
        self.S[:, k].copy_(spk.float())
        self.counts.add_(spk.int())

    def _deliver(self):
        # ブロック終端: 18 step 分の発火をまとめて配る。発火からちょうど 18 step 後に着く
        self.A.copy_(torch.sparse.mm(self.W, self.S))
        self.S.zero_()

    def _block(self):
        for k in range(self.D):
            self._substep(k)
        self._deliver()

    def _capture(self):
        state = (self.v, self.g, self.rfc, self.S, self.A, self.counts)
        saved = [t.clone() for t in state]
        s = torch.cuda.Stream()
        s.wait_stream(torch.cuda.current_stream())
        with torch.cuda.stream(s):
            for _ in range(2):  # 録る前に流して cuSPARSE の作業領域などを確保させる
                self._block()
        torch.cuda.current_stream().wait_stream(s)
        g = torch.cuda.CUDAGraph()
        with torch.cuda.graph(g):
            self._block()
        self.graph = g
        # 予行で進んだ分を巻き戻す
        for dst, src in zip(state, saved):
            dst.copy_(src)

    @torch.no_grad()
    def step(self, stimuli: dict[str, float], duration_ms: float):
        """duration_ms だけ進め、全ニューロンの発火数と、直接刺激した細胞の index を返す。"""
        for k in stimuli:
            if k not in self.inputs:
                raise KeyError(k)
        steps = int(round(duration_ms / DT))
        p = torch.zeros(self.n, device=self.device)
        input_rates = {}
        for k, s in stimuli.items():
            s = min(max(float(s), 0.0), 1.0)
            input_rates[k] = s * R_POI_MAX
            if s > 0:
                gi = self.inputs[k].idx
                p[gi] = p[gi].clamp_min(s * R_POI_MAX * DT / 1000.0)
        self.p_in.copy_(p[self.in_idx])
        stim_idx = torch.nonzero(p > 0).flatten()

        self.counts.zero_()
        while steps > 0:
            if self.k == 0 and steps >= self.D:
                if self.graph is not None:
                    self.graph.replay()
                else:
                    self._block()
                steps -= self.D
            else:
                self._substep(self.k)
                self.k += 1
                steps -= 1
                if self.k == self.D:
                    self._deliver()
                    self.k = 0
        self.t_ms += round(duration_ms / DT) * DT
        return self.counts.clone(), input_rates, stim_idx

    def run(self, stimuli: dict[str, float], duration_ms: float) -> dict:
        duration_ms = min(max(float(duration_ms), 10.0), 2000.0)
        if self.device.type == "cuda":
            torch.cuda.synchronize()
        t0 = time.perf_counter()
        counts, input_rates, stim_idx = self.step(stimuli, duration_ms)
        sim_ms = round(duration_ms / DT) * DT
        rates = {
            name: round(counts[g.idx].float().mean().item() * 1000.0 / sim_ms, 2) if g.n else 0.0
            for name, g in self.outputs.items()
        }
        c = counts.cpu().numpy().astype(np.int64)
        active = int((c > 0).sum())
        # 直接刺激した細胞は「脳が出した答え」ではないので順位から外す
        c_ex = c.copy()
        c_ex[stim_idx.cpu().numpy()] = 0
        by_type = np.bincount(self.type_codes, weights=c_ex, minlength=len(self.type_names))
        top = np.argsort(-by_type)[:10]
        top_types = [[self.type_names[i], int(by_type[i])] for i in top if by_type[i] > 0]
        wall = (time.perf_counter() - t0) * 1000.0
        return {
            "rates": rates,
            "input_rates": input_rates,
            "sim_ms": round(sim_ms, 1),
            "wall_ms": round(wall, 1),
            "active_neurons": active,
            "top_cell_types": top_types,
            "_counts": counts,
        }
