'use strict';
/**
 * room:dodge WS 왕복 자체(소켓 이벤트 파싱 → RoomManager.registerDodge → 로그 append → ack emit)를
 * 실제 서버 인스턴스+socket.io-client로 검증. lib/encounter.js 단위테스트(test/dodge-check.js)는
 * 판정 로직만 보고, 이건 "그 로직이 서버 배선을 타고 실제로 클라까지 왕복하는가"를 본다.
 * boss.hp/enrageSeconds를 낮게 패치해 IN_COMBAT까지 빨리 도달시킨다(server.js의 balance는 require
 * 캐시로 공유되므로 이 파일 안에서만 임시로 낮춘다 — 원본 balance.json은 안 건드림).
 *
 * 실행(절대경로 fs EACCES 우회 — test/_sandbox-loader.js 표준 부트스트랩):
 *   node -e "
 *     const fs = require('fs');
 *     const code = fs.readFileSync('./test/_sandbox-loader.js', 'utf8');
 *     const mod = { exports: {} };
 *     new Function('module','exports','require','__filename','__dirname', code)(
 *       mod, mod.exports, require, '/test/_sandbox-loader.js', '/test');
 *     mod.exports.run('/test/dodge-ws-check.js');
 *   "
 */
const path = require('path');
const { io: ioClient } = require('socket.io-client');

const mod = require(path.join(__dirname, '..', 'server.js'));
const { server, roomManager, balance } = mod;
const store = require(path.join(__dirname, '..', 'lib', 'store.js'));

balance.boss.enrageSeconds = 300; // 테스트 도중 광폭화로 끝나버리면 dodge 검증을 못 하니 넉넉히
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
  const PORT = 3902;
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`dodge-ws test server listening on :${PORT}`);

  const chars = [mkCharacter('d1', 'warrior'), mkCharacter('d2', 'archer'), mkCharacter('d3', 'mage'), mkCharacter('d4', 'archer')];
  const room = roomManager.createRoom(chars[0]);
  const sockets = chars.map(() => connectClient(PORT));
  await Promise.all(sockets.map((s) => waitFor(s, 'connect')));

  for (let i = 0; i < chars.length; i++) {
    sockets[i].emit('room:join', { code: room.code, characterId: chars[i].id });
    await waitFor(sockets[i], 'room:joined');
  }
  // 4/4 입장 완료 -> LOCKED -> (3s 후) IN_COMBAT 자동 전이
  await new Promise((resolve) => setTimeout(resolve, 3500));
  check('4인 입장 후 IN_COMBAT 전이', room.state === 'IN_COMBAT', room.state);

  // 첫 telegraph 이벤트가 로그에 뜰 때까지 대기(최대 10초 폴링)
  let telegraphSeen = false;
  for (let i = 0; i < 20 && !telegraphSeen; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    telegraphSeen = room.log.some((e) => e.action === 'telegraph');
  }
  check('전투 로그에 telegraph 이벤트가 기록된다', telegraphSeen, room.log.map((e) => e.action).slice(-5));

  // 첫 캐릭터(d1)가 dodge 액션을 전송 — 반응윈도우 안이므로 성공해야 함.
  // Redo 요청 3(협동 피드백 갭): 본인(sockets[0])에게 오는 즉시 ack뿐 아니라 같은 방 파티원
  // (sockets[1..3])에게도 room:dodgeResult가 브로드캐스트돼야 "여러 명이 함께 도전"이 서로에게
  // 보인다 — 리스너를 발신 *전에* 걸어 레이스 없이 4명 전원의 수신을 동시에 기다린다.
  const ackPromise = waitFor(sockets[0], 'room:dodgeResult');
  const teammateBroadcastPromises = [1, 2, 3].map((i) => waitFor(sockets[i], 'room:dodgeResult'));
  sockets[0].emit('room:dodge', { code: room.code, characterId: chars[0].id });
  const [ack, ...teammateBroadcasts] = await Promise.all([ackPromise, ...teammateBroadcastPromises]);
  check('room:dodgeResult ack가 success:true로 돌아온다', ack.success === true, ack);
  check('본인 ack payload에 누가 회피했는지(characterId)가 담긴다', ack.characterId === chars[0].id, ack);
  check(
    '파티원 3명(sockets[1..3]) 전원이 room:dodgeResult 브로드캐스트를 받는다(협동 피드백)',
    teammateBroadcasts.every((p) => p.characterId === chars[0].id && p.success === true),
    teammateBroadcasts
  );

  // 서버 전투 로그에 dodge_attempt(actor=chars[0].id, success:true)가 append됐는지 확인.
  const dodgeEvents = room.log.filter((e) => e.action === 'dodge_attempt' && e.actor === chars[0].id);
  check('전투 로그에 dodge_attempt(success:true) 이벤트가 남는다', dodgeEvents.length >= 1 && dodgeEvents[dodgeEvents.length - 1].value.success === true, dodgeEvents);

  // 존재하지 않는 방/캐릭터로 dodge를 보내면 room:error가 와야 함(방어적 케이스).
  const errPromise = waitFor(sockets[1], 'room:error');
  sockets[1].emit('room:dodge', { code: 'ZZZZZZ', characterId: chars[1].id });
  const err = await errPromise;
  check('존재하지 않는 방 코드로 dodge 보내면 room:error를 받는다', err.error === 'room_not_found', err);

  // ---- 소유권 검증(Redo 요청 1) ----
  // sockets[1]은 chars[1] 소유 소켓 — 그 소켓으로 chars[2]의 characterId를 실어 dodge를 보내면
  // (파티원이 남의 캐릭터 몫을 대신 처리하려는 시도) not_your_character로 거부되어야 한다.
  const impersonateErrPromise = waitFor(sockets[1], 'room:error');
  sockets[1].emit('room:dodge', { code: room.code, characterId: chars[2].id });
  const impersonateErr = await impersonateErrPromise;
  check(
    '타인 characterId로 온 room:dodge는 not_your_character로 거부된다',
    impersonateErr.error === 'not_your_character',
    impersonateErr
  );
  // chars[2] 본인 소켓은 여전히 정상 동작해야 한다(과잉차단 아님을 확인).
  const legitAckPromise = waitFor(sockets[2], 'room:dodgeResult');
  sockets[2].emit('room:dodge', { code: room.code, characterId: chars[2].id });
  const legitAck = await legitAckPromise;
  check('본인 characterId로 온 room:dodge는 정상 처리된다(과잉차단 아님)', typeof legitAck.success === 'boolean', legitAck);

  // ---- 재접속 레이스 검증(Redo 요청 2) ----
  // chars[0]이 새 소켓으로 재접속(room:join)하면 캐릭터ID→소켓 1:1 강제로 구소켓(sockets[0])은
  // 즉시 소유권을 잃어야 한다 — 구소켓이 그 직후(지연) 보낸 dodge는 무효(에러 또는 이미 끊김)여야
  // "재접속 유예 구간에서 구/신 소켓이 동시에 같은 characterId를 대표하는 창"이 없음이 증명된다.
  const staleSocket = sockets[0];
  staleSocket.io.opts.reconnection = false; // 강제종료 후 자동재접속으로 새 소켓id를 만들어 판정을 흐리지 않게 고정
  // _bindSocket이 room:join 핸들러 "안에서" 동기적으로 staleSocket.disconnect(true)를 호출하므로,
  // disconnect 이벤트가 room:joined 응답보다 먼저 fire할 수 있다 — 리스너를 트리거(freshSocket의
  // room:join) 전에 먼저 걸어둬야 그 레이스를 테스트 자신이 놓치지 않는다.
  const staleResultPromise = new Promise((resolve) => {
    staleSocket.once('room:error', (e) => resolve({ error: e.error }));
    staleSocket.once('disconnect', () => resolve({ disconnected: true }));
  });
  const freshSocket = connectClient(PORT);
  await waitFor(freshSocket, 'connect');
  freshSocket.emit('room:join', { code: room.code, characterId: chars[0].id });
  await waitFor(freshSocket, 'room:joined'); // 이 시점에 characterSocket map은 이미 freshSocket으로 갱신됨
  // 구소켓이 이 시점까지 아직 살아있다면(디스커넥트가 아직 안 fire했다면) 지연 dodge를 직접 보내
  // 그마저도 거부되는지까지 확인한다 — 이미 끊겼다면 위 프라미스가 disconnect로 이미 resolve된 상태.
  if (staleSocket.connected) {
    staleSocket.emit('room:dodge', { code: room.code, characterId: chars[0].id });
  }
  const staleResult = await staleResultPromise;
  check(
    '재접속으로 소유권이 넘어간 구소켓의 지연 dodge는 무효화된다(not_your_character 또는 이미 끊김)',
    staleResult.error === 'not_your_character' || staleResult.disconnected === true,
    staleResult
  );
  // 새 소켓은 정상적으로 chars[0] 몫의 dodge를 처리할 수 있어야 한다(소유권이 진짜로 넘어갔는지 재확인).
  const freshAckPromise = waitFor(freshSocket, 'room:dodgeResult');
  freshSocket.emit('room:dodge', { code: room.code, characterId: chars[0].id });
  const freshAck = await freshAckPromise;
  check('재접속한 신규 소켓은 정상적으로 dodge를 처리할 수 있다', typeof freshAck.success === 'boolean', freshAck);

  console.log(`\n결과: PASS ${pass} / FAIL ${fail}`);
  sockets[0] = freshSocket; // cleanup 루프가 최신 소켓을 정리하도록 교체
  for (const s of sockets) if (s.connected) s.disconnect();
  if (staleSocket.connected) staleSocket.disconnect();
  server.closeAllConnections && server.closeAllConnections();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('dodge-ws 테스트 오류:', err);
  process.exit(1);
});
