import { api, ApiError } from './api.js';
import { getSocket, connectSocket } from './socket.js';
import { createHuntingGame, createBossGame } from './game.js';

const CLASS_LABEL = { warrior: '전사', archer: '궁수', mage: '마법사' };
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const screens = {
  create: $('#screen-create'),
  hunting: $('#screen-hunting'),
  room: $('#screen-room'),
  result: $('#screen-result'),
};

function showScreen(name) {
  for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

function toast(msg, isError) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 3200);
}

// ---------------- 앱 상태 ----------------
const state = {
  characterId: localStorage.getItem('rpg.characterId') || null,
  character: null,
  roomCode: null,
  roomSnapshot: null,
  huntingGame: null,
  huntingScene: null,
  bossGame: null,
  bossScene: null,
  lastMemberHp: new Map(), // characterId -> hpCurrent(직전 tick) — aoe 피격 리액션 감지용
  lastDodgeAt: 0,
  telegraphDeadline: null, // performance.now() 기준 로컬 카운트다운(ms)
  telegraphRaf: null,
  respawnTimer: null,
};

function persistCharacterId(id) {
  state.characterId = id;
  if (id) localStorage.setItem('rpg.characterId', id);
  else localStorage.removeItem('rpg.characterId');
}

function updateTopbar() {
  const c = state.character;
  const wrap = $('#charSummary');
  if (!c) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  $('#csName').textContent = c.name;
  $('#csClass').textContent = CLASS_LABEL[c.class] || c.class;
  $('#csLevel').textContent = `Lv.${c.level}`;
  $('#csGold').textContent = `${c.gold}G`;
}

// ---------------- 1) 캐릭터 생성 ----------------
function isValidNameClient(name) {
  const trimmed = (name || '').trim();
  if (trimmed.length < 1 || trimmed.length > 20) return false;
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  if (trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\')) return false;
  return true;
}

function initCreateScreen() {
  let selectedClass = null;
  const cards = $$('.class-card');
  const submitBtn = $('#createSubmit');
  const nameInput = $('#charName');
  const nameError = $('#nameError');

  function refreshSubmitEnabled() {
    submitBtn.disabled = !(selectedClass && isValidNameClient(nameInput.value));
  }

  cards.forEach((card) => {
    card.addEventListener('click', () => {
      cards.forEach((c) => c.setAttribute('aria-checked', 'false'));
      card.setAttribute('aria-checked', 'true');
      selectedClass = card.dataset.class;
      refreshSubmitEnabled();
    });
    // 키보드 화살표 이동(role=radio 관례)
    card.addEventListener('keydown', (e) => {
      const idx = cards.indexOf(card);
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        cards[(idx + 1) % cards.length].focus();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        cards[(idx - 1 + cards.length) % cards.length].focus();
      }
    });
  });

  nameInput.addEventListener('input', () => {
    const ok = isValidNameClient(nameInput.value) || nameInput.value.length === 0;
    nameError.hidden = ok;
    if (!ok) nameError.textContent = '1~20자, 제어문자와 \\ / .. 는 사용할 수 없습니다.';
    refreshSubmitEnabled();
  });

  $('#createForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!selectedClass || !isValidNameClient(nameInput.value)) return;
    submitBtn.disabled = true;
    submitBtn.textContent = '생성 중…';
    try {
      const character = await api.createCharacter(nameInput.value.trim(), selectedClass);
      persistCharacterId(character.id);
      state.character = character;
      updateTopbar();
      await enterHunting();
    } catch (err) {
      toast(describeApiError(err, '캐릭터 생성 실패'), true);
      submitBtn.disabled = false;
    } finally {
      submitBtn.textContent = '모험 시작';
    }
  });
}

function describeApiError(err, fallback) {
  if (err instanceof ApiError) {
    if (err.data && err.data.detail) return err.data.detail;
    if (err.data && err.data.error) return err.data.error;
  }
  return fallback;
}

// ---------------- 2) 사냥터 ----------------
async function enterHunting() {
  showScreen('hunting');
  if (!state.huntingGame) {
    state.huntingGame = createHuntingGame('huntingScenePane');
    state.huntingGame.ready((scene) => {
      state.huntingScene = scene;
      applyHuntingSceneChrome();
    });
    // Phaser는 create() 이후 곧바로 scene.keys가 채워짐 — ready 콜백이 안 오는 버전 대비 폴백 폴링
    setTimeout(() => {
      if (!state.huntingScene && state.huntingGame.game.scene.keys.hunting) {
        state.huntingScene = state.huntingGame.game.scene.keys.hunting;
        applyHuntingSceneChrome();
      }
    }, 300);
  } else {
    applyHuntingSceneChrome();
  }
  await refreshCharacter();
}

function applyHuntingSceneChrome() {
  if (!state.huntingScene || !state.character) return;
  state.huntingScene.setClassTint(state.character.class);
  const tier = zoneTierLabel(state.character.level);
  state.huntingScene.setZoneLabel(tier);
  $('#huntZoneLabel').textContent = `(${tier})`;
}

function zoneTierLabel(level) {
  if (level <= 2) return '1~2존';
  if (level <= 4) return '3~4존';
  if (level <= 6) return '5~6존';
  return '7~8존';
}

async function refreshCharacter() {
  if (!state.characterId) return;
  try {
    const c = await api.getCharacter(state.characterId);
    state.character = c;
    updateTopbar();
    renderHuntingStats(c);
    applyHuntingSceneChrome();
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      // 로컬에 남은 캐릭터ID가 서버 데이터와 어긋남(예: 다른 DATA_DIR) — 새로 만들게 초기화
      persistCharacterId(null);
      state.character = null;
      updateTopbar();
      showScreen('create');
      toast('저장된 캐릭터를 찾을 수 없어 새로 만듭니다.', true);
      return;
    }
    toast(describeApiError(err, '캐릭터 정보를 불러오지 못했습니다'), true);
  }
}

function renderHuntingStats(c) {
  $('#stLevel').textContent = c.level;
  $('#stExp').textContent = `${c.exp} / ${c.expToNext}`;
  $('#stHp').textContent = c.stats.hp;
  $('#stDef').textContent = c.stats.def;
  $('#stDps').textContent = c.stats.dps;
  $('#stGold').textContent = c.gold;
  $('#stEnhance').textContent = `+${c.enhanceLevel}`;
  const pct = c.expToNext ? Math.min(100, Math.round((c.exp / c.expToNext) * 100)) : 0;
  $('#expBarFill').style.width = `${pct}%`;
  $('.exp-bar').setAttribute('aria-valuenow', String(pct));

  const huntBtn = $('#huntBtn');
  const now = Date.now();
  if (c.downedUntil && c.downedUntil > now) {
    startRespawnCountdown(c.downedUntil);
  } else {
    huntBtn.disabled = false;
    huntBtn.textContent = '사냥하기 (H)';
  }
}

function startRespawnCountdown(downedUntil) {
  const huntBtn = $('#huntBtn');
  huntBtn.disabled = true;
  clearInterval(state.respawnTimer);
  const tick = () => {
    const remain = Math.max(0, downedUntil - Date.now());
    if (remain <= 0) {
      clearInterval(state.respawnTimer);
      huntBtn.disabled = false;
      huntBtn.textContent = '사냥하기 (H)';
      $('#huntStatus').textContent = '리스폰 완료 — 다시 사냥할 수 있습니다.';
      return;
    }
    huntBtn.textContent = `리스폰까지 ${Math.ceil(remain / 1000)}s`;
  };
  tick();
  state.respawnTimer = setInterval(tick, 250);
}

async function doHunt() {
  const huntBtn = $('#huntBtn');
  const statusEl = $('#huntStatus');
  huntBtn.disabled = true;
  try {
    const result = await api.hunt(state.characterId);
    state.character = result.character;
    updateTopbar();
    renderHuntingStats(result.character);
    if (state.huntingScene) state.huntingScene.playHunt(result.outcome);

    if (result.outcome === 'died') {
      statusEl.textContent = `몬스터의 반격에 쓰러졌습니다 — ${Math.ceil(result.respawnInMs / 1000)}초 뒤 리스폰.`;
    } else {
      const parts = [`+${result.expGained} EXP`, `+${result.goldGained}G`];
      if (result.drop) parts.push(`전리품: ${result.drop.name}`);
      if (result.leveledUp) parts.push(`레벨업! Lv.${result.oldLevel}→Lv.${result.newLevel}`);
      statusEl.textContent = parts.join(' · ');
      if (result.leveledUp) toast(`레벨업! Lv.${result.newLevel}`);
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 429) {
      statusEl.textContent = `너무 빠릅니다 — ${Math.ceil(err.data.retryInMs / 1000)}초 뒤 다시 시도하세요.`;
      huntBtn.disabled = false;
    } else if (err instanceof ApiError && err.status === 409) {
      statusEl.textContent = '아직 쓰러진 상태입니다.';
      renderHuntingStats(await api.getCharacter(state.characterId));
    } else {
      toast(describeApiError(err, '사냥에 실패했습니다'), true);
      huntBtn.disabled = false;
    }
  }
}

async function doEnhance() {
  const statusEl = $('#enhanceStatus');
  try {
    const result = await api.enhance(state.characterId);
    state.character = result.character;
    updateTopbar();
    renderHuntingStats(result.character);
    statusEl.textContent = `강화 성공 — 현재 +${result.newEnhanceLevel}`;
    toast(`강화 +${result.newEnhanceLevel} 성공`);
  } catch (err) {
    if (err instanceof ApiError && err.data && err.data.error === 'insufficient_gold') {
      statusEl.textContent = `골드 부족 — 필요 ${err.data.need}G (보유 ${err.data.have}G)`;
    } else if (err instanceof ApiError && err.data && err.data.error === 'max_enhance_level') {
      statusEl.textContent = '이미 최대 강화 단계입니다.';
    } else {
      statusEl.textContent = describeApiError(err, '강화에 실패했습니다');
    }
  }
}

// ---------------- 3) 보스룸 ----------------
async function doCreateRoom() {
  const statusEl = $('#roomActionStatus');
  try {
    const snap = await api.createRoom(state.characterId);
    joinRoomFlow(snap.code);
  } catch (err) {
    statusEl.textContent = describeApiError(err, '방 생성 실패');
  }
}

function doJoinRoomFromInput() {
  const code = $('#joinCode').value.trim().toUpperCase();
  if (!code) return;
  joinRoomFlow(code);
}

function joinRoomFlow(code) {
  state.roomCode = code;
  const socket = connectSocket();
  wireSocketOnce(socket);
  socket.emit('room:join', { code, characterId: state.characterId });
  showScreen('room');
  $('#roomCodeLabel').textContent = `#${code}`;
  $('#combatArea').hidden = true;
  $('#lobbyControls').hidden = false;
}

let socketWired = false;
function wireSocketOnce(socket) {
  if (socketWired) return;
  socketWired = true;

  socket.on('connect_error', () => toast('서버 연결에 실패했습니다 — 재시도 중…', true));
  socket.on('room:error', (payload) => {
    toast(`방 오류: ${payload.error}`, true);
  });
  socket.on('room:joined', (snap) => applyRoomSnapshot(snap));
  socket.on('room:state', (snap) => applyRoomSnapshot(snap));
  socket.on('room:tick', (tick) => applyRoomTick(tick));
  socket.on('room:dodgeResult', (payload) => {
    // payload.characterId = 서버가 브로드캐스트에 실어 보낸 "누가" 회피했는지(server.js 참고) —
    // 본인 소켓도 socket.emit(본인)+socket.to(나머지)로 동일 payload를 받으므로 본인/타인 구분 없이
    // 항상 payload.characterId로 대상을 특정해야 한다. state.characterId(본인 고정값)로 대체하면
    // 타인의 회피 성공이 항상 내 캐릭터 위치에 플래시되는 버그가 난다.
    const isSelf = payload.characterId === state.characterId;
    if (isSelf) {
      const el = $('#dodgeFeedback');
      el.textContent = payload.success ? '회피 성공!' : '회피 실패(윈도우/쿨다운 확인)';
      el.className = `dodge-feedback ${payload.success ? 'success' : 'fail'}`;
    }
    if (payload.success && state.bossScene) state.bossScene.flashDodge(payload.characterId);
  });
}

function applyRoomSnapshot(snap) {
  state.roomSnapshot = snap;
  const banner = $('#roomStateBanner');
  banner.dataset.state = snap.state;

  const stateLabel = {
    FORMING: '파티 결성 중 — 인원을 기다립니다',
    LOCKED: '정원 도달 — 곧 전투가 시작됩니다',
    IN_COMBAT: '전투 중!',
    RESULT: '전투 종료',
  }[snap.state] || snap.state;
  banner.textContent = `${stateLabel} (${snap.members.length}/${snap.capacity})`;

  renderMemberList(snap);

  const isHost = snap.hostCharacterId === state.characterId;
  $('#minToStartLabel').textContent = snap.minToStart;
  $('#lobbyControls').hidden = snap.state !== 'FORMING';
  $('#startCombatBtn').hidden = !isHost;
  $('#startCombatBtn').disabled = snap.members.length < snap.minToStart;
  if (!isHost) {
    $('#lobbyStatus').textContent = '호스트가 시작하기를 기다리는 중입니다.';
  } else if (snap.members.length < snap.minToStart) {
    $('#lobbyStatus').textContent = `최소 ${snap.minToStart}명이 필요합니다(현재 ${snap.members.length}명). 혼자서는 시작할 수 없습니다.`;
  } else {
    $('#lobbyStatus').textContent = '준비되면 전투를 시작하세요.';
  }

  if (snap.state === 'IN_COMBAT') {
    ensureBossGame();
    $('#combatArea').hidden = false;
    $('#lobbyControls').hidden = true;
    $('#bossHpText').textContent = `${Math.round((snap.bossHp / snap.bossMaxHp) * 100)}%`;
    $('#bossHpFill').style.width = `${Math.round((snap.bossHp / snap.bossMaxHp) * 100)}%`;
    $('#phaseLabel').textContent = `페이즈 ${snap.phaseIndex + 1}`;
  }

  if (snap.state === 'RESULT') {
    stopTelegraphCountdown();
    showResultScreen(snap);
  }
}

function renderMemberList(snap) {
  const ul = $('#memberList');
  ul.innerHTML = '';
  snap.members.forEach((m, i) => {
    const li = document.createElement('li');
    li.dataset.slot = String((i % 4) + 1);
    const hpPct = m.hpCurrent != null && state.character ? null : null; // 서버가 최대HP를 안 주므로 절대치만 표시(스켈레톤 범위)
    let statusTag = '';
    if (m.retired) statusTag = '<span class="member-status-tag retired">이탈</span>';
    else if (m.downed) statusTag = '<span class="member-status-tag downed">다운</span>';
    else if (!m.connected) statusTag = `<span class="member-status-tag grace">재접속 대기 ${m.reconnectRemainingSec ?? ''}s</span>`;
    else statusTag = '<span class="member-status-tag connected">참여 중</span>';

    li.innerHTML = `
      <span class="member-name">${escapeHtml(m.name)} ${m.characterId === state.characterId ? '(나)' : ''}</span>
      <span class="member-meta">${CLASS_LABEL[m.class] || m.class} · Lv.${m.level}${m.hpCurrent != null ? ` · HP ${Math.round(m.hpCurrent)}` : ''}</span>
      ${statusTag}
    `;
    ul.appendChild(li);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function ensureBossGame() {
  if (state.bossGame) return;
  state.bossGame = createBossGame('bossScenePane');
  const settle = () => {
    state.bossScene = state.bossGame.game.scene.keys.boss;
    if (state.roomSnapshot) state.bossScene.setMembers(state.roomSnapshot.members);
  };
  state.bossGame.ready(settle);
  setTimeout(() => {
    if (!state.bossScene && state.bossGame.game.scene.keys.boss) settle();
  }, 300);
}

function applyRoomTick(tick) {
  $('#bossHpText').textContent = `${Math.round((tick.bossHp / tick.bossMaxHp) * 100)}%`;
  $('#bossHpFill').style.width = `${Math.round((tick.bossHp / tick.bossMaxHp) * 100)}%`;
  const prevPhase = state.roomSnapshot ? state.roomSnapshot.phaseIndex : 0;
  $('#phaseLabel').textContent = `페이즈 ${tick.phaseIndex + 1}`;
  if (state.bossScene && tick.phaseIndex !== prevPhase) {
    state.bossScene.setPhase(tick.phaseIndex);
    state.bossScene.setAdds(tick.phaseIndex === 1 ? 2 : 0); // GDD: P2에서만 adds 2기
  }

  const enrageEl = $('#enrageTimer');
  const mm = Math.floor(tick.enrageRemainingSec / 60);
  const ss = String(tick.enrageRemainingSec % 60).padStart(2, '0');
  enrageEl.textContent = `광폭화까지 ${mm}:${ss}`;
  enrageEl.classList.toggle('urgent', tick.enrageRemainingSec <= 20);

  renderMemberList({ ...state.roomSnapshot, members: tick.members });
  if (state.bossScene) {
    state.bossScene.setMembers(tick.members);
    for (const m of tick.members) {
      const prevHp = state.lastMemberHp.get(m.characterId);
      if (prevHp != null && m.hpCurrent != null && m.hpCurrent < prevHp) {
        state.bossScene.flashAoeHit(m.characterId);
      }
      if (m.hpCurrent != null) state.lastMemberHp.set(m.characterId, m.hpCurrent);
    }
  }

  state.roomSnapshot = { ...state.roomSnapshot, ...tick };

  const dodgeBtn = $('#dodgeBtn');
  if (tick.telegraph && tick.telegraph.active) {
    startTelegraphCountdown(tick.telegraph.resolveInMs, tick.phaseIndex);
    dodgeBtn.disabled = false;
  } else {
    stopTelegraphCountdown();
  }
}

// 텔레그래프 카운트다운 — room:tick의 resolveInMs를 받은 시점 기준 로컬 보간(비주얼팀과 합의된 방식,
// 별도 서버값 폴링 불필요). rAF로 매 프레임 남은 ms를 다시 계산해 배너/오버레이에 반영.
function startTelegraphCountdown(resolveInMs, phaseIndex) {
  state.telegraphDeadline = performance.now() + resolveInMs;
  const overlay = $('#telegraphOverlay');
  const banner = $('#telegraphBanner');
  const danger = phaseIndex >= 2 ? 'high' : 'low';
  overlay.dataset.danger = danger;
  banner.dataset.danger = danger;
  overlay.hidden = false;
  banner.hidden = false;
  overlay.classList.add('active');

  function step() {
    const remain = Math.max(0, state.telegraphDeadline - performance.now());
    $('#telegraphCountdown').textContent = `회피! ${(remain / 1000).toFixed(1)}s`;
    if (remain > 0) {
      state.telegraphRaf = requestAnimationFrame(step);
    }
  }
  cancelAnimationFrame(state.telegraphRaf);
  step();
}

function stopTelegraphCountdown() {
  cancelAnimationFrame(state.telegraphRaf);
  state.telegraphRaf = null;
  state.telegraphDeadline = null;
  $('#telegraphOverlay').hidden = true;
  $('#telegraphOverlay').classList.remove('active');
  $('#telegraphBanner').hidden = true;
}

function attemptDodge() {
  if (!state.roomCode || !state.characterId) return;
  const now = performance.now();
  if (now - state.lastDodgeAt < 2500) {
    const el = $('#dodgeFeedback');
    el.textContent = `쿨다운 ${((2500 - (now - state.lastDodgeAt)) / 1000).toFixed(1)}s`;
    el.className = 'dodge-feedback fail';
    return;
  }
  state.lastDodgeAt = now;
  const socket = getSocket();
  socket.emit('room:dodge', { code: state.roomCode, characterId: state.characterId });
}

function showResultScreen(snap) {
  showScreen('result');
  const title = $('#resultTitle');
  const body = $('#resultBody');
  if (snap.result === 'clear') {
    title.textContent = '보스 처치!';
    const reward = snap.reward || {};
    const won = reward.gearWinnerCharacterId === state.characterId;
    body.textContent = `승리했습니다. 파티원 전원에게 ${reward.goldPerMember || 0}G 지급${won ? ' + 보스 장비 획득!' : ''} (사냥터로 돌아가면 골드가 반영되는지 확인하세요 — 서버 보상 지급 로직은 백엔드 확인 필요).`;
  } else if (snap.result === 'enrage_wipe') {
    title.textContent = '전멸 — 광폭화 시간 초과';
    body.textContent = '광폭화 타이머 내 보스를 처치하지 못했습니다. 더 성장한 뒤(레벨업/강화) 다시 도전하세요.';
  } else {
    title.textContent = '전멸';
    body.textContent = '파티 전원이 다운되었습니다. 다시 도전할 수 있습니다.';
  }
}

// ---------------- 화면 전환/이벤트 바인딩 ----------------
function bindEvents() {
  $('#huntBtn').addEventListener('click', doHunt);
  $('#enhanceBtn').addEventListener('click', doEnhance);
  $('#createRoomBtn').addEventListener('click', doCreateRoom);
  $('#joinRoomBtn').addEventListener('click', doJoinRoomFromInput);
  $('#joinCode').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doJoinRoomFromInput();
  });
  $('#startCombatBtn').addEventListener('click', () => {
    getSocket().emit('room:start', { code: state.roomCode, characterId: state.characterId });
  });
  $('#dodgeBtn').addEventListener('click', attemptDodge);
  $('#retryBtn').addEventListener('click', () => {
    state.roomCode = null;
    state.roomSnapshot = null;
    showScreen('hunting');
    doCreateRoom();
  });
  $('#backToHuntBtn').addEventListener('click', async () => {
    state.roomCode = null;
    showScreen('hunting');
    await refreshCharacter();
  });

  document.addEventListener('keydown', (e) => {
    if (!screens.hunting.hidden && (e.key === 'h' || e.key === 'H') && !$('#huntBtn').disabled) {
      doHunt();
    }
    if (!screens.room.hidden && !$('#combatArea').hidden && (e.code === 'Space' || e.key === 'd' || e.key === 'D')) {
      e.preventDefault();
      attemptDodge();
    }
  });
}

// ---------------- 부트 ----------------
async function boot() {
  initCreateScreen();
  bindEvents();
  if (state.characterId) {
    try {
      await enterHunting();
    } catch (_) {
      showScreen('create');
    }
  } else {
    showScreen('create');
  }
}

boot();
