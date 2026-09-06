package main

// 開発用のプロキシ。
//
// クラフトの ItemStackRequest がサーバーに拒否され続け、何を送るのが正しいのか
// 推測では当たらなかった。実クライアントとサーバーの間に入って、本物が何を
// 送っているかをそのまま記録する。
//
// 使い方:
//   1. ./onj-bedrock -proxy :19133 -upstream 127.0.0.1:19132
//   2. Minecraft から このPCのIP:19133 に接続する
//   3. クラフトを1回する
//   4. 標準出力に craft_request として中身が出る
//
// 認証は通さない。上流を online-mode=false で動かしている前提の、開発専用。

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"

	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
)

func runProxy(ctx context.Context, listenAddr, upstream string) {
	listener, err := minecraft.ListenConfig{
		StatusProvider:         minecraft.NewStatusProvider("onj proxy", "onj proxy"),
		AuthenticationDisabled: true,
	}.Listen("raknet", listenAddr)
	if err != nil {
		fail("プロキシを開けません(%s): %v", listenAddr, err)
	}
	defer listener.Close()

	emit(event{Event: "proxy_listening", Data: map[string]any{
		"listen":   listenAddr,
		"upstream": upstream,
		"hint":     "Minecraft から このPCのIP:" + strings.TrimPrefix(listenAddr, ":") + " に接続してください",
	}})

	for {
		c, err := listener.Accept()
		if err != nil {
			emit(event{Event: "end", Data: map[string]any{"reason": fmt.Sprintf("受け付けを終了: %v", err)}})
			return
		}
		go proxyOne(ctx, c.(*minecraft.Conn), upstream)
	}
}

func proxyOne(ctx context.Context, client *minecraft.Conn, upstream string) {
	defer client.Close()

	// クライアントの素性をそのまま上流へ渡す。別人として繋ぐと持ち物が変わる。
	server, err := (&minecraft.Dialer{
		ClientData:   client.ClientData(),
		IdentityData: client.IdentityData(),
		// 中継役なので、知らないパケットや解釈できないパケットで
		// 接続を落とさせない。既定のままだと "Unexpected packet" で切れる。
		DisconnectOnUnknownPackets: false,
		DisconnectOnInvalidPackets: false,
	}).DialContext(ctx, "raknet", upstream)
	if err != nil {
		emit(event{Event: "error", Error: fmt.Sprintf("上流への接続に失敗: %v", err)})
		return
	}
	defer server.Close()

	// クライアントへの開始通知と上流でのスポーンは同時に進める。
	// 順番にやると互いの手順が噛み合わず、クライアントが数秒で切断される。
	var wg sync.WaitGroup
	wg.Add(2)
	var startErr, spawnErr error
	go func() {
		defer wg.Done()
		startErr = client.StartGame(server.GameData())
	}()
	go func() {
		defer wg.Done()
		spawnErr = server.DoSpawn()
	}()
	wg.Wait()
	if startErr != nil {
		emit(event{Event: "error", Error: fmt.Sprintf("クライアントへの開始通知に失敗: %v", startErr)})
		return
	}
	if spawnErr != nil {
		emit(event{Event: "error", Error: fmt.Sprintf("上流でのスポーンに失敗: %v", spawnErr)})
		return
	}
	emit(event{Event: "proxy_connected", Data: map[string]any{
		"name": client.IdentityData().DisplayName,
	}})

	// 上流へ送った直近のパケット。切断されたとき、何が引き金かを見るため。
	var recentMu sync.Mutex
	recent := make([]uint32, 0, 16)
	noteSent := func(id uint32) {
		recentMu.Lock()
		recent = append(recent, id)
		if len(recent) > 16 {
			recent = recent[1:]
		}
		recentMu.Unlock()
	}
	dumpRecent := func() []uint32 {
		recentMu.Lock()
		defer recentMu.Unlock()
		out := make([]uint32, len(recent))
		copy(out, recent)
		return out
	}

	// どちらかの向きが止まったら理由を出す。黙って閉じると原因が追えない。
	go func() {
		defer server.Close()
		for {
			pk, err := client.ReadPacket()
			if err != nil {
				emit(event{Event: "proxy_closed", Data: map[string]any{
					"side": "クライアントからの受信", "reason": err.Error(),
				}})
				return
			}
			inspect(pk)
			if skipToServer(pk) {
				// 手順の重複はサーバーに "Unexpected packet" と判断される。
				continue
			}
			noteSent(pk.ID())
			if err := server.WritePacket(pk); err != nil {
				emit(event{Event: "proxy_closed", Data: map[string]any{
					"side": "上流への送信", "reason": err.Error(),
					"直近に送ったID": dumpRecent(),
				}})
				return
			}
		}
	}()

	for {
		pk, err := server.ReadPacket()
		if err != nil {
			emit(event{Event: "proxy_closed", Data: map[string]any{
				"side": "上流からの受信", "reason": err.Error(),
				"直近に送ったID": dumpRecent(),
			}})
			return
		}
		if err := client.WritePacket(pk); err != nil {
			emit(event{Event: "proxy_closed", Data: map[string]any{
				"side": "クライアントへの送信", "reason": err.Error(),
			}})
			return
		}
	}
}

// skipToServer は上流へ流してはいけないパケットかを見る。
//
// プロキシは自分でログインとスポーンを済ませている。クライアントが送る同じ
// 手順のパケットをそのまま転送すると、サーバーは二度目を受け取ることになり
// "Unexpected packet" で接続を切る。
func skipToServer(pk packet.Packet) bool {
	switch pk.(type) {
	case *packet.RequestNetworkSettings, *packet.Login, *packet.ClientToServerHandshake,
		*packet.ResourcePackClientResponse, *packet.ClientCacheStatus,
		*packet.RequestChunkRadius, *packet.SetLocalPlayerAsInitialised:
		return true
	}
	return false
}

// inspect は見たいパケットだけを詳しく出す。全部出すと読めない。
func inspect(pk packet.Packet) {
	req, ok := pk.(*packet.ItemStackRequest)
	if !ok {
		return
	}
	for _, r := range req.Requests {
		actions := make([]string, 0, len(r.Actions))
		for _, a := range r.Actions {
			actions = append(actions, describeAction(a))
		}
		emit(event{Event: "craft_request", Data: map[string]any{
			"requestID": r.RequestID,
			"actions":   actions,
		}})
	}
}

func describeAction(a protocol.StackRequestAction) string {
	switch v := a.(type) {
	case *protocol.CraftRecipeStackRequestAction:
		return fmt.Sprintf("CraftRecipe{recipe=%d, crafts=%d}", v.RecipeNetworkID, v.NumberOfCrafts)
	case *protocol.AutoCraftRecipeStackRequestAction:
		return fmt.Sprintf("AutoCraftRecipe{recipe=%d, crafts=%d, ingredients=%d}",
			v.RecipeNetworkID, v.NumberOfCrafts, len(v.Ingredients))
	case *protocol.CraftResultsDeprecatedStackRequestAction:
		return fmt.Sprintf("CraftResultsDeprecated{items=%d, times=%d}", len(v.ResultItems), v.TimesCrafted)
	case *protocol.ConsumeStackRequestAction:
		return fmt.Sprintf("Consume{count=%d, container=%d, slot=%d, netID=%d}",
			v.Count, v.Source.Container.ContainerID, v.Source.Slot, v.Source.StackNetworkID)
	case *protocol.TakeStackRequestAction:
		return fmt.Sprintf("Take{count=%d, from(container=%d,slot=%d,netID=%d) -> to(container=%d,slot=%d,netID=%d)}",
			v.Count,
			v.Source.Container.ContainerID, v.Source.Slot, v.Source.StackNetworkID,
			v.Destination.Container.ContainerID, v.Destination.Slot, v.Destination.StackNetworkID)
	case *protocol.PlaceStackRequestAction:
		return fmt.Sprintf("Place{count=%d, from(container=%d,slot=%d,netID=%d) -> to(container=%d,slot=%d,netID=%d)}",
			v.Count,
			v.Source.Container.ContainerID, v.Source.Slot, v.Source.StackNetworkID,
			v.Destination.Container.ContainerID, v.Destination.Slot, v.Destination.StackNetworkID)
	case *protocol.DestroyStackRequestAction:
		return fmt.Sprintf("Destroy{count=%d, container=%d, slot=%d}",
			v.Count, v.Source.Container.ContainerID, v.Source.Slot)
	default:
		return fmt.Sprintf("%T", a)
	}
}

// proxyRequested は -proxy が指定されたかを見る。main を短く保つための小道具。
func proxyRequested() (string, string, bool) {
	listen := os.Getenv("BEDROCK_PROXY_LISTEN")
	upstream := os.Getenv("BEDROCK_PROXY_UPSTREAM")
	if listen == "" {
		return "", "", false
	}
	if upstream == "" {
		upstream = "127.0.0.1:19132"
	}
	return listen, upstream, true
}
