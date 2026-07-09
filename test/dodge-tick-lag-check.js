'use strict';
/**
 * 회귀 테스트 — "두 시계(sim vs 벽시계) 어긋남" 버그 재현(QA 제안 시나리오).
 *
 * 버그였던 것: lib/rooms.js의 _tick이 BossEncounter.step()에 항상 고정 dt(TICK_MS/1000=1.0)를
 * 넘겼다. 이벤트루프가 동기 작업(예: 무거운 계산)으로 지연되면 setInterval 콜백 호출 간 실제
 * 간격이 1초를 넘어도 enc.elapsedSec은 여전히 +1.0만 증가 — sim시계가 벽시계보다 뒤처진다.
 * 그런데 registerDodge 판정의 nowElapsedSec은 rooms.js가 room.combatStartedAt 기준 별도
 * Date.now() 벽시계로 계산해 넘겼으므로, 두 시계가 어긋난 채로 비교됨 — 지연이 누적된 뒤에는
 * 플레이어가 텔레그래프를 보자마자(실시간 기준 즉시) dodge를 눌러도 서버가 "윈도우 밖"으로
 * 오판했다(벽시계 nowElapsedSec이 이미 sim시계 기준 windowEndSec을 앞질러 있었으므로).
 *
 * 고친 것: _tick이 이제 dtSec을 고정값이 아니라 마지막 tick 이후 실제 경과시간으로 계산해
 * enc.elapsedSec에 넘긴다(지연을 sim시계가 그대로 흡수) + registerDodge는 항상 enc.elapsedSec을
 * 그대로 쓴다(rooms.js가 별도 벽시계를 계산하지 않음) — 두 시계가 아예 하나로 통일됐다.
 *
 * 검증 범위: 이 버그는 순전히 lib/rooms.js(_tick/registerDodge) + lib/encounter.js(step/
 * registerDodge)의 "시간 계산" 층에 있고 WS 전송 포맷과는 무관하다 — 소유권 검증(ownsCharacter)
 * 등 WS 배선 자체는 test/dodge-ws-check.js가 이미 실 서버(server.js+socket.io)로 검증한다.
 * 여기서는 dodge-check.js와 같은 패턴으로 RoomManager를 직접 구동(실제 setTimeout/setInterval,
 * 실제 Date.now() 사용 — 즉 프로덕션 lib/rooms.js 코드 경로 그대로)하되, io/socket은 실제 통신이
 * 필요 없는 최소 스텁으로 대체해 이 시간원 문제에만 집중한다.
 *
 * 실행(절대경로 fs EACCES 우회 — test/_sandbox-loader.js 표준 부트스트랩):
 *   node -e "
 *     const fs = require('fs');
 *     const code = fs.readFileSync('./test/_sandbox-loader.js', 'utf8');
 *     const mod = { exports: {} };
 *     new Function('module','exports','require','__filename','__dirname', code)(
 *       mod, mod.exports, require, '/test/_sandbox-loader.js', '/test');
 *     mod.exports.run('/test/dodge-tick-lag-check.js');
 *   "
 */
const path = require('path');
const fs = require('fs');
const { RoomManager } = require(path.join(__dirname, '..', 'lib', 'rooms.js'));

// balance.json 원본 그대로 로드 후, 테스트 속도용으로 이 프로세스 안에서만(파일엔 반영 안 함)
// aoeIntervalSec만 앞당긴다 — telegraphSec/slack(반응윈도우 폭)은 GDD 승인치 그대로 둔다.
const balance = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'balance.json'), 'utf8'));
balance.boss.hp = 10_000_000; // 도중에 죽어 종료 이벤트가 섞이지 않도록
balance.boss.enrageSeconds = 300; // 광폭화로 조기 종료되지 않도록
balance.boss.phases[0].aoeIntervalSec = 2; // 첫 telegraph를 앞당겨 테스트 시간을 줄임
balance.bossRoom.reconnectGraceSeconds = 20;

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
  return {
    id: `char-${name}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    class: className,
    level: level || 6,
    enhanceLevel: 0,
  };
}

// 실제 WS 전송이 필요 없는 최소 io/socket 스텁 — RoomManager는 io.to(code).emit(...)과
// io.sockets.sockets.get(prevSocketId)(재접속 시 구소켓 강제종료용)만 쓴다.
function mkFakeIo() {
  const sockets = new Map(); // socketId -> fakeSocket
  return {
    _sockets: sockets,
    to() {
      return { emit() {} };
    },
    sockets: { sockets },
  };
}

let socketSeq = 0;
function mkFakeSocket(io) {
  const socket = {
    id: `fake-socket-${++socketSeq}`,
    join() {},
    disconnect() {
      this.connected = false;
    },
    connected: true,
  };
  io._sockets.set(socket.id, socket);
  return socket;
}

async function waitUntil(fn, timeoutMs, stepMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs || 25));
  }
  return false;
}

// 동기 busy-loop — Node 단일스레드를 durationMs만큼 강제로 점유해 setInterval(TICK_MS) 콜백
// 호출을 지연시킨다(진짜 CPU 부하/느린 동기 작업이 이벤트루프를 막는 상황의 재현).
function busyBlockMs(durationMs) {
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    /* 의도적 spin — 이벤트루프 지연 주입 */
  }
}

async function runTrial(roomManager, io, label, { injectLagMs }) {
  const chars = [
    mkCharacter(`${label}-1`, 'warrior'),
    mkCharacter(`${label}-2`, 'archer'),
    mkCharacter(`${label}-3`, 'mage'),
    mkCharacter(`${label}-4`, 'archer'),
  ];
  const room = roomManager.createRoom(chars[0]);
  const sockets = chars.map(() => mkFakeSocket(io));

  for (let i = 0; i < chars.length; i++) {
    const result = roomManager.joinRoom(io, sockets[i], room.code, chars[i]);
    if (i > 0) check(`[${label}] member ${i + 1} 입장 성공`, result.ok === true, result);
  }

  // 4/4 입장 -> LOCKED -> (3s 후) IN_COMBAT 자동 전이(lib/rooms.js _lockAndSchedule 그대로)
  const reachedCombat = await waitUntil(() => room.state === 'IN_COMBAT', 8000, 50);
  check(`[${label}] 4인 입장 후 IN_COMBAT 전이`, reachedCombat, room.state);

  if (injectLagMs) {
    // IN_COMBAT 진입 직후(첫 telegraph가 뜨기 전) 이벤트루프를 인위적으로 지연시킨다 —
    // 고치기 전 코드라면 이 구간의 tick 콜백들이 실제 경과시간과 무관하게 +1.0씩만 sim시계를
    // 올려, sim시계가 벽시계보다 뒤처지게 만드는 바로 그 지점이다.
    busyBlockMs(injectLagMs);
  }

  const telegraphSeen = await waitUntil(() => room.log.some((e) => e.action === 'telegraph'), 10000, 20);
  check(`[${label}] telegraph 이벤트가 로그에 기록된다`, telegraphSeen, room.log.map((e) => e.action).slice(-5));

  // 텔레그래프 관측 "직후"(폴링 지연 수십ms 이내) 즉시 반응 — 반응윈도우(telegraphSec+slack ≈ 2.7s)
  // 안에서도 한참 여유 있는 타이밍이라 정상이라면 반드시 성공해야 한다.
  const result = roomManager.registerDodge(io, sockets[0], room.code, chars[0].id);
  check(`[${label}] telegraph 직후 즉시 dodge는 반응윈도우 내로 판정되어 성공한다`, result.ok === true && result.success === true, result);

  if (room.interval) clearInterval(room.interval);
  return result.ok === true && result.success === true;
}

async function main() {
  const roomManager = new RoomManager(balance);
  const io = mkFakeIo();

  const baselineOk = await runTrial(roomManager, io, 'baseline(무지연)', { injectLagMs: 0 });
  const laggedOk = await runTrial(roomManager, io, 'lagged(4s 이벤트루프 지연 주입)', { injectLagMs: 4000 });

  check(
    '지연 유무와 무관하게 윈도우 내 dodge 성공률이 동일하게 유지된다(단일 시간원)',
    baselineOk === true && laggedOk === true && baselineOk === laggedOk,
    { baselineOk, laggedOk }
  );

  console.log(`\n결과: PASS ${pass} / FAIL ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('dodge-tick-lag 테스트 오류:', err);
  process.exit(1);
});
