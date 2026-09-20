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

  /** @param {{onGrant, onRevoke, onAck}} h */
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
      });
    } else if (msg.t === "revoke" && handlers.onRevoke) {
      handlers.onRevoke(msg.id);
    } else if (msg.t === "ack" && handlers.onAck) {
      handlers.onAck({ effectId: msg.id, playerId: msg.pid, accepted: Boolean(msg.ok) });
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

  return { configure, grant, revoke, acknowledge, receive, reachablePlayers, MAX_MESSAGE };
})();

if (typeof window !== "undefined") window.Party = Party;
