'use strict';
/**
 * 보스 클리어 보상이 화면 문구뿐 아니라 실제 캐릭터 골드에 반영되는지 검증하는 자체 회귀 스크립트.
 * GOAL.md 2번 "클리어 시 사냥터보다 확실히 좋은 보상 지급"이 lib/rooms.js._finish에서 room.reward
 * 계산만 하고 store.saveCharacter로 실제 반영을 안 하던 결함(REPORTS.md 참고)의 재발 방지용.
 *
 * server.js를 in-process로 require해 boss.hp를 테스트용으로 하향 패치 — balance.json 원본은
 * 안 건드림, concurrency-check.js와 동일한 패턴.
 *
 * 실행(절대경로 fs EACCES 우회 — test/_sandbox-loader.js 표준 부트스트랩):
 *   node -e "
 *     const fs = require('fs');
 *     const code = fs.readFileSync('./test/_sandbox-loader.js', 'utf8');
 *     const mod = { exports: {} };
 *     new Function('module','exports','require','__filename','__dirname', code)(
 *       mod, mod.exports, require, '/test/_sandbox-loader.js', '/test');
 *     mod.exports.run('/test/reward-check.js');
 *   "
 */
const path = require('path');
const { io: ioClient } = require('socket.io-client');

const mod = require(path.join(__dirname, '..', 'server.js'));
const { server, roomManager, balance } = mod;
const store = require(path.join(__dirname, '..', 'lib', 'store.js'));

balance.boss.hp = 6;
balance.boss.enrageSeconds = 8;

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
function httpGetJson(port, path_) {
  return new Promise((resolve, reject) => {
    require('http')
      .get({ host: 'localhost', port, path: path_ }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(body) });
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

async function main() {
  const PORT = 3903;
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`reward-check test server listening on :${PORT}`);

  const members = [
    mkCharacter('rw-host', 'warrior'),
    mkCharacter('rw-p2', 'warrior'),
    mkCharacter('rw-p3', 'warrior'),
    mkCharacter('rw-p4', 'warrior'),
  ];

  // (a) 클리어 전 REST 골드 확인 — 실제 API 응답으로 0임을 증명(내부 store 직접조회가 아니라 HTTP 왕복).
  const beforeRes = await httpGetJson(PORT, `/api/characters/${members[0].id}`);
  check('클리어 전 REST 골드는 0', beforeRes.status === 200 && beforeRes.body.gold === 0, beforeRes.body);

  const room = roomManager.createRoom(members[0]);
  const sockets = members.map(() => connectClient(PORT));
  await Promise.all(sockets.map((s) => waitFor(s, 'connect')));
  for (let i = 0; i < members.length; i++) {
    sockets[i].emit('room:join', { code: room.code, characterId: members[i].id });
    await waitFor(sockets[i], 'room:joined');
  }
  check('4인 입장으로 즉시 LOCKED 전이', room.state === 'LOCKED', room.state);

  // LOCKED 준비시간(3s) + 최소 1tick(1s) 대기 — boss.hp=6로 패치했으니 첫 tick에 오버킬 클리어.
  await new Promise((resolve) => setTimeout(resolve, 5000));
  check('전투가 RESULT로 종료됨', room.state === 'RESULT', room.state);
  check('클리어로 종료됨(전멸 아님)', room.result === 'clear', room.result);

  const expectedGoldPerMember = Math.round(
    balance.huntingZone.tiers[balance.huntingZone.tiers.length - 1].gold * balance.boss.clearReward.goldMultiplierVsHuntingZone
  );
  check('reward.goldPerMember이 계산대로 노출됨', room.reward && room.reward.goldPerMember === expectedGoldPerMember, room.reward);
  check(
    'reward.goldGrantedTo에 4명 전원의 characterId가 담김',
    room.reward && room.reward.goldGrantedTo && room.reward.goldGrantedTo.length === 4,
    room.reward
  );

  // 실제 반영 검증 — internal store + REST 둘 다.
  for (const m of members) {
    const persisted = store.getCharacter(m.id);
    check(`${m.name} store 골드가 ${expectedGoldPerMember}로 반영됨`, persisted.gold === expectedGoldPerMember, persisted.gold);
  }
  // (a) 클리어 후 REST 골드 diff — 0 -> expectedGoldPerMember를 실제 HTTP 응답으로 재확인.
  const afterRes = await httpGetJson(PORT, `/api/characters/${members[0].id}`);
  check(
    '클리어 후 REST 골드가 0 -> goldPerMember로 반영됨(API diff)',
    afterRes.status === 200 && afterRes.body.gold === expectedGoldPerMember,
    { before: beforeRes.body.gold, after: afterRes.body.gold, expected: expectedGoldPerMember }
  );
  check(
    '사냥터 최고존 처치 1회 골드보다 보스 보상이 확실히 큼(GOAL.md 2번)',
    expectedGoldPerMember > balance.huntingZone.tiers[balance.huntingZone.tiers.length - 1].gold,
    { rewardGold: expectedGoldPerMember, huntGold: balance.huntingZone.tiers[balance.huntingZone.tiers.length - 1].gold }
  );

  console.log(`\n결과: PASS ${pass} / FAIL ${fail}`);
  for (const s of sockets) if (s.connected) s.disconnect();
  server.closeAllConnections && server.closeAllConnections();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('테스트 스크립트 오류:', err);
  process.exit(1);
});
