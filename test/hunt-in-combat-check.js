'use strict';
/**
 * GDD §6-1 회귀 검증 — 보스룸 IN_COMBAT에 바인딩된 캐릭터의 사냥터 이중 파밍 차단.
 * QA가 발견한 구멍(캐릭터가 보스룸 IN_COMBAT 중에도 REST /hunt가 막히지 않아 이중 보상 가능,
 * REPORTS.md 참고)의 재발 방지용 — reward-check.js와 동일 패턴(실서버 in-process require +
 * REST HTTP 왕복 + WS 소켓 조합)으로 검증한다.
 *
 * server.js를 in-process로 require해 boss.hp/enrageSeconds/reconnectGraceSeconds를 테스트용으로
 * 하향/조정 패치 — balance.json 원본은 건드리지 않음, concurrency-check.js·reward-check.js와
 * 동일한 패턴.
 *
 * 실행(절대경로 fs EACCES 우회 — test/_sandbox-loader.js 표준 부트스트랩):
 *   node -e "
 *     const fs = require('fs');
 *     const code = fs.readFileSync('./test/_sandbox-loader.js', 'utf8');
 *     const mod = { exports: {} };
 *     new Function('module','exports','require','__filename','__dirname', code)(
 *       mod, mod.exports, require, '/test/_sandbox-loader.js', '/test');
 *     mod.exports.run('/test/hunt-in-combat-check.js');
 *   "
 */
const path = require('path');
const http = require('http');
const { io: ioClient } = require('socket.io-client');

const mod = require(path.join(__dirname, '..', 'server.js'));
const { server, roomManager, balance } = mod;
const store = require(path.join(__dirname, '..', 'lib', 'store.js'));

balance.boss.hp = 6; // 4인분 tick 딜이 첫 tick에 오버킬 — IN_COMBAT을 짧게 유지
balance.boss.enrageSeconds = 30;
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
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function httpPostJson(port, path_) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: 'localhost', port, path: path_, method: 'POST', headers: { 'Content-Type': 'application/json' } },
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

async function main() {
  const PORT = 3904;
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`hunt-in-combat test server listening on :${PORT}`);

  // ---------- 대조군: 어느 방에도 안 묶인 캐릭터는 항상 정상 hunt ----------
  const bystander = mkCharacter('bystander', 'warrior');
  const bystanderRes = await httpPostJson(PORT, `/api/characters/${bystander.id}/hunt`);
  check(
    '방과 무관한 캐릭터의 hunt는 정상 처리(과잉차단 아님)',
    bystanderRes.status === 200 && bystanderRes.body.outcome !== undefined,
    bystanderRes.body
  );

  // ---------- 시나리오 A: IN_COMBAT 중 hunt 차단 -> 전투 종료 후 재개 ----------
  const members = [
    mkCharacter('hic-host', 'warrior'),
    mkCharacter('hic-p2', 'warrior'),
    mkCharacter('hic-p3', 'warrior'),
    mkCharacter('hic-p4', 'warrior'),
  ];
  const room = roomManager.createRoom(members[0]);
  const sockets = members.map(() => connectClient(PORT));
  await Promise.all(sockets.map((s) => waitFor(s, 'connect')));
  for (let i = 0; i < members.length; i++) {
    sockets[i].emit('room:join', { code: room.code, characterId: members[i].id });
    await waitFor(sockets[i], 'room:joined');
  }
  check('4인 입장으로 즉시 LOCKED 전이', room.state === 'LOCKED', room.state);

  await sleep(3300); // LOCKED 준비시간(3s) 통과 -> IN_COMBAT 진입 직후를 붙잡는다
  check('LOCKED 이후 IN_COMBAT 전이', room.state === 'IN_COMBAT', room.state);
  check('RoomManager.isInCombat이 방금 IN_COMBAT 멤버를 true로 봄', roomManager.isInCombat(members[0].id) === true);

  const duringCombatRes = await httpPostJson(PORT, `/api/characters/${members[0].id}/hunt`);
  check(
    'IN_COMBAT 중 hunt 시도 -> 409 in_combat 거부',
    duringCombatRes.status === 409 && duringCombatRes.body.error === 'in_combat',
    duringCombatRes.body
  );
  // 429(안티팜)나 다른 사유가 아니라 정확히 in_combat 사유로 막힌 것인지, 그리고 캐릭터 상태(exp/gold)가
  // 실제로 안 바뀌었는지까지 확인 — "거부됐다는 응답"과 "실제로 보상이 안 나갔다"는 다른 층이다.
  const charAfterBlockedHunt = store.getCharacter(members[0].id);
  check(
    '거부된 hunt는 실제로 exp/gold를 지급하지 않음(응답만 막힌 게 아니라 실제 상태 불변)',
    charAfterBlockedHunt.exp === 0 && charAfterBlockedHunt.gold === 0,
    charAfterBlockedHunt
  );

  await sleep(2000); // boss.hp=6로 패치했으니 최소 1tick(1s) 더 지나면 오버킬 클리어
  check('전투가 RESULT로 종료됨(클리어)', room.state === 'RESULT' && room.result === 'clear', {
    state: room.state,
    result: room.result,
  });
  check('전투 종료 후 RoomManager.isInCombat은 더 이상 true가 아님', roomManager.isInCombat(members[0].id) === false);

  const afterCombatRes = await httpPostJson(PORT, `/api/characters/${members[0].id}/hunt`);
  check(
    '전투 종료 후엔 같은 캐릭터의 hunt가 다시 정상 처리(outcome 존재, in_combat 아님)',
    afterCombatRes.status !== 409 && afterCombatRes.body.outcome !== undefined,
    afterCombatRes.body
  );

  // ---------- 시나리오 B: 유예 만료로 retired된 멤버는 (그 방이 여전히 IN_COMBAT이어도) hunt 재개 가능 ----------
  // retired는 그 보스전의 클리어 보상 대상에서도 이미 빠지므로(lib/rooms.js._finish의 eligible 필터와
  // 대칭) hunt까지 막을 이유가 없다는 설계 판단 — 이 회귀 테스트로 그 판단을 고정한다.
  balance.boss.hp = 50000; // 이번엔 전투가 테스트 도중 안 끝나야(살아있는 IN_COMBAT 상태에서 재현) 하므로 크게.
  const hostB = mkCharacter('hic-hostB', 'warrior');
  const p2B = mkCharacter('hic-p2B', 'warrior');
  const roomB = roomManager.createRoom(hostB);
  const sHostB = connectClient(PORT);
  const sP2B = connectClient(PORT);
  await Promise.all([waitFor(sHostB, 'connect'), waitFor(sP2B, 'connect')]);
  sHostB.emit('room:join', { code: roomB.code, characterId: hostB.id });
  await waitFor(sHostB, 'room:joined');
  sP2B.emit('room:join', { code: roomB.code, characterId: p2B.id });
  await waitFor(sP2B, 'room:joined');
  check('2/4 입장 상태는 아직 FORMING(정원 미달)', roomB.state === 'FORMING', roomB.state);

  sHostB.emit('room:start', { code: roomB.code, characterId: hostB.id }); // minToStart=2 충족, 호스트가 명시 시작
  await sleep(3300); // LOCKED 준비시간(3s) 통과
  check('room:start로 정원 미달이어도 IN_COMBAT 진입', roomB.state === 'IN_COMBAT', roomB.state);

  sP2B.disconnect();
  await sleep(3600); // reconnectGraceSeconds(2s로 패치) 초과 + tick(1Hz) 정렬 오차 여유(최대 1tick)
  const p2BAfterGrace = roomB.members.get(p2B.id);
  check('유예 초과로 p2B가 retired 처리됨', !!p2BAfterGrace && p2BAfterGrace.retired === true, p2BAfterGrace);
  check('roomB는 여전히 IN_COMBAT(전멸/클리어 아님, boss.hp를 크게 패치했으므로)', roomB.state === 'IN_COMBAT', roomB.state);

  const retiredHuntRes = await httpPostJson(PORT, `/api/characters/${p2B.id}/hunt`);
  check(
    'retired된 멤버는 그 방이 IN_COMBAT이어도 hunt 재개 가능(보상 대상에서도 이미 빠졌으므로)',
    retiredHuntRes.status !== 409,
    retiredHuntRes.body
  );

  const stillActiveHuntRes = await httpPostJson(PORT, `/api/characters/${hostB.id}/hunt`);
  check(
    '같은 방의 은퇴 안 한(여전히 활성) 멤버는 그대로 hunt 차단 유지',
    stillActiveHuntRes.status === 409 && stillActiveHuntRes.body.error === 'in_combat',
    stillActiveHuntRes.body
  );

  console.log(`\n결과: PASS ${pass} / FAIL ${fail}`);
  for (const s of [...sockets, sHostB, sP2B]) {
    if (s.connected) s.disconnect();
  }
  server.closeAllConnections && server.closeAllConnections();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('테스트 스크립트 오류:', err);
  process.exit(1);
});
