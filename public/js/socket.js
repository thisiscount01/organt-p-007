// Socket.IO 래퍼 — server.js의 WS 이벤트 계약 그대로:
//   emit: room:join{code,characterId} / room:start{code,characterId} / room:dodge{code,characterId}
//   on:   room:joined(snapshot) / room:state(snapshot) / room:tick({tick_seq,bossHp,bossMaxHp,phaseIndex,
//         enrageRemainingSec,members[],telegraph:{active,resolveInMs}}) / room:dodgeResult({characterId,success}) / room:error({error})
// 이벤트 유실 대비: room:tick/room:state는 서버가 스냅샷을 통째로 보내므로 델타 추론을 하지 않는다(GOAL.md 합의).
// 재조회가 필요하면 api.getRoomState(code)로 REST 폴백.
const WS_BASE = (window.__RPG_CONFIG && window.__RPG_CONFIG.apiBase) || undefined;

let socket = null;

export function getSocket() {
  if (!socket) {
    socket = window.io(WS_BASE, { autoConnect: false, transports: ['websocket', 'polling'] });
  }
  return socket;
}

export function connectSocket() {
  const s = getSocket();
  if (!s.connected) s.connect();
  return s;
}
