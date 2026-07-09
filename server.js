'use strict';
/**
 * 레이드 RPG 서버 코어 — REST(캐릭터 영속·사냥터 판정) + WS(Socket.IO, 보스룸 실시간 상태머신).
 * 소유: 백엔드(server.js 전체). balance.json 수치는 게임기획자 소유 — 여기서 임의로 바꾸지 않는다.
 *
 * 기동: PORT(기본 3000), DATA_DIR(기본 ./data) 둘 다 process.env로 열려 있어 환경이 바뀌어도 코드는 그대로.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const combatMath = require('./lib/combatMath');
const store = require('./lib/store');
const { RoomManager } = require('./lib/rooms');

const balance = JSON.parse(fs.readFileSync(path.join(__dirname, 'balance.json'), 'utf8'));
const CLASS_NAMES = Object.keys(balance.classes);

// 배포 검증 마커 — /healthz에 노출한다. 재배포가 실제로 롤됐는지(캐시된 옛 인스턴스가 아니라 새 빌드가
// 라이브인지)를 이 값의 변화로 제3자가 재현 확인할 수 있게 한다. env 변경(DATA_DIR 영속 디스크 등)은
// 재배포로만 픽업되므로, 이 마커가 갱신됐다 == 새 env가 적용된 인스턴스가 라이브다.
const BUILD_TAG = 'persist-verify-2';

const app = express();
app.use(express.json());

// ---- 정적 클라이언트(public/) 서빙 ----
// Render는 이 프로세스 하나가 API+WS+정적파일을 전부 서빙하는 단일 웹 서비스라, express.static이
// 없으면 배포 후 사용자가 도메인에 접속해도 빈 화면(또는 404)만 본다 — /api, /healthz, /socket.io는
// 각각 고유 경로 프리픽스라 정적 서빙과 경로가 안 겹친다(express.static은 그 경로들에 매칭되는
// 파일이 public/ 밑에 없으므로 항상 next()로 넘어가고, 실제 /api 라우트가 그 뒤에서 처리한다).
app.use(express.static(path.join(__dirname, 'public')));

// ---- 입력 검증 유틸 ----
function hasControlChar(str) {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isValidName(name) {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 20) return false;
  // 제어문자·경로순회 문자 차단(이름이 파일명으로 쓰이진 않지만 방어적으로 막는다)
  if (hasControlChar(trimmed)) return false;
  if (trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\')) return false;
  return true;
}

function publicCharacter(c) {
  const stats = combatMath.finalStats(balance, c.class, c.level, c.enhanceLevel);
  return {
    id: c.id,
    name: c.name,
    class: c.class,
    level: c.level,
    exp: c.exp,
    expToNext: combatMath.expRequired(balance, c.level),
    gold: c.gold,
    enhanceLevel: c.enhanceLevel,
    inventory: c.inventory,
    stats: { hp: Math.round(stats.hp), def: Math.round(stats.def * 10) / 10, dps: Math.round(stats.dps * 10) / 10 },
    downedUntil: c.downedUntil || null,
    createdAt: c.createdAt,
  };
}

// ---- 캐릭터 REST ----
app.post('/api/characters', (req, res) => {
  const { name, class: className } = req.body || {};
  if (!isValidName(name)) {
    return res.status(400).json({ error: 'invalid_name', detail: '1~20자, 제어문자/경로문자 불가' });
  }
  if (!CLASS_NAMES.includes(className)) {
    return res.status(400).json({ error: 'invalid_class', allowed: CLASS_NAMES });
  }
  const character = {
    id: crypto.randomUUID(),
    name: name.trim(),
    class: className,
    level: 1,
    exp: 0,
    gold: 0,
    enhanceLevel: 0,
    inventory: [],
    lastKillAt: 0,
    downedUntil: 0,
    createdAt: Date.now(),
  };
  store.saveCharacter(character);
  res.status(201).json(publicCharacter(character));
});

app.get('/api/characters/:id', (req, res) => {
  const c = store.getCharacter(req.params.id);
  if (!c) return res.status(404).json({ error: 'not_found' });
  res.json(publicCharacter(c));
});

app.get('/api/characters/:id/inventory', (req, res) => {
  const c = store.getCharacter(req.params.id);
  if (!c) return res.status(404).json({ error: 'not_found' });
  res.json({ gold: c.gold, enhanceLevel: c.enhanceLevel, inventory: c.inventory });
});

// 사냥터 처치 판정 — 서버가 유효성(안티팜 간격) 검증 후 exp/gold/드롭을 계산한다(클라 자기신고 없음).
app.post('/api/characters/:id/hunt', async (req, res) => {
  const id = req.params.id;
  try {
    const result = await store.withCharacterLock(id, () => {
      const c = store.getCharacter(id);
      if (!c) return { status: 404, body: { error: 'not_found' } };

      // GDD §6-1: 보스룸 IN_COMBAT에 바인딩된 캐릭터는 사냥터 이중 파밍 금지(어뷰징 경로 차단).
      if (roomManager.isInCombat(id)) {
        return { status: 409, body: { error: 'in_combat' } };
      }

      const now = Date.now();
      if (c.downedUntil && now < c.downedUntil) {
        return {
          status: 409,
          body: { error: 'downed', respawnInMs: c.downedUntil - now },
        };
      }
      const minInterval = balance.huntingZone.antiFarmMinKillIntervalMs;
      if (now - c.lastKillAt < minInterval) {
        return {
          status: 429,
          body: { error: 'too_fast', retryInMs: minInterval - (now - c.lastKillAt) },
        };
      }

      const tier = combatMath.zoneTierForLevel(balance, c.level);
      const stats = combatMath.finalStats(balance, c.class, c.level, c.enhanceLevel);

      // 몬스터 반격 판정 — 저레벨/저강화로 존 대비 화력이 부족하면 드물게 다운(리스폰 유도)
      const dmgTaken = Math.max(0, tier.monsterATK - stats.def);
      const deathChance = dmgTaken > 0 ? Math.min(0.05, dmgTaken / stats.hp) : 0;
      if (Math.random() < deathChance) {
        c.downedUntil = now + balance.huntingZone.respawnSeconds * 1000;
        c.lastKillAt = now;
        store.saveCharacter(c);
        return {
          status: 200,
          body: {
            outcome: 'died',
            respawnInMs: balance.huntingZone.respawnSeconds * 1000,
            character: publicCharacter(c),
          },
        };
      }

      c.lastKillAt = now;
      const goldGain = tier.gold;
      let drop = null;
      if (Math.random() < tier.dropChance) {
        drop = {
          id: crypto.randomUUID(),
          name: `${tier.levelRange[0]}~${tier.levelRange[1]}존 전리품`,
          tier: tier.levelRange,
        };
        c.inventory.push(drop);
      }
      const { level, exp, leveledUp } = combatMath.applyExp(balance, c, tier.exp);
      const oldLevel = c.level;
      c.level = level;
      c.exp = exp;
      c.gold += goldGain;
      store.saveCharacter(c);

      const body = {
        outcome: 'kill',
        expGained: tier.exp,
        goldGained: goldGain,
        drop,
        leveledUp,
        oldLevel,
        newLevel: c.level,
        character: publicCharacter(c),
      };
      return { status: 200, body };
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    res.status(500).json({ error: 'internal_error', detail: String(err.message || err) });
  }
});

app.post('/api/characters/:id/enhance', async (req, res) => {
  const id = req.params.id;
  try {
    const result = await store.withCharacterLock(id, () => {
      const c = store.getCharacter(id);
      if (!c) return { status: 404, body: { error: 'not_found' } };
      if (c.enhanceLevel >= balance.enhancement.maxLevel) {
        return { status: 400, body: { error: 'max_enhance_level' } };
      }
      const cost = balance.enhancement.costGold[c.enhanceLevel];
      if (c.gold < cost) {
        return { status: 400, body: { error: 'insufficient_gold', need: cost, have: c.gold } };
      }
      c.gold -= cost;
      c.enhanceLevel += 1;
      store.saveCharacter(c);
      return { status: 200, body: { outcome: 'enhanced', newEnhanceLevel: c.enhanceLevel, character: publicCharacter(c) } };
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    res.status(500).json({ error: 'internal_error', detail: String(err.message || err) });
  }
});

// ---- 보스룸 REST(방 생성 + 스냅샷 재조회) ----
let roomManager; // io 준비된 뒤 생성

app.post('/api/rooms', (req, res) => {
  const { characterId } = req.body || {};
  const c = characterId && store.getCharacter(characterId);
  if (!c) return res.status(404).json({ error: 'character_not_found' });
  const room = roomManager.createRoom(c);
  res.status(201).json(roomManager.getSnapshot(room.code));
});

// 클라 상태 스냅샷 재조회 — WS 이벤트 유실 시 이 엔드포인트로 추론 대신 재조회.
app.get('/api/rooms/:code/state', (req, res) => {
  const snap = roomManager.getSnapshot(req.params.code);
  if (!snap) return res.status(404).json({ error: 'room_not_found' });
  res.json(snap);
});

app.get('/api/rooms/:code/log', (req, res) => {
  const log = roomManager.getLog(req.params.code);
  if (!log) return res.status(404).json({ error: 'room_not_found' });
  res.json({ code: req.params.code.toUpperCase(), events: log });
});

app.get('/healthz', (req, res) => {
  res.json({ ok: true, build: BUILD_TAG, uptimeSec: Math.round(process.uptime()), dataDir: store.DATA_DIR, classes: CLASS_NAMES });
});

// ---- 항상 JSON으로만 응답(HTML 스택트레이스 유출 금지) ----
app.use((req, res) => res.status(404).json({ error: 'not_found_route' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // express.json()이 깨진 바디를 만나면 여기로 온다 — 클라이언트 잘못이니 500이 아니라 400.
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid_json_body' });
  }
  res.status(500).json({ error: 'internal_error', detail: String((err && err.message) || err) });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
roomManager = new RoomManager(balance);

io.on('connection', (socket) => {
  socket.on('room:join', ({ code, characterId } = {}) => {
    const character = characterId && store.getCharacter(characterId);
    if (!character) return socket.emit('room:error', { error: 'character_not_found' });
    const result = roomManager.joinRoom(io, socket, code, character);
    if (!result.ok) return socket.emit('room:error', { error: result.error });
    socket.emit('room:joined', roomManager.getSnapshot(result.room.code));
    io.to(result.room.code).emit('room:state', roomManager.getSnapshot(result.room.code));
  });

  socket.on('room:start', ({ code, characterId } = {}) => {
    const result = roomManager.startCombat(io, code, characterId);
    if (!result.ok) return socket.emit('room:error', { error: result.error, ...result });
    io.to(code.toUpperCase()).emit('room:state', roomManager.getSnapshot(code));
  });

  // GDD §6: 텔레그래프 반응윈도우 내 회피 입력 — 성공/실패를 보낸 소켓에게 즉시 ack(다음 tick까지
  // 기다리지 않아도 프론트가 회피 성공 여부를 바로 연출할 수 있게) *및* 같은 방 파티원 전원에게도
  // 브로드캐스트한다 — "여러 명이 함께 도전"이 존재이유인 만큼 팀원의 회피 성공/실패를 서로 볼 수
  // 있어야 협동이 체감된다(room:tick은 1Hz 요약이라 회피처럼 순간적인 반응 이벤트를 실시간으로
  // 못 실어나름 — 그래서 dodge는 tick과 별도로 즉시 이벤트를 쏜다). characterId를 payload에 실어
  // "누가" 회피했는지 구분 가능하게 하고, socket.emit(본인)+socket.to(나머지)로 나눠 같은 방
  // 소켓 각자가 이벤트를 정확히 1번씩만 받게 한다(io.to(room).emit을 쓰면 발신자도 중복 수신함).
  // 소유권 강제: characterId는 클라 자기신고라, room:join과 동일하게 "이 소켓이 그 characterId의
  // 현재 바인딩 소켓인가"를 roomManager.registerDodge 내부에서 검증한다 — 아니면 not_your_character.
  socket.on('room:dodge', ({ code, characterId } = {}) => {
    if (!code || !characterId) return socket.emit('room:error', { error: 'invalid_dodge_request' });
    const result = roomManager.registerDodge(io, socket, code, characterId);
    if (!result.ok) return socket.emit('room:error', { error: result.error });
    const payload = { characterId, success: result.success };
    socket.emit('room:dodgeResult', payload);
    socket.to(code.toUpperCase()).emit('room:dodgeResult', payload);
  });

  socket.on('disconnect', () => {
    roomManager.handleDisconnect(io, socket.id);
  });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`raid-rpg server listening on :${PORT} (dataDir=${store.DATA_DIR})`);
  });
}

module.exports = { app, server, io, roomManager, balance };
