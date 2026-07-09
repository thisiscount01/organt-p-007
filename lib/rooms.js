'use strict';
/**
 * 보스룸 서버 권위 상태머신 — FORMING → LOCKED → IN_COMBAT → RESULT.
 * 휘발 상태(보스 HP/광폭화 타이머/소켓 연결)는 전부 이 모듈의 인메모리 Map에만 존재한다.
 * 서버 재시작 시 진행 중이던 보스룸은 사라지는 게 스펙(캐릭터 영속과 명확히 분리 — lib/store.js 참고).
 *
 * 동시성 원칙: Node는 단일 스레드이고, 아래 각 핸들러(joinRoom/startCombat/tick 처리 등)는
 * 임계구역(정원 체크→멤버 추가, HP 감산→0 이하 판정→clearFired 플래그) 안에 await를 두지 않는다 —
 * 즉 하나의 이벤트 핸들러가 끝까지 동기 실행된 뒤에야 다음 이벤트가 처리되므로, 두 소켓이 "같은 tick"에
 * 도착한 것처럼 보여도 서버 입장에선 반드시 순차 처리된다(방당 단일 순차 tick 큐를 명시적 큐 자료구조 없이
 * JS 이벤트 루프 자체로 구현). tick_seq는 이 순차성을 로그로 증명하기 위한 방별 단조증가 카운터.
 */
const crypto = require('crypto');
const { BossEncounter } = require('./encounter');
const store = require('./store'); // 보스 클리어 골드 보상을 캐릭터 영속 데이터에 실제 반영하기 위함

const TICK_MS = 1000; // 1Hz 서버 tick — 광폭화 텔레그래프도 이 해상도로 근사(프론트가 부드럽게 보간)
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 0/O, 1/I 제외(오독 방지)

function makeRoomCode(existingCodes) {
  let code;
  do {
    code = Array.from({ length: 6 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  } while (existingCodes.has(code));
  return code;
}

class RoomManager {
  constructor(balance) {
    this.balance = balance;
    this.rooms = new Map(); // code -> room
    this.characterSocket = new Map(); // characterId -> socketId (1:1 강제)
    this.socketCharacter = new Map(); // socketId -> {characterId, code}
  }

  _log(room, actor, action, value) {
    const entry = {
      timestamp: Date.now(),
      tick_seq: ++room.tickSeq,
      actor,
      action,
      value: value === undefined ? null : value,
    };
    room.log.push(entry);
    return entry;
  }

  createRoom(character) {
    const code = makeRoomCode(new Set(this.rooms.keys()));
    const cfg = this.balance.bossRoom;
    const boss = this.balance.boss;
    const room = {
      code,
      hostCharacterId: character.id,
      state: 'FORMING',
      capacity: cfg.roomCapacity,
      minToStart: cfg.minToStart,
      graceSeconds: cfg.reconnectGraceSeconds,
      members: new Map(), // characterId -> memberState
      tickSeq: 0,
      log: [],
      bossMaxHp: boss.hp, // FORMING/LOCKED 단계 미리보기용(전투 시작 후엔 encounter가 진실원)
      bossHp: boss.hp,
      phaseIndex: 0,
      combatStartedAt: null,
      resultFired: false,
      result: null,
      reward: null,
      encounter: null, // IN_COMBAT 진입 시 BossEncounter 인스턴스로 채워짐(lib/encounter.js)
      interval: null,
      createdAt: Date.now(),
    };
    this.rooms.set(code, room);
    this._log(room, 'system', 'room_created', { hostCharacterId: character.id });
    this._addMember(room, character);
    return room;
  }

  getRoom(code) {
    return this.rooms.get((code || '').toUpperCase()) || null;
  }

  _addMember(room, character) {
    room.members.set(character.id, {
      characterId: character.id,
      name: character.name,
      className: character.class,
      level: character.level,
      enhanceLevel: character.enhanceLevel || 0,
      connected: true,
      disconnectedAt: null,
      retired: false,
      downed: false,
      damageDealt: 0,
      hpCurrent: null, // 전투 시작 시 채움
    });
  }

  // 캐릭터ID→소켓 1:1 강제: 같은 캐릭터로 새 소켓이 붙으면 기존 소켓을 끊는다.
  _bindSocket(io, characterId, socket, code) {
    const prevSocketId = this.characterSocket.get(characterId);
    if (prevSocketId && prevSocketId !== socket.id) {
      const prevSocket = io.sockets.sockets.get(prevSocketId);
      if (prevSocket) prevSocket.disconnect(true);
      this.socketCharacter.delete(prevSocketId);
    }
    this.characterSocket.set(characterId, socket.id);
    this.socketCharacter.set(socket.id, { characterId, code });
  }

  joinRoom(io, socket, code, character) {
    const room = this.getRoom(code);
    if (!room) return { ok: false, error: 'room_not_found' };

    const existing = room.members.get(character.id);
    if (existing) {
      // 재접속(유예 중이든 아니든) — 슬롯을 재사용, 기존 소켓은 1:1 강제로 정리.
      const wasDisconnected = !existing.connected;
      existing.connected = true;
      existing.disconnectedAt = null;
      this._bindSocket(io, character.id, socket, code);
      socket.join(code);
      this._log(room, character.id, wasDisconnected ? 'member_reconnect' : 'member_rejoin_noop', null);
      return { ok: true, room, reconnected: wasDisconnected };
    }

    if (room.state !== 'FORMING') {
      this._log(room, character.id, 'join_rejected', { reason: `room_${room.state.toLowerCase()}` });
      return { ok: false, error: `room_${room.state.toLowerCase()}` };
    }
    if (room.members.size >= room.capacity) {
      this._log(room, character.id, 'join_rejected', { reason: 'room_full' });
      return { ok: false, error: 'room_full' };
    }

    this._addMember(room, character);
    this._bindSocket(io, character.id, socket, code);
    socket.join(code);
    this._log(room, character.id, 'member_join', { size: room.members.size });

    if (room.members.size >= room.capacity) {
      this._lockAndSchedule(io, room);
    }
    return { ok: true, room, reconnected: false };
  }

  // 정원 미달 상태에서 호스트가 명시적으로 시작(예: 2인 러시 전략) — minToStart 이상이어야 함.
  startCombat(io, code, requesterCharacterId) {
    const room = this.getRoom(code);
    if (!room) return { ok: false, error: 'room_not_found' };
    if (room.state !== 'FORMING') return { ok: false, error: `room_${room.state.toLowerCase()}` };
    if (requesterCharacterId !== room.hostCharacterId) return { ok: false, error: 'not_host' };
    if (room.members.size < room.minToStart) {
      this._log(room, requesterCharacterId, 'start_rejected', {
        reason: 'min_to_start_not_met',
        have: room.members.size,
        need: room.minToStart,
      });
      return { ok: false, error: 'min_to_start_not_met', have: room.members.size, need: room.minToStart };
    }
    this._lockAndSchedule(io, room);
    return { ok: true, room };
  }

  // room:join과 동일 기준(characterSocket map)으로 "요청 소켓이 그 characterId의 현재 바인딩
  // 소켓인가"를 검증한다. characterId를 body로 실어 보내는 액션(dodge 등)은 클라가 자기 캐릭터ID를
  // 자기신고하는 구조라, 이 검증이 없으면 같은 방의 다른 파티원이 남의 characterId를 실어 보내
  // 그 사람 몫의 판정(dodge 등)을 대신 처리할 수 있다 — GOAL.md Interfaces의 "캐릭터ID→소켓 1:1
  // 강제"는 room:join뿐 아니라 characterId를 쓰는 모든 액션에 적용되는 불변식으로 다룬다.
  // _bindSocket이 characterSocket map을 동기(await 없이) 갱신하므로, 재접속으로 소유권이 넘어간
  // 순간 구소켓의 지연 이벤트는 (아직 물리적으로 끊기기 전이라도) 이 map 조회에서 즉시 실패한다 —
  // "새 소켓이 완전히 연결된 후에야 구소켓이 끊긴다"는 창을 노려도 판정 자체는 안전하다.
  ownsCharacter(socketId, characterId) {
    return this.characterSocket.get(characterId) === socketId;
  }

  // GDD §6-1: 사냥터-보스룸 동시 파밍 금지. "IN_COMBAT에 바인딩" = 어느 방이든 IN_COMBAT 상태고
  // 그 캐릭터가 room.members에 있으며 retired가 아님(RoomManager 자신의 바인딩 개념 — 소켓 연결
  // 여부는 안 봄: 재접속 유예 20초 동안 소켓이 끊겨 있어도 아직 retired 전이면 그 캐릭터는 여전히
  // 그 보스전의 클리어 보상 대상이라 "바인딩 해제"로 볼 수 없다 — 이 창을 열어두면 "끊고 REST로
  // 사냥터 파밍 → 유예 안에 재접속해 클리어 보상까지 수령"이라는 새 이중수급 경로가 생긴다).
  // retired(유예 만료로 은퇴 처리된 멤버)는 그 방의 보상 대상에서도 이미 빠졌으므로(_finish의
  // eligible 필터 참고) hunt를 막을 이유가 없다 — 여기서도 제외해야 대칭적으로 맞다.
  isInCombat(characterId) {
    for (const room of this.rooms.values()) {
      if (room.state !== 'IN_COMBAT') continue;
      const member = room.members.get(characterId);
      if (member && !member.retired) return true;
    }
    return false;
  }

  // GDD §6: 클라가 텔레그래프 반응윈도우 내 보낸 dodge 액션 판정.
  // 단일 시간원 원칙: nowElapsedSec은 항상 enc.elapsedSec(시뮬레이션 시계) 그대로 넘긴다 — 예전엔
  // room.combatStartedAt 기준 별도 벽시계(Date.now())를 계산해 넘겼는데, _tick의 setInterval이
  // 이벤트루프 부하로 지연되면 enc.elapsedSec(고정 +1.0/tick)이 벽시계보다 뒤처져 두 시계가
  // 어긋났다(벽시계가 sim시계 기준 windowEndSec을 조기에 앞질러 정상 반응을 "윈도우 밖"으로 오판).
  // _tick이 이제 dtSec을 고정값이 아니라 실제 경과시간으로 넘겨 enc.elapsedSec 자체가 지연분을
  // 보정하므로(아래 _tick 참고), sim시계=벽시계 근사가 항상 성립해 여기서 다시 계산할 필요가 없다.
  registerDodge(io, socket, code, characterId) {
    const room = this.getRoom(code);
    if (!room) return { ok: false, error: 'room_not_found' };
    if (!this.ownsCharacter(socket.id, characterId)) {
      return { ok: false, error: 'not_your_character' };
    }
    if (room.state !== 'IN_COMBAT' || !room.encounter) return { ok: false, error: 'not_in_combat' };
    const nowElapsedSec = room.encounter.elapsedSec;
    const result = room.encounter.registerDodge(characterId, nowElapsedSec);
    const ev = this._log(room, characterId, result.event.action, result.event.value);
    return { ok: true, success: result.success, entry: ev };
  }

  _lockAndSchedule(io, room) {
    room.state = 'LOCKED';
    this._log(room, 'system', 'state_change', { to: 'LOCKED', members: room.members.size });
    io.to(room.code).emit('room:state', this.getSnapshot(room.code));
    // LOCKED 직후 짧은 준비시간(3s)을 두고 전투 시작 — 상태 전이가 눈에 보이게.
    setTimeout(() => this._startCombatNow(io, room.code), 3000);
  }

  _startCombatNow(io, code) {
    const room = this.getRoom(code);
    if (!room || room.state !== 'LOCKED') return;
    room.state = 'IN_COMBAT';
    room.combatStartedAt = Date.now();
    room.lastTickAt = room.combatStartedAt; // _tick의 실경과시간(dtSec) 계산 기준점
    // 전투 판정은 BossEncounter(단일 진실원)에 위임 — rooms.js는 소켓/방 생명주기만 담당.
    room.encounter = new BossEncounter(
      this.balance,
      [...room.members.values()].map((m) => ({
        characterId: m.characterId,
        className: m.className,
        level: m.level,
        enhanceLevel: m.enhanceLevel,
      }))
    );
    for (const m of room.members.values()) {
      const em = room.encounter.members.find((x) => x.characterId === m.characterId);
      m.hpCurrent = em ? em.hpCurrent : null;
    }
    this._log(room, 'system', 'state_change', { to: 'IN_COMBAT', bossHp: room.encounter.bossHp });
    io.to(room.code).emit('room:state', this.getSnapshot(room.code));
    room.interval = setInterval(() => this._tick(io, room.code), TICK_MS);
  }

  _tick(io, code) {
    const room = this.getRoom(code);
    if (!room || room.state !== 'IN_COMBAT') return;
    const now = Date.now();
    const enc = room.encounter;

    // 유예시간 만료 처리(연결 끊긴 지 20초 지난 멤버는 은퇴 처리, 이후 tick부터 딜/생존 계산 제외)
    for (const m of room.members.values()) {
      if (!m.connected && !m.retired && m.disconnectedAt && now - m.disconnectedAt >= room.graceSeconds * 1000) {
        m.retired = true;
        enc.retireMember(m.characterId);
        this._log(room, m.characterId, 'member_retire', { reason: 'reconnect_grace_expired' });
      }
    }

    // dtSec은 고정 TICK_MS/1000이 아니라 마지막 tick 이후 실제 경과시간 — setInterval이 이벤트루프
    // 부하로 지연되면(예: 1200ms만에 콜백 실행) sim시계(enc.elapsedSec)도 그만큼 따라잡아, dodge 판정에
    // 쓰는 sim시계가 벽시계와 어긋나는 창(구 버그: rooms.js가 별도 Date.now() 벽시계를 계산해 비교)을
    // 원천적으로 없앤다. 최소 하한(0.001s)만 둬 dt<=0(같은 밀리초 재진입 등) 이상값을 방지.
    const dtSec = Math.max(0.001, (now - room.lastTickAt) / 1000);
    room.lastTickAt = now;
    const { events } = enc.step(dtSec);
    for (const ev of events) this._log(room, ev.actor || 'boss', ev.action, ev.value);

    // 방 스냅샷용 필드를 encounter 상태와 동기화
    for (const em of enc.members) {
      const rm = room.members.get(em.characterId);
      if (rm) {
        rm.hpCurrent = em.hpCurrent;
        rm.damageDealt = em.damageDealt;
        rm.downed = em.downed;
      }
    }

    if (enc.finished) {
      if (!room.resultFired) this._finish(io, room, enc.result);
      return;
    }

    io.to(room.code).emit('room:tick', {
      tick_seq: room.tickSeq,
      bossHp: Math.round(enc.bossHp),
      bossMaxHp: enc.bossMaxHp,
      phaseIndex: enc.phaseIndex,
      enrageRemainingSec: Math.max(0, Math.round(this.balance.boss.enrageSeconds - enc.elapsedSec)),
      members: this._memberSummaries(room),
      telegraph: enc.pendingTelegraph
        ? { active: true, resolveInMs: Math.round((enc.pendingTelegraph.resolveAtSec - enc.elapsedSec) * 1000) }
        : { active: false },
    });
  }

  _finish(io, room, result) {
    room.resultFired = true;
    room.state = 'RESULT';
    room.result = result;
    room.bossHp = room.encounter ? room.encounter.bossHp : room.bossHp;
    room.phaseIndex = room.encounter ? room.encounter.phaseIndex : room.phaseIndex;
    if (room.interval) clearInterval(room.interval);
    room.interval = null;

    if (result === 'clear') {
      const eligible = [...room.members.values()].filter((m) => !m.retired);
      const winner = eligible.length ? eligible[crypto.randomInt(eligible.length)] : null;
      const zone = this.balance.huntingZone.tiers[this.balance.huntingZone.tiers.length - 1];
      const goldPerMember = Math.round(zone.gold * this.balance.boss.clearReward.goldMultiplierVsHuntingZone);

      // GOAL.md 2번 "클리어 시 사냥터보다 확실히 좋은 보상 지급"은 화면 문구가 아니라 실제 지급이어야
      // 함 — store.saveCharacter로 각 비은퇴 멤버의 영속 골드에 즉시 반영한다. 이 호출은 room tick의
      // setInterval 콜백 안에서 동기적으로만 실행되고(await 없음, Node 단일스레드) room.resultFired가
      // _finish를 정확히 1회만 부르게 이미 막고 있어(위 _tick 참고) 같은 클리어로 두 번 지급될 수 없다.
      // REST hunt/enhance와의 레이스도 없다 — store.saveCharacter는 매 호출이 동기 read-modify-write라
      // 이 이벤트루프 틱이 끝나기 전엔 다른 요청 콜백이 끼어들 수 없다.
      const goldGrantedTo = [];
      for (const m of eligible) {
        const character = store.getCharacter(m.characterId);
        if (!character) continue; // 방 멤버 캐시와 영속 캐릭터가 어긋난 방어적 케이스(정상 흐름에선 안 남)
        character.gold += goldPerMember;
        store.saveCharacter(character);
        goldGrantedTo.push(m.characterId);
      }

      room.reward = {
        gearWinnerCharacterId: winner ? winner.characterId : null,
        goldPerMember,
        goldGrantedTo, // 실제 골드가 반영된 characterId 목록 — QA/프론트가 "지급 vs 화면 문구"를 검증할 수 있게 노출
      };
      this._log(room, 'system', 'clear', room.reward);
    } else {
      this._log(room, 'system', 'wipe', { reason: result });
    }
    io.to(room.code).emit('room:state', this.getSnapshot(room.code));
  }

  handleDisconnect(io, socketId) {
    const entry = this.socketCharacter.get(socketId);
    if (!entry) return;
    this.socketCharacter.delete(socketId);
    if (this.characterSocket.get(entry.characterId) === socketId) {
      this.characterSocket.delete(entry.characterId);
    }
    const room = this.getRoom(entry.code);
    if (!room) return;
    const member = room.members.get(entry.characterId);
    if (!member || member.retired) return;
    member.connected = false;
    member.disconnectedAt = Date.now();
    this._log(room, entry.characterId, 'member_disconnect', null);

    if (room.state === 'FORMING' || room.state === 'LOCKED') {
      // 전투 시작 전이면 유예 후 슬롯 자체를 비워 다른 사람이 들어올 수 있게 한다.
      setTimeout(() => {
        const r = this.getRoom(entry.code);
        if (!r) return;
        const m = r.members.get(entry.characterId);
        if (m && !m.connected && (r.state === 'FORMING' || r.state === 'LOCKED')) {
          r.members.delete(entry.characterId);
          this._log(r, entry.characterId, 'member_retire', { reason: 'pre_combat_grace_expired', freedSlot: true });
        }
      }, room.graceSeconds * 1000);
    }
  }

  _memberSummaries(room) {
    return [...room.members.values()].map((m) => ({
      characterId: m.characterId,
      name: m.name,
      class: m.className,
      level: m.level,
      connected: m.connected,
      retired: m.retired,
      downed: m.downed,
      hpCurrent: m.hpCurrent,
      damageDealt: Math.round(m.damageDealt),
      reconnectRemainingSec:
        !m.connected && !m.retired && m.disconnectedAt
          ? Math.max(0, room.graceSeconds - Math.floor((Date.now() - m.disconnectedAt) / 1000))
          : null,
    }));
  }

  getSnapshot(code) {
    const room = this.getRoom(code);
    if (!room) return null;
    const enc = room.encounter;
    const bossHp = enc ? enc.bossHp : room.bossHp;
    const phaseIndex = enc ? enc.phaseIndex : room.phaseIndex;
    const remainingSec =
      room.state === 'IN_COMBAT' && enc ? Math.max(0, this.balance.boss.enrageSeconds - enc.elapsedSec) : null;
    return {
      code: room.code,
      state: room.state,
      capacity: room.capacity,
      minToStart: room.minToStart,
      hostCharacterId: room.hostCharacterId,
      members: this._memberSummaries(room),
      bossHp: Math.round(bossHp),
      bossMaxHp: room.bossMaxHp,
      phaseIndex,
      enrageRemainingSec: remainingSec != null ? Math.round(remainingSec) : null,
      result: room.result,
      reward: room.reward,
      tickSeq: room.tickSeq,
    };
  }

  getLog(code) {
    const room = this.getRoom(code);
    return room ? room.log : null;
  }
}

module.exports = { RoomManager };
