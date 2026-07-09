'use strict';
/**
 * 영속 계층 — 캐릭터/인벤토리는 재시작에도 살아남아야 하는 데이터라 파일 DB로 내려앉힌다.
 * DATABASE_URL(Postgres 등) 인프라가 이 MVP 배포 대상(Render 단일 Node 서비스, 별도 DB 미프로비저닝)에는
 * 없으므로 항상 파일 기반으로 동작 — DATA_DIR 환경변수로 데이터 루트를 열어둔다(코드는 안 바뀌어도 환경이
 * 바뀌면 경로가 바뀜). DATA_DIR 미설정 시 ./data로 폴백하며, 이 폴백 경로도 기동 확인 완료(README/report 참고).
 *
 * 휘발 데이터(보스룸 HP/타이머/소켓상태)는 이 파일이 아니라 lib/rooms.js의 인메모리 Map에만 존재 —
 * 서버 재시작 시 사라지는 게 의도된 동작(스펙: 보스룸 진행상태는 휘발).
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const CHAR_FILE = path.join(DATA_DIR, 'characters.json');

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadAll() {
  ensureDataDir();
  if (!fs.existsSync(CHAR_FILE)) return {};
  try {
    const raw = fs.readFileSync(CHAR_FILE, 'utf8');
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (err) {
    // 손상된 파일로 서버가 죽으면 안 됨 — 빈 상태로 복구하고 원본은 .bak으로 보존.
    try {
      fs.copyFileSync(CHAR_FILE, `${CHAR_FILE}.bak-${Date.now()}`);
    } catch (_) {
      /* ignore */
    }
    return {};
  }
}

let cache = loadAll();

function persist() {
  ensureDataDir();
  const tmp = `${CHAR_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, CHAR_FILE); // 원자적 교체 — 쓰다 만 파일이 read 되는 걸 방지.
}

function getCharacter(id) {
  return cache[id] || null;
}

function listCharacters() {
  return Object.values(cache);
}

function saveCharacter(character) {
  cache[character.id] = character;
  persist();
  return character;
}

// 캐릭터별 순차 처리 락 — 동시 hunt/enhance 요청이 같은 캐릭터의 exp/gold를
// 동시에 read-modify-write 하면서 서로 덮어쓰는 레이스를 막는다(REST는 여러 커넥션에서 올 수 있음).
const locks = new Map();
function withCharacterLock(id, fn) {
  const prior = locks.get(id) || Promise.resolve();
  const next = prior.then(fn, fn).finally(() => {
    if (locks.get(id) === next) locks.delete(id);
  });
  locks.set(id, next);
  return next;
}

function _resetForTests() {
  cache = {};
}

module.exports = {
  DATA_DIR,
  getCharacter,
  listCharacters,
  saveCharacter,
  withCharacterLock,
  _resetForTests,
};
