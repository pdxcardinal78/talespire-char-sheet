/**
 * Passing effects between players.
 *
 * `TS.sync` is a realtime bus shared by every client running a Symbiote with the
 * same interop ID. That gives us a way for a caster's panel to put Bless directly
 * into three other people's panels — and, when concentration drops, to take it
 * back out again without anyone having to remember.
 *
 * Design notes, all forced by the API:
 *
 *  - Messages cap at 500 UTF-16 characters, so the wire format uses short keys
 *    and we guard the length before sending.
 *  - `sync.send(msg, "board")` reaches every client on the board at once, so we
 *    broadcast and let each panel decide whether a message is addressed to it.
 *    That sidesteps client-id bookkeeping and the 20-target multiSend cap.
 *  - Sync only reaches clients with the Symbiote *open*. `getClientsConnected()`
 *    explicitly excludes clients that have it installed but closed, so the caster
 *    is shown who can actually receive, and anyone else falls back to chat.
 */

const Party = (() => {
  const PROTOCOL = 1;
  const MAX_MESSAGE = 500;

  const failed = (r) => r && r.cause !== undefined;

  let handlers = {};

  /** @param {{onGrant, onRevoke, onAck, onVitals, onTemp, onHit, onStatusMapping, onStatusRequest, onCondition, onZoneQuery, onZoneReply, onZoneKeep, onZoneKept, onZoneRemove}} h */
  function configure(h) {
    handlers = h;
  }

  // --- wire format ---------------------------------------------------------
  //
  // { v, t, id, ... } — v is the protocol version, t the message type. Unknown
  // versions are ignored rather than guessed at, so a future format can't make an
  // old panel do something wrong.

  function encode(payload) {
    const msg = JSON.stringify({ v: PROTOCOL, ...payload });
    if (msg.length > MAX_MESSAGE) {
      throw new Error("Effect message is too long for TaleSpire's 500 character sync limit.");
    }
    return msg;
  }

  async function broadcast(payload) {
    const res = await TS.sync.send(encode(payload), "board");
    if (failed(res)) {
      // "notConnected" is the realistic one: the realtime backend isn't up.
      throw new Error(res.cause === "notConnected" ? "Not connected to other players." : String(res.cause));
    }
  }

  /**
   * Offer an effect to a list of players.
   * `to` holds player ids; each receiving panel checks whether it is in the list.
   */
  async function grant(effect, toPlayerIds, from) {
    await broadcast({
      t: "grant",
      id: effect.id,
      n: effect.name,
      b: effect.bonus,
      g: effect.targets,
      o: effect.once ? 1 : 0,
      to: toPlayerIds,
      fp: from.id,
      fn: from.name,
      // How long it lasts, counted on the caster's turns: [at, left, kind]
      ...(effect.expires ? { x: [effect.expires.at, effect.expires.left, effect.expires.lasts || ""] } : {}),
      ...(from.creatureId ? { fc: from.creatureId } : {}),
    });
  }

  /** Pull an effect back — concentration dropped, or the caster changed their mind. */
  async function revoke(effectId, toPlayerIds) {
    await broadcast({ t: "revoke", id: effectId, to: toPlayerIds });
  }

  /** Tell the granter what happened, so their panel can show a receipt. */
  async function acknowledge(effectId, granterPlayerId, playerId, accepted) {
    await broadcast({ t: "ack", id: effectId, to: [granterPlayerId], pid: playerId, ok: accepted ? 1 : 0 });
  }

  // --- hit points ----------------------------------------------------------
  //
  // These are addressed by mini, not by player: every panel hears them and the
  // one linked to that mini acts. Numbers are rounded; the 500-character cap is
  // nowhere near.

  /** A player's panel telling the GM its mini's HP, max and temp pool. */
  /** `defenses` is Damage.pack's "r:fire;i:poison", so the GM can apply resistances. */
  async function reportVitals(creatureId, hp, max, temp, defenses) {
    await broadcast({ t: "vit", c: creatureId, h: hp, m: max, tp: temp, ...(defenses ? { df: defenses } : {}) });
  }

  /** The GM telling a player's panel its new temp pool (no Temp HP stat in this campaign). */
  async function setTemp(creatureId, temp) {
    await broadcast({ t: "tmp", c: creatureId, tp: temp });
  }

  /** Temp HP an effect gives a creature (Twilight Sanctuary). Its panel keeps the larger pool. */
  async function tempGrant(creatureId, temp, source) {
    await broadcast({ t: "tg", c: creatureId, tp: temp, n: String(source || "").slice(0, 60) });
  }

  /** A player's initiative roll, for the GM's panel to place in TaleSpire's order. */
  async function initiative(creatureId, value, dex) {
    // "iv", not "v": every message's "v" is the protocol version
    await broadcast({ t: "ini", c: creatureId, iv: value, d: dex });
  }

  // --- saving throws (see lib/saves.js) --------------------------------------

  /**
   * A player asking the GM's panel to run a save: the header, and either the
   * creatures (ids, chunked to fit the 500-character limit) or the zone to
   * check, which the GM's panel can see in full.
   */
  async function saveSession(session, creatureIds, zone) {
    const head = {
      t: "svs", s: session.id, n: String(session.name).slice(0, 40), ab: session.ability, dc: session.dc,
      ...(session.damage ? { dm: session.damage.expr, dt: session.damage.type || "" } : {}),
      h: session.half ? 1 : 0,
      ...(zone ? { z: zone } : {}),
    };
    const ids = [...(creatureIds || [])];
    if (!ids.length) return broadcast({ ...head, c: [] });
    while (ids.length) {
      const chunk = [];
      while (ids.length && JSON.stringify({ v: PROTOCOL, ...head, c: [...chunk, ids[0]] }).length <= MAX_MESSAGE - 20) chunk.push(ids.shift());
      if (!chunk.length) chunk.push(ids.shift());
      await broadcast({ ...head, c: chunk });
    }
  }

  /** The GM's panel took a player's save request. */
  async function saveAck(sessionId) {
    await broadcast({ t: "svk", s: sessionId });
  }

  /** Ask a player's panel to roll a save. The DC is not sent. */
  async function saveQuery(sessionId, creatureId, ability, name) {
    await broadcast({ t: "svq", s: sessionId, c: creatureId, ab: ability, n: String(name || "").slice(0, 40) });
  }

  async function saveResult(sessionId, creatureId, total, natural) {
    await broadcast({ t: "svr", s: sessionId, c: creatureId, tt: total, nt: natural });
  }

  /** The GM telling a player's panel it took damage, when there's no bridge to write the mini. */
  async function hit(creatureId, amount, source) {
    await broadcast({ t: "hit", c: creatureId, a: amount, n: String(source || "").slice(0, 60) });
  }

  // --- statuses and conditions ---------------------------------------------

  /** The GM sharing one status -> condition pairing (condition null clears it). */
  async function statusMapping(emoteId, condition) {
    await broadcast({ t: "sm", e: emoteId, c: condition });
  }

  /** A panel that just opened asking the GM for every pairing. */
  async function requestStatusMappings() {
    await broadcast({ t: "smq" });
  }

  /** A player adding or removing a condition: the GM's bridge sets the status on their mini. */
  async function condition(creatureId, emoteId, on) {
    await broadcast({ t: "cnd", c: creatureId, e: emoteId, on: on ? 1 : 0 });
  }

  // --- spell zones -----------------------------------------------------------
  //
  // Rulers are shared across clients, so a player's panel can ask the GM's,
  // which sees every mini, who is inside a ruler the player placed.

  /** `zoneId`, once the zone is kept, lets the GM's panel check the marker where it is now. */
  async function zoneQuery(rulerId, shape, size, zoneId) {
    await broadcast({ t: "zq", r: String(rulerId), s: shape, a: size, ...(zoneId ? { z: String(zoneId) } : {}) });
  }

  /** Names inside, trimmed to fit the 500-character sync limit. */
  async function zoneReply(rulerId, names) {
    const list = [];
    let more = 0;
    for (const n of names) {
      const next = [...list, String(n).slice(0, 40)];
      if (JSON.stringify({ v: PROTOCOL, t: "zr", r: String(rulerId), n: next, m: 0 }).length > MAX_MESSAGE - 20) {
        more = names.length - list.length;
        break;
      }
      list.push(String(n).slice(0, 40));
    }
    await broadcast({ t: "zr", r: String(rulerId), n: list, m: more });
  }

  /** Ask the GM's panel to keep a zone; the geometry rides along when it fits. */
  async function zoneKeep(rulerId, name, geometry) {
    const msg = { t: "zk", r: String(rulerId), n: String(name || "").slice(0, 50) };
    if (geometry?.kind && geometry?.handles) {
      const withGeo = { ...msg, k: geometry.kind, h: geometry.handles };
      if (JSON.stringify({ v: PROTOCOL, ...withGeo }).length <= MAX_MESSAGE - 20) Object.assign(msg, withGeo);
    }
    await broadcast(msg);
  }

  /** The GM's answer: the zone's id, or why it couldn't be kept. */
  async function zoneKept(rulerId, zoneId, error) {
    await broadcast(error ? { t: "zkd", r: String(rulerId), e: String(error).slice(0, 120) } : { t: "zkd", r: String(rulerId), id: zoneId });
  }

  async function zoneRemove(zoneId) {
    await broadcast({ t: "zx", id: zoneId });
  }

  /**
   * Route an inbound message. `mePlayerId` is how a panel decides a broadcast is
   * addressed to it.
   */
  function receive(raw, mePlayerId) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // not ours, or truncated
    }

    if (msg.v !== PROTOCOL) return;
    if (Array.isArray(msg.to) && !msg.to.includes(mePlayerId)) return;

    if (msg.t === "grant" && handlers.onGrant) {
      handlers.onGrant({
        id: msg.id,
        name: msg.n,
        bonus: msg.b,
        targets: msg.g || [],
        once: Boolean(msg.o),
        fromId: msg.fp,
        fromName: msg.fn,
        expires: Array.isArray(msg.x) && (msg.x[0] === "start" || msg.x[0] === "end") && msg.x[1] > 0
          ? { at: msg.x[0], left: Math.min(1000, Math.floor(msg.x[1])), lasts: String(msg.x[2] || ""), of: msg.fc || null }
          : null,
      });
    } else if (msg.t === "revoke" && handlers.onRevoke) {
      handlers.onRevoke(msg.id);
    } else if (msg.t === "ack" && handlers.onAck) {
      handlers.onAck({ effectId: msg.id, playerId: msg.pid, accepted: Boolean(msg.ok) });
    } else if (msg.t === "vit" && handlers.onVitals) {
      handlers.onVitals({ creatureId: msg.c, hp: msg.h, max: msg.m, temp: msg.tp, defenses: msg.df ?? null });
    } else if (msg.t === "tmp" && handlers.onTemp) {
      handlers.onTemp({ creatureId: msg.c, temp: msg.tp });
    } else if (msg.t === "ini" && handlers.onInitiative) {
      handlers.onInitiative({ creatureId: msg.c, value: msg.iv, dex: msg.d });
    } else if (msg.t === "svs" && handlers.onSaveSession) {
      handlers.onSaveSession({
        id: msg.s, name: msg.n, ability: msg.ab, dc: msg.dc, half: Boolean(msg.h),
        damage: msg.dm ? { expr: msg.dm, type: msg.dt || null } : null, creatureIds: msg.c || [], zone: msg.z || null,
      });
    } else if (msg.t === "svk" && handlers.onSaveAck) {
      handlers.onSaveAck({ id: msg.s });
    } else if (msg.t === "svq" && handlers.onSaveQuery) {
      handlers.onSaveQuery({ id: msg.s, creatureId: msg.c, ability: msg.ab, name: msg.n });
    } else if (msg.t === "svr" && handlers.onSaveResult) {
      handlers.onSaveResult({ id: msg.s, creatureId: msg.c, total: msg.tt, natural: msg.nt });
    } else if (msg.t === "tg" && handlers.onTempGrant) {
      handlers.onTempGrant({ creatureId: msg.c, temp: msg.tp, source: msg.n });
    } else if (msg.t === "hit" && handlers.onHit) {
      handlers.onHit({ creatureId: msg.c, amount: msg.a, source: msg.n });
    } else if (msg.t === "sm" && handlers.onStatusMapping) {
      handlers.onStatusMapping({ emoteId: msg.e, condition: msg.c || null });
    } else if (msg.t === "smq" && handlers.onStatusRequest) {
      handlers.onStatusRequest();
    } else if (msg.t === "cnd" && handlers.onCondition) {
      handlers.onCondition({ creatureId: msg.c, emoteId: msg.e, on: Boolean(msg.on) });
    } else if (msg.t === "zq" && handlers.onZoneQuery) {
      handlers.onZoneQuery({ rulerId: msg.r, shape: msg.s, size: msg.a, zoneId: msg.z || null });
    } else if (msg.t === "zr" && handlers.onZoneReply) {
      handlers.onZoneReply({ rulerId: msg.r, names: msg.n || [], more: msg.m || 0 });
    } else if (msg.t === "zk" && handlers.onZoneKeep) {
      handlers.onZoneKeep({ rulerId: msg.r, name: msg.n, geometry: msg.k && msg.h ? { kind: msg.k, handles: msg.h } : null });
    } else if (msg.t === "zkd" && handlers.onZoneKept) {
      handlers.onZoneKept({ rulerId: msg.r, zoneId: msg.id, error: msg.e || null });
    } else if (msg.t === "zx" && handlers.onZoneRemove) {
      handlers.onZoneRemove({ zoneId: msg.id });
    }
  }

  /**
   * Everyone on the board, flagged by whether their panel is open and therefore
   * able to receive. A player with the mod installed but closed looks exactly
   * like a player without the mod, so both are offered the chat fallback.
   */
  async function reachablePlayers() {
    const players = await TS.players.getPlayersInThisBoard();
    if (failed(players)) return [];

    const infos = await TS.players.getMoreInfo(players);
    const connected = await TS.sync.getClientsConnected();

    // getClientsConnected lists clients; map them back to the players behind them.
    const livePlayerIds = new Set(
      (failed(connected) ? [] : connected || []).map((c) => c.player?.id).filter(Boolean)
    );

    return (failed(infos) ? [] : infos).map((p) => ({
      id: p.id,
      name: p.name,
      reachable: livePlayerIds.has(p.id),
    }));
  }

  return {
    configure, grant, revoke, acknowledge, reportVitals, setTemp, hit, tempGrant, saveSession, saveAck, saveQuery, saveResult, initiative,
    statusMapping, requestStatusMappings, condition,
    zoneQuery, zoneReply, zoneKeep, zoneKept, zoneRemove,
    receive, reachablePlayers, MAX_MESSAGE,
  };
})();

if (typeof window !== "undefined") window.Party = Party;
