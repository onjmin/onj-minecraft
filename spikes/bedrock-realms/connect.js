// M0 スパイク v3: BedrockX(NetherNet実装) で Realms 接続
// 注意: Realm の設定変更(postStorySettings)は意図的に呼ばない。読み取りと接続のみ。
const RealmAPI = require("./example/src/classes/Realm");
const { createClient } = require("./index");
const { Authflow, Titles } = require("prismarine-auth");

const CODE = (process.env.REALM_INVITE || "").replace(/https:\/\/realms\.gg\//, "");
const DURATION = Number(process.env.DURATION ?? 45);
const HARD_CAP = Number(process.env.HARD_CAP ?? 300);

const stats = { packets: new Map(), chunks: 0, subchunks: 0, chats: 0 };
const bump = (n) => stats.packets.set(n, (stats.packets.get(n) ?? 0) + 1);

(async () => {
    console.log("--- M0 spike v3: BedrockX / NetherNet Realms ---");
    const RAPI = new RealmAPI();
    await RAPI.init();
    console.log("xuid:", RAPI.xuid);

    const realm = await RAPI.getRealmInfo(CODE);
    if (!realm || typeof realm === "number") { console.log("getRealmInfo 失敗:", realm); process.exit(1); }
    console.log(`realm: id=${realm.id} name=${JSON.stringify(realm.name)} state=${realm.state} member=${realm.member} expired=${realm.expired}`);

    console.log("[join] /join を取得中（503は自動リトライ）...");
    const ip = await RAPI.getRealmIP(realm.id);
    if (typeof ip === "number") { console.log("getRealmIP 失敗:", ip); process.exit(1); }
    console.log("[join]", JSON.stringify(ip));

    const transport = ip.networkProtocol;
    const options = {
        profilesFolder: "./auth",
        authTitle: Titles.MinecraftIOS,
        deviceType: "iOS",
        flow: "sisu",
        protocolVersion: 2169,
        authflow: new Authflow(undefined, "./auth", { flow: "sisu", authTitle: Titles.MinecraftIOS, deviceType: "iOS" },
            (d) => console.log("要サインイン:", d.message)),
        transport,
        skinData: {},
    };
    if (transport === "DEFAULT") {
        options.host = ip.address.split(":")[0];
        options.port = Number(ip.address.split(":")[1]);
    } else {
        options.networkId = ip.address;
    }
    console.log(`[connect] transport=${transport} networkId=${options.networkId ?? "-"}`);

    const client = createClient(options);
    let spawned = false;

    const finish = (why) => {
        console.log(`\n--- 終了 (${why}) ---`);
        console.log("spawn 到達 :", spawned ? "YES" : "NO");
        console.log("level_chunk:", stats.chunks, " subchunk:", stats.subchunks, " chat:", stats.chats);
        for (const [k, v] of [...stats.packets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`  ${String(v).padStart(5)}  ${k}`);
        try { client.close?.(); } catch { }
        process.exit(spawned ? 0 : 1);
    };

    client.on("join", () => console.log("[join] サーバに join"));
    client.on("spawn", () => {
        spawned = true;
        console.log("[spawn] スポーン完了 entityId=%s version=%s", client.entityId, client.version);
        setTimeout(() => finish(`spawn後 ${DURATION}秒経過`), DURATION * 1000);
    });
    let runtimeEntityId = null;
    client.on("start_game", (p) => {
        runtimeEntityId = p.runtime_entity_id;
        console.log("[start_game] pos=%s gamemode=%s dim=%s runtime_entity_id=%s",
            JSON.stringify(p.player_position), p.player_gamemode, p.dimension, runtimeEntityId);
        // BedrockX のクライアントはスポーン確定処理を行わないため自前で実施する
        try {
            client.write("request_chunk_radius", { chunk_radius: 8, max_radius: 8 });
            console.log("[handshake] request_chunk_radius(8) 送信");
        } catch (e) { console.log("[handshake] request_chunk_radius 失敗:", e.message); }
    });

    client.on("play_status", (p) => {
        console.log("[play_status]", JSON.stringify(p));
        if (p.status === "player_spawn" && !spawned) {
            try {
                client.write("set_local_player_as_initialized", { runtime_entity_id: runtimeEntityId });
                console.log("[handshake] set_local_player_as_initialized 送信");
            } catch (e) { console.log("[handshake] 失敗:", e.message); }
            spawned = true;
            console.log("[SPAWN] スポーン確定");
            setTimeout(() => finish(`spawn後 ${DURATION}秒経過`), DURATION * 1000);
        }
    });
    client.on("level_chunk", () => { stats.chunks++; });
    client.on("subchunk", () => { stats.subchunks++; });
    client.on("set_time", () => bump("set_time"));
    client.on("move_player", () => bump("move_player"));
    client.on("add_player", (p) => console.log("[add_player]", p.username));
    client.on("add_entity", (p) => bump(`add_entity:${p.entity_type}`));
    client.on("update_attributes", () => bump("update_attributes"));
    client.on("inventory_content", () => bump("inventory_content"));
    client.on("crafting_data", (p) => console.log("[crafting_data] recipes:", p.recipes?.length));
    client.on("text", (p) => { stats.chats++; console.log(`[chat] <${p.source_name || p.type}> ${p.message}`); });
    client.on("kick", (p) => console.log("[kick]", JSON.stringify(p)));
    client.on("disconnect", (p) => console.log("[disconnect]", JSON.stringify(p)));
    client.on("error", (e) => console.log("[error]", e?.message ?? e));

    setTimeout(() => finish(`全体上限到達（spawn=${spawned}）`), HARD_CAP * 1000);
})();
