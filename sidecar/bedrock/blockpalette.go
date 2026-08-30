package main

// ブロックの実行時IDを名前に戻す表。
//
// 現行の統合版は start_game で block_network_ids_are_hashes = true を返し、
// チャンクのパレットには「ブロック状態NBTのFNV1a-32ハッシュ」が入る。通し番号では
// ないので、全ブロック状態を列挙して同じ規則でハッシュを計算し、逆引き表を作る。
//
// ハッシュの作り方は dragonfly の networkBlockHash と同じにしてある。NBT の
// バイト列を手で組み立てており、キーは辞書順、数値はリトルエンディアン。
// エンコーダ任せにすると並び順が変わってハッシュがずれる。
//
// 元データは dragonfly の server/world/block_states.nbt。1.26.40 時点のものだが、
// サーバー 1.26.45 の実パレット(bedrock/dirt/grass_block/air)と一致することを
// 実機で確認済み。取得は scripts/build-sidecar.sh が行う。

import (
	"bytes"
	_ "embed"
	"encoding/binary"
	"fmt"
	"sort"

	"github.com/sandertv/gophertunnel/minecraft/nbt"
)

// fnv1a32 は FNV-1a の32bit版。XOR してから乗算する(FNV-1 と順序が逆)。
// ライブラリを足すほどの分量ではないので自前で持つ。
func fnv1a32(data []byte) uint32 {
	h := uint32(2166136261)
	for _, c := range data {
		h ^= uint32(c)
		h *= 16777619
	}
	return h
}

//go:embed data/block_states.nbt
var blockStateData []byte

type blockState struct {
	Name       string         `nbt:"name"`
	Properties map[string]any `nbt:"states"`
	Version    int32          `nbt:"version"`
}

// blockNames は実行時ID(ハッシュ)から "minecraft:" を外したブロック名を引く。
var blockNames map[int32]string

func init() {
	dec := nbt.NewDecoder(bytes.NewBuffer(blockStateData))
	blockNames = make(map[int32]string, 20000)
	for {
		var s blockState
		if err := dec.Decode(&s); err != nil {
			break
		}
		h := networkBlockHash(s.Name, s.Properties)
		// 同じ名前で状態違いのものは同じ名前に潰す。skills/ は名前しか見ない。
		blockNames[int32(h)] = trimNamespace(s.Name)
	}
}

func trimNamespace(name string) string {
	if len(name) > 10 && name[:10] == "minecraft:" {
		return name[10:]
	}
	return name
}

// blockNameFor は実行時IDに対応するブロック名を返す。表に無ければ第2返り値が false。
func blockNameFor(runtimeID int32) (string, bool) {
	n, ok := blockNames[runtimeID]
	return n, ok
}

// networkBlockHash は (名前, 状態) から統合版の実行時IDを求める。
func networkBlockHash(name string, properties map[string]any) uint32 {
	if name == "minecraft:unknown" {
		return 0xfffffffe
	}

	keys := make([]string, 0, len(properties))
	for k := range properties {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var data []byte
	writeString := func(str string) {
		data = binary.LittleEndian.AppendUint16(data, uint16(len(str)))
		data = append(data, str...)
	}

	data = append(data, 10, 0, 0) // compound(名前なし)
	data = append(data, 8)        // string
	writeString("name")
	writeString(name)
	data = append(data, 10) // compound
	writeString("states")

	for _, k := range keys {
		switch v := properties[k].(type) {
		case string:
			data = append(data, 8)
			writeString(k)
			writeString(v)
		case uint8:
			data = append(data, 1)
			writeString(k)
			data = append(data, v)
		case int8:
			data = append(data, 1)
			writeString(k)
			data = append(data, byte(v))
		case bool:
			b := byte(0)
			if v {
				b = 1
			}
			data = append(data, 1)
			writeString(k)
			data = append(data, b)
		case uint16:
			data = append(data, 2)
			writeString(k)
			data = binary.LittleEndian.AppendUint16(data, v)
		case int16:
			data = append(data, 2)
			writeString(k)
			data = binary.LittleEndian.AppendUint16(data, uint16(v))
		case uint32:
			data = append(data, 3)
			writeString(k)
			data = binary.LittleEndian.AppendUint32(data, v)
		case int32:
			data = append(data, 3)
			writeString(k)
			data = binary.LittleEndian.AppendUint32(data, uint32(v))
		default:
			// 未知の型が来たらハッシュがずれるだけなので、黙って壊れるより落とす。
			panic(fmt.Sprintf("ブロック状態に未対応の型: %s = %T", k, v))
		}
	}
	data = append(data, 0, 0) // states の終端, 全体の終端

	return fnv1a32(data)
}
