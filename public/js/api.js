// REST 래퍼 — 서버 응답 스키마는 server.js를 직접 읽고 curl로 왕복 확인한 실제 형태를 그대로 따름
// (publicCharacter: id/name/class/level/exp/expToNext/gold/enhanceLevel/inventory/stats{hp,def,dps}/downedUntil/createdAt).
// 기본은 same-origin(빈 문자열) — production(Render 단일 서비스)에서는 API_BASE 설정이 필요 없다.
// 로컬 검증 중에만 window.__RPG_CONFIG.apiBase로 dev-server 프록시를 가리키게 오버라이드 가능.
const API_BASE = (window.__RPG_CONFIG && window.__RPG_CONFIG.apiBase) || '';

class ApiError extends Error {
  constructor(status, data) {
    super((data && data.error) || `http_${status}`);
    this.status = status;
    this.data = data || {};
  }
}

async function req(method, path, body) {
  const res = await fetch(API_BASE + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    // 204 등 바디 없는 응답
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const api = {
  createCharacter: (name, className) => req('POST', '/api/characters', { name, class: className }),
  getCharacter: (id) => req('GET', `/api/characters/${id}`),
  getInventory: (id) => req('GET', `/api/characters/${id}/inventory`),
  hunt: (id) => req('POST', `/api/characters/${id}/hunt`),
  enhance: (id) => req('POST', `/api/characters/${id}/enhance`),
  createRoom: (characterId) => req('POST', '/api/rooms', { characterId }),
  getRoomState: (code) => req('GET', `/api/rooms/${encodeURIComponent(code)}/state`),
  getRoomLog: (code) => req('GET', `/api/rooms/${encodeURIComponent(code)}/log`),
};

export { ApiError };
