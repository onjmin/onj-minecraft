package main

// CommandRequest を自前で組み立てる。
//
// gophertunnel の packet.CommandRequest は実プロトコルと2箇所ずれている。
// Mojang 公式スキーマ(protocol 2169)と突き合わせた結果:
//   - Version は int32。gophertunnel は文字列で書いている。
//   - CommandOriginData の Type は uint8。gophertunnel は "player" という
//     文字列を書いている(実際の送信バイトで確認)。
// どちらかでもずれていると、サーバーは
//   "Command exceeds maximum size of 512 characters. readNoHeader failed! packetId: 77"
// という PacketViolationWarning を返して接続を切る。
//
// 上流が直るまでは、正しい形のものをこちらで持つ。

import (
	"github.com/google/uuid"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
)

// コマンドの発信元。プレイヤーが打った場合は 0。
const (
	commandOriginPlayer     uint8 = 0
	commandOriginDevConsole uint8 = 1
	commandOriginTest       uint8 = 2
)

// commandVersionLatest は CurrentCmdVersion 列挙の実質的な最新値。
// 列挙は末尾が Count(47), Latest なので、有効な最大は 46。
const commandVersionLatest int32 = 46

type commandRequest struct {
	CommandLine    string
	OriginType     uint8
	UUID           uuid.UUID
	RequestID      string
	PlayerUniqueID int64
	Internal       bool
	Version        int32
}

func (*commandRequest) ID() uint32 { return packet.IDCommandRequest }

func (pk *commandRequest) Marshal(io protocol.IO) {
	io.String(&pk.CommandLine)
	io.Uint8(&pk.OriginType)
	io.UUID(&pk.UUID)
	io.String(&pk.RequestID)
	// PlayerId はスキーマ上は常にあるが、実装は DevConsole/Test のときだけ
	// 書く。Player origin で書くと後続がずれる。
	if pk.OriginType == commandOriginDevConsole || pk.OriginType == commandOriginTest {
		io.Varint64(&pk.PlayerUniqueID)
	}
	io.Bool(&pk.Internal)
	io.Varint32(&pk.Version)
}
