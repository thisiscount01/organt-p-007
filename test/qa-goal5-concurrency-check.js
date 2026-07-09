'use strict';
/**
 * QA 독립 동시성 재현 스크립트 (Task 040051-1, 목표5 최종 인수용).
 *
 * 작성자=QA(백엔드 아님) — GOAL.md Interfaces: "QA=동시성 재현 스크립트+최종 e2e 인수(만든 사람 아닌
 * 독립 검증)". 백엔드의 test/concurrency-check.js·test/hunt-in-combat-check.js를 신뢰하지 않고
 * 처음부터 다시 재현한다(같은 서버 코드를 대상으로 하되, 시나리오 구성·반복횟수·판정기준은 독립적으로
 * 설계) — REPORTS.md의 "PASS"라는 문서 진술이 아니라 이 run 로그가 증거다.
 *
 * 목표5 acceptance(=GOAL.md 5번): 3개 동시성 시나리오(①마지막자리경합 ②보스HP오버킬 중복클리어
 * ③접속끊김 유예20초 재접속) + GDD.md §6-1 "5번째 케이스"(IN_COMBAT 중 사냥터 이중파밍 차단)가
 * "정확히 한 번만" 판정됨을 실제 WS 다중접속(socket.io-client)+REST 왕복으로 증명한다.
 *
 * 각 경합 시나리오는 1회성 우연 통과를 배제하기 위해 N회(기본 5) 반복한다 — Node 이벤트루프가
 * 단일 스레드라 결정적이라 해도, 그 결정성 자체가 "매번 정확히 한 번"인지는 반복해서 확인해야
 * 진짜 증거다.
 *
 * 실행(이 워크스페이스 절대경로 EACCES 우회 — test/_sandbox-loader.js 표준 부트스트랩):
 *   node -e "
 *     const fs = require('fs');
 *     const code = fs.readFileSync('./test/_sandbox-loader.js', 'utf8');
 *     const mod = { exports: {} };
 *     new Function('module','exports','require','__filename','__dirname', code)(
 *       mod, mod.exports, require, '/test/_sandbox-loader.js', '/test');
 *     loader = mod.exports;
 *     loader.run('/test/qa-goal5-concurrency-check.js');
 *   "
 */
const path = require('path');
const http = require('http');
const { io: ioClient } = require('socket.io-client');

const mod = require(path.join(__dirname, '..', 'server.js'));
const { server, roomManager, balance } = mod;
const store = require(path.join(__dirname, '..', 'lib', 'store.js'));

// 테스트 전용 인메모리 패치(파일 미변경) — 시나리오를 몇 초 안에 반복 재현하기 위함.
balance.bossRoom.reconnectGraceSeconds = 2;

let pass = 0;
let fail = 0;
const failures = [];
function check(label, ok, detail) {
  if (ok) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`FAIL  ${label} ${detail !== undefined ? '- ' + JSON.stringify(detail) : ''}`);
  }
}

let seq = 0;
function mkCharacter(name, className, level) {
  seq++;
  const c = {
    id: `qa-${name}-${seq}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    class: className,
    level: level || 6,
    exp: 0,
    gold: 0,
    enhanceLevel: 0,
    inventory: [],
    lastKillAt: 0,
    downedUntil: 0,
    createdAt: Date.now(),
  };
  store.saveCharacter(c);
  return c;
}

function connectClient(port) {
  return ioClient(`http://localhost:${port}`, { transports: ['websocket'], forceNew: true });
}
function waitFor(socket, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs || 8000);
    socket.once(event, (payload) => {
      clearTimeout(t);
      resolve(payload);
    });
  });
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function httpJson(port, method, path_) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: 'localhost', port, path: path_, method, headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(body) });
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// ---------- 시나리오 ①: 마지막 자리 경합(N회 반복) ----------
async function scenarioLastSlotRace(port, trial) {
  const host = mkCharacter(`race-host${trial}`, 'warrior');
  const p2 = mkCharacter(`race-p2-${trial}`, 'warrior');
  const p3 = mkCharacter(`race-p3-${trial}`, 'warrior');
  const cA = mkCharacter(`race-A-${trial}`, 'warrior');
  const cB = mkCharacter(`race-B-${trial}`, 'warrior');
  const room = roomManager.createRoom(host);

  const sHost = connectClient(port);
  const s2 = connectClient(port);
  const s3 = connectClient(port);
  const sA = connectClient(port);
  const sB = connectClient(port);
  await Promise.all([sHost, s2, s3, sA, sB].map((s) => waitFor(s, 'connect')));

  sHost.emit('room:join', { code: room.code, characterId: host.id });
  await waitFor(sHost, 'room:joined');
  s2.emit('room:join', { code: room.code, characterId: p2.id });
  await waitFor(s2, 'room:joined');
  s3.emit('room:join', { code: room.code, characterId: p3.id });
  await waitFor(s3, 'room:joined');

  // 3/4 상태에서 마지막 자리를 두 명이 "동시에"(같은 이벤트루프 틱에 emit) 요청.
  const resultA = new Promise((resolve) => {
    sA.once('room:joined', () => resolve('joined'));
    sA.once('room:error', (e) => resolve(`error:${e.error}`));
  });
  const resultB = new Promise((resolve) => {
    sB.once('room:joined', () => resolve('joined'));
    sB.once('room:error', (e) => resolve(`error:${e.error}`));
  });
  sA.emit('room:join', { code: room.code, characterId: cA.id });
  sB.emit('room:join', { code: room.code, characterId: cB.id });
  const [ra, rb] = await Promise.all([resultA, resultB]);
  const joinedCount = [ra, rb].filter((r) => r === 'joined').length;
  const rejectedOk = [ra, rb].filter((r) => r === 'error:room_full' || r === 'error:room_locked').length;

  check(`①경합trial${trial} — 정확히 1명만 입장(정원=capacity 불변)`, joinedCount === 1 && room.members.size === room.capacity, {
    ra, rb, members: room.members.size, capacity: room.capacity,
  });
  check(`①경합trial${trial} — 패자는 정상 거부사유(room_full/room_locked)`, rejectedOk === 1, { ra, rb });

  // 로그 tick_seq가 단조증가(직렬화 증거) — join_rejected/member_join 이벤트가 정확히 한 건씩만 남았는지.
  const joinRelated = room.log.filter((e) => e.action === 'member_join' && [cA.id, cB.id].includes(e.actor));
  const rejectRelated = room.log.filter((e) => e.action === 'join_rejected' && [cA.id, cB.id].includes(e.actor));
  check(`①경합trial${trial} — 로그상 member_join 정확히 1건`, joinRelated.length === 1, joinRelated.length);
  check(`①경합trial${trial} — 로그상 join_rejected 정확히 1건`, rejectRelated.length === 1, rejectRelated.length);
  const seqs = room.log.map((e) => e.tick_seq);
  const sorted = [...seqs].sort((a, b) => a - b);
  check(`①경합trial${trial} — tick_seq 단조증가(직렬화)`, JSON.stringify(seqs) === JSON.stringify(sorted), seqs);

  for (const s of [sHost, s2, s3, sA, sB]) if (s.connected) s.disconnect();
}

// ---------- 시나리오 ②: 보스 HP 오버킬 → clear 정확히 1회 + 골드 중복지급 없음(N회 반복) ----------
async function scenarioOverkillOnce(port, trial) {
  balance.boss.hp = 4; // 4인 tick 딜(수십~수백)이 즉시 오버킬하도록 극단적으로 낮춤
  balance.boss.enrageSeconds = 30;
  const members = [1, 2, 3, 4].map((i) => mkCharacter(`ok${trial}-${i}`, 'mage', 8));
  const room = roomManager.createRoom(members[0]);
  const sockets = members.map(() => connectClient(port));
  await Promise.all(sockets.map((s) => waitFor(s, 'connect')));
  for (let i = 0; i < members.length; i++) {
    sockets[i].emit('room:join', { code: room.code, characterId: members[i].id });
    await waitFor(sockets[i], 'room:joined');
  }
  check(`②오버킬trial${trial} — 4인 입장 즉시 LOCKED`, room.state === 'LOCKED', room.state);

  // 골드 확인용 스냅샷(전투 시작 전)
  const goldBefore = members.map((m) => store.getCharacter(m.id).gold);

  await sleep(3300); // LOCKED 준비(3s)
  await sleep(1500); // 최소 1tick 더 — boss.hp=4라 첫 tick에서 확정 오버킬

  check(`②오버킬trial${trial} — RESULT로 전이`, room.state === 'RESULT', room.state);
  const clearEvents = room.log.filter((e) => e.action === 'clear');
  const wipeEvents = room.log.filter((e) => e.action === 'wipe');
  check(`②오버킬trial${trial} — clear/wipe 이벤트 로그상 정확히 1건`, clearEvents.length + wipeEvents.length === 1, {
    clear: clearEvents.length, wipe: wipeEvents.length,
  });

  if (room.result === 'clear') {
    const goldAfter = members.map((m) => store.getCharacter(m.id).gold);
    const diffs = goldAfter.map((g, i) => g - goldBefore[i]);
    const nonZero = diffs.filter((d) => d > 0);
    // 보상 대상 전원이 정확히 1회분(goldPerMember)만 받았는지 — 2회 지급이면 diff가 goldPerMember의 배수로 튐.
    const gpm = room.reward ? room.reward.goldPerMember : null;
    check(`②오버킬trial${trial} — 골드 지급이 인당 정확히 1회분(중복지급 없음)`, gpm != null && nonZero.every((d) => d === gpm), {
      diffs, goldPerMember: gpm,
    });
  }

  for (const s of sockets) if (s.connected) s.disconnect();
}

// ---------- 시나리오 ③: 접속끊김 유예(2s로 패치) + 재접속/만료 ----------
async function scenarioReconnectGrace(port) {
  balance.boss.hp = 50000; // 이번엔 전투가 도중 끝나면 안 됨 — 유예 로직만 보려는 것
  const host = mkCharacter('grace-host', 'warrior');
  const p2 = mkCharacter('grace-p2', 'warrior');
  const room = roomManager.createRoom(host);
  const sHost = connectClient(port);
  const sP2 = connectClient(port);
  await Promise.all([waitFor(sHost, 'connect'), waitFor(sP2, 'connect')]);
  sHost.emit('room:join', { code: room.code, characterId: host.id });
  await waitFor(sHost, 'room:joined');
  sP2.emit('room:join', { code: room.code, characterId: p2.id });
  await waitFor(sP2, 'room:joined');

  sHost.emit('room:start', { code: room.code, characterId: host.id }); // minToStart=2 충족
  await sleep(3300);
  check('③유예 — room:start로 IN_COMBAT 진입(정원 미달이어도)', room.state === 'IN_COMBAT', room.state);

  // 서버 push 검증용: room:tick의 reconnectRemainingSec을 실제 수신해 감소 추이를 본다(클라 추정 금지 계약).
  const ticksSeen = [];
  const tickListener = (payload) => {
    const m = payload.members.find((mm) => mm.characterId === p2.id);
    if (m) ticksSeen.push(m.reconnectRemainingSec);
  };
  sHost.on('room:tick', tickListener);

  sP2.disconnect();
  await sleep(200);
  const memberJustAfter = room.members.get(p2.id);
  check('③유예 — 끊긴 직후 슬롯 유지+connected=false', !!memberJustAfter && memberJustAfter.connected === false);

  await sleep(1200); // 유예(2s) 안, 서버 push 몇 틱 관찰
  sHost.off('room:tick', tickListener);
  const numericTicks = ticksSeen.filter((v) => v != null);
  check('③유예 — 서버가 매 tick 잔여시간을 push(getState 재조회 없이 room:tick으로 수신)', numericTicks.length >= 1, ticksSeen);
  const strictlyNonIncreasing = numericTicks.every((v, i) => i === 0 || v <= numericTicks[i - 1]);
  check('③유예 — 잔여시간이 매 tick 감소 추이(서버 계산, 고정값 아님)', strictlyNonIncreasing, numericTicks);

  // 유예 안에 재접속 — 슬롯 복귀 + 캐릭터ID→소켓 1:1 강제(구소켓 강제종료) 확인.
  const sP2New = connectClient(port);
  await waitFor(sP2New, 'connect');
  sP2New.emit('room:join', { code: room.code, characterId: p2.id });
  await waitFor(sP2New, 'room:joined');
  const memberAfterReconnect = room.members.get(p2.id);
  check('③유예 — 유예 내 재접속 시 같은 슬롯 복귀(connected=true,retired=false)', memberAfterReconnect.connected === true && memberAfterReconnect.retired === false);
  await sleep(150);
  check('③유예 — 캐릭터ID 1:1 강제로 구소켓 서버가 강제종료', sP2.connected === false);

  // 남의 characterId로 재접속 시도해도 소유권 없인 dodge 등 액션이 안 먹는지(소유권 검증 간접 확인)
  sP2New.emit('room:dodge', { code: room.code, characterId: host.id }); // 사칭
  const spoofErr = await waitFor(sP2New, 'room:error');
  check('③유예 — 사칭 characterId로 액션 시도시 not_your_character 거부', spoofErr.error === 'not_your_character', spoofErr);

  // 다시 끊고 이번엔 유예(2s) 초과 방치 -> retired 처리
  sP2New.disconnect();
  await sleep(2600);
  const memberAfterExpiry = room.members.get(p2.id);
  check('③유예 — 유예(2s) 초과 후 자동 retired', !!memberAfterExpiry && memberAfterExpiry.retired === true, memberAfterExpiry);

  for (const s of [sHost, sP2, sP2New]) if (s.connected) s.disconnect();
}

// ---------- 시나리오 ④(5번째 케이스, GDD §6-1): IN_COMBAT 중 사냥터 이중파밍 차단 ----------
async function scenarioInCombatDoubleFarm(port) {
  balance.boss.hp = 4;
  balance.boss.enrageSeconds = 30;
  const members = [1, 2, 3, 4].map((i) => mkCharacter(`icf-${i}`, 'warrior', 6));
  const room = roomManager.createRoom(members[0]);
  const sockets = members.map(() => connectClient(port));
  await Promise.all(sockets.map((s) => waitFor(s, 'connect')));
  for (let i = 0; i < members.length; i++) {
    sockets[i].emit('room:join', { code: room.code, characterId: members[i].id });
    await waitFor(sockets[i], 'room:joined');
  }
  await sleep(3300); // LOCKED 준비
  check('④이중파밍 — IN_COMBAT 진입', room.state === 'IN_COMBAT', room.state);

  // 어뷰징 시도 재현: IN_COMBAT 중 같은 캐릭터로 hunt 요청 5개를 "동시에" 쏜다(연타/스크립트 매크로 흉내).
  const before = store.getCharacter(members[0].id);
  const results = await Promise.all(
    Array.from({ length: 5 }, () => httpJson(port, 'POST', `/api/characters/${members[0].id}/hunt`))
  );
  const allBlocked = results.every((r) => r.status === 409 && r.body.error === 'in_combat');
  check('④이중파밍 — IN_COMBAT 중 동시 hunt 5연발 전부 409 in_combat', allBlocked, results.map((r) => r.status));
  const after = store.getCharacter(members[0].id);
  check('④이중파밍 — 거부된 요청들이 실제로 exp/gold를 변화시키지 않음', after.exp === before.exp && after.gold === before.gold, {
    before: { exp: before.exp, gold: before.gold }, after: { exp: after.exp, gold: after.gold },
  });

  // 무관한(다른 방에 안 묶인) 캐릭터는 같은 시각에도 정상 사냥 가능해야(과잉차단 아님).
  const bystander = mkCharacter('icf-bystander', 'warrior');
  const bystanderRes = await httpJson(port, 'POST', `/api/characters/${bystander.id}/hunt`);
  check('④이중파밍 — 무관한 캐릭터는 같은 시각에도 정상 hunt(과잉차단 아님)', bystanderRes.status === 200, bystanderRes.body);

  await sleep(1500); // boss.hp=4라 곧 오버킬 클리어
  check('④이중파밍 — 전투 종료(RESULT)', room.state === 'RESULT', room.state);

  const afterCombatRes = await httpJson(port, 'POST', `/api/characters/${members[0].id}/hunt`);
  check('④이중파밍 — 전투 종료 후엔 같은 캐릭터의 hunt가 다시 정상 처리', afterCombatRes.status !== 409, afterCombatRes.body);

  for (const s of sockets) if (s.connected) s.disconnect();
}

async function main() {
  const PORT = 3999;
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`QA goal5 독립 재현 스크립트 — server listening on :${PORT}`);

  const N = 5;
  for (let t = 1; t <= N; t++) {
    await scenarioLastSlotRace(PORT, t);
  }
  const M = 3;
  for (let t = 1; t <= M; t++) {
    await scenarioOverkillOnce(PORT, t);
  }
  await scenarioReconnectGrace(PORT);
  await scenarioInCombatDoubleFarm(PORT);

  console.log(`\n결과: PASS ${pass} / FAIL ${fail}`);
  if (fail > 0) console.log('실패 목록:', failures);
  server.closeAllConnections && server.closeAllConnections();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('QA 재현 스크립트 오류:', err);
  process.exit(1);
});
