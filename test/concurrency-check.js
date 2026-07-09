'use strict';
/**
 * 백엔드 자체 경계 검증 스크립트 — QA의 공식 재현 스크립트를 대체하지 않는다(그건 QA 소유).
 * 넘기기 전에 내가 먼저 부딪혀서 깨봐야 믿을 수 있다는 원칙에 따라, 회의에서 QA가 짚은
 * 3개 동시성 시나리오(마지막 자리 경합/오버킬 중복클리어/접속끊김 유예 재접속)를
 * 실제 WS 다중 접속(socket.io-client)으로 재현해 "정확히 한 번만" 판정되는지 확인한다.
 *
 * boss.hp/enrageSeconds/reconnectGraceSeconds를 테스트용으로 하향 패치한다 — balance.json 원본은
 * 건드리지 않음, 이 스크립트 안에서만 인메모리로 잠깐 바꿔 쓰고 끝난다.
 *
 * 실행(이 워크스페이스는 절대경로 fs가 EACCES라 `node test/concurrency-check.js` 직접 실행은
 * MODULE_NOT_FOUND로 죽는다 — test/_sandbox-loader.js 표준 부트스트랩으로 우회, 그 파일 상단
 * 사용법 주석 참고):
 *   node -e "
 *     const fs = require('fs');
 *     const code = fs.readFileSync('./test/_sandbox-loader.js', 'utf8');
 *     const mod = { exports: {} };
 *     new Function('module','exports','require','__filename','__dirname', code)(
 *       mod, mod.exports, require, '/test/_sandbox-loader.js', '/test');
 *     mod.exports.run('/test/concurrency-check.js');
 *   "
 */
const path = require('path');
const { io: ioClient } = require('socket.io-client');

const mod = require(path.join(__dirname, '..', 'server.js'));
const { server, roomManager, balance } = mod;
const store = require(path.join(__dirname, '..', 'lib', 'store.js'));

// 빠른 테스트를 위한 인메모리 패치(파일에는 반영 안 함) — 실제 밸런스는 여전히 balance.json 그대로.
balance.boss.hp = 6;
balance.boss.enrageSeconds = 8;
balance.bossRoom.reconnectGraceSeconds = 2;

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label} ${detail !== undefined ? '- ' + JSON.stringify(detail) : ''}`);
  }
}

function mkCharacter(name, className, level) {
  const c = {
    id: `char-${name}-${Math.random().toString(36).slice(2, 8)}`,
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

function waitFor(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

async function main() {
  const PORT = 3901;
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`test server listening on :${PORT}`);

  // ---------- 시나리오 1: 마지막 자리 경합 ----------
  const host = mkCharacter('host', 'warrior');
  const room1 = roomManager.createRoom(host);
  const p2 = mkCharacter('p2', 'warrior');
  const p3 = mkCharacter('p3', 'warrior');
  const cRace = mkCharacter('race-c', 'warrior');
  const cRace2 = mkCharacter('race-d', 'warrior');

  const sHost = connectClient(PORT);
  const s2 = connectClient(PORT);
  const s3 = connectClient(PORT);
  const sRaceA = connectClient(PORT);
  const sRaceB = connectClient(PORT);
  await Promise.all([
    waitFor(sHost, 'connect'),
    waitFor(s2, 'connect'),
    waitFor(s3, 'connect'),
    waitFor(sRaceA, 'connect'),
    waitFor(sRaceB, 'connect'),
  ]);

  sHost.emit('room:join', { code: room1.code, characterId: host.id });
  await waitFor(sHost, 'room:joined');
  s2.emit('room:join', { code: room1.code, characterId: p2.id });
  await waitFor(s2, 'room:joined');
  s3.emit('room:join', { code: room1.code, characterId: p3.id });
  await waitFor(s3, 'room:joined');
  // 이제 3/4 — 마지막 한 자리를 두 캐릭터가 "동시에" 노린다.
  const raceAResult = new Promise((resolve) => {
    sRaceA.once('room:joined', () => resolve('joined'));
    sRaceA.once('room:error', (e) => resolve(`error:${e.error}`));
  });
  const raceBResult = new Promise((resolve) => {
    sRaceB.once('room:joined', () => resolve('joined'));
    sRaceB.once('room:error', (e) => resolve(`error:${e.error}`));
  });
  sRaceA.emit('room:join', { code: room1.code, characterId: cRace.id });
  sRaceB.emit('room:join', { code: room1.code, characterId: cRace2.id });
  const [ra, rb] = await Promise.all([raceAResult, raceBResult]);
  const joinedCount = [ra, rb].filter((r) => r === 'joined').length;
  // 승자가 방을 4/4로 채우는 순간 state가 즉시 LOCKED로 전이되므로, 패자는 room_full(정원초과)
  // 또는 room_locked(락 전이 후 도착) 둘 다 "못 들어갔다"는 정상 거부 사유 — 핵심은 "정확히 1명만".
  const rejectedCount = [ra, rb].filter((r) => r === 'error:room_full' || r === 'error:room_locked').length;
  check('마지막 1자리 경합 — 정확히 1명만 입장, 나머지는 거부(room_full/room_locked)', joinedCount === 1 && rejectedCount === 1, {
    ra,
    rb,
  });
  check('경합 후 정원 초과 없음(멤버 수 == capacity)', room1.members.size === room1.capacity, room1.members.size);

  // ---------- 시나리오 2: 오버킬/중복 클리어 방지 ----------
  // 위 room1은 이미 4/4라 곧 LOCKED->IN_COMBAT 자동 전이(3s 후). boss.hp=6로 패치했으니 첫 tick에 즉사(오버킬).
  await new Promise((resolve) => setTimeout(resolve, 4500)); // LOCKED 준비시간(3s) 통과 대기
  check('LOCKED 이후 IN_COMBAT 자동 전이', room1.state === 'IN_COMBAT' || room1.state === 'RESULT', room1.state);
  await new Promise((resolve) => setTimeout(resolve, 2000)); // 최소 1tick(1s) 더 지나 보스 처치되게
  const clearEvents = room1.log.filter((e) => e.action === 'clear');
  const wipeEvents = room1.log.filter((e) => e.action === 'wipe');
  check(
    '보스 HP 오버킬(4인분 tick 딜이 6HP를 한번에 초과)에도 clear 이벤트가 정확히 1회',
    clearEvents.length + wipeEvents.length === 1,
    { clear: clearEvents.length, wipe: wipeEvents.length, state: room1.state, bossHp: room1.bossHp }
  );
  check('상태머신이 RESULT로 정확히 1회 전이(재전이 없음)', room1.state === 'RESULT', room1.state);

  // ---------- 시나리오 3: 접속 끊김 유예(2s로 패치) 후 재접속 ----------
  const hostB = mkCharacter('hostB', 'warrior');
  const p2B = mkCharacter('p2B', 'warrior');
  const room2 = roomManager.createRoom(hostB);
  const sHostB = connectClient(PORT);
  const sP2B = connectClient(PORT);
  await Promise.all([waitFor(sHostB, 'connect'), waitFor(sP2B, 'connect')]);
  sHostB.emit('room:join', { code: room2.code, characterId: hostB.id });
  await waitFor(sHostB, 'room:joined');
  sP2B.emit('room:join', { code: room2.code, characterId: p2B.id });
  await waitFor(sP2B, 'room:joined');

  sP2B.disconnect(); // 접속 끊김
  await new Promise((resolve) => setTimeout(resolve, 300));
  const memberAfterDisconnect = room2.members.get(p2B.id);
  check('접속 끊김 직후 슬롯은 유지되되 connected=false', !!memberAfterDisconnect && memberAfterDisconnect.connected === false);

  // 유예(2s) 안에 같은 캐릭터로 새 소켓 재접속
  const sP2BNew = connectClient(PORT);
  await waitFor(sP2BNew, 'connect');
  sP2BNew.emit('room:join', { code: room2.code, characterId: p2B.id });
  const rejoinSnap = await waitFor(sP2BNew, 'room:joined');
  const memberAfterReconnect = room2.members.get(p2B.id);
  check(
    '유예시간 내 재접속 시 같은 슬롯으로 복귀(connected=true, retired=false)',
    memberAfterReconnect.connected === true && memberAfterReconnect.retired === false
  );
  check('재조회 스냅샷(getState 동등)에도 멤버 수 불변(2명)', rejoinSnap.members.length === 2, rejoinSnap.members.length);

  // 캐릭터ID→소켓 1:1 강제: 재접속 시 이전 소켓은 서버가 끊었어야 함
  const oldSocketStillConnected = sP2B.connected;
  check('캐릭터ID 1:1 강제 — 재접속 시 이전 소켓은 서버가 강제 종료', oldSocketStillConnected === false);

  // 유예 만료 케이스: 다시 끊고 이번엔 유예(2s) 넘게 방치 -> retired 처리 확인
  sP2BNew.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 2600));
  const memberAfterExpiry = room2.members.get(p2B.id);
  check(
    '유예시간(2s) 초과 후 자동 은퇴(retired) 또는 슬롯 반환',
    !memberAfterExpiry || memberAfterExpiry.retired === true,
    memberAfterExpiry
  );

  console.log(`\n결과: PASS ${pass} / FAIL ${fail}`);
  for (const s of [sHost, s2, s3, sRaceA, sRaceB, sHostB, sP2B, sP2BNew]) {
    if (s.connected) s.disconnect();
  }
  server.closeAllConnections && server.closeAllConnections();
  process.exit(fail > 0 ? 1 : 0); // 하드 종료 — WS 커넥션 잔존으로 server.close()가 멈추는 걸 피함(테스트 스크립트 한정)
}

main().catch((err) => {
  console.error('테스트 스크립트 오류:', err);
  process.exit(1);
});
