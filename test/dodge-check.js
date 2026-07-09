'use strict';
/**
 * GDD §6(수정지시) 검증 — AoE 회피가 더 이상 RNG 코인플립이 아니라 반응윈도우 내 dodge 액션
 * 입력판정으로 동작하는지를 lib/encounter.js(BossEncounter) 단위로 직접 확인한다.
 * server.js/lib/rooms.js는 이 클래스를 그대로 감싸기만 하므로(단일 진실원), 여기서 판정 로직
 * 자체가 맞으면 실시간 서버 동작도 같은 판정을 따른다.
 *
 * 실행(절대경로 fs EACCES 우회 — test/_sandbox-loader.js 표준 부트스트랩):
 *   node -e "
 *     const fs = require('fs');
 *     const code = fs.readFileSync('./test/_sandbox-loader.js', 'utf8');
 *     const mod = { exports: {} };
 *     new Function('module','exports','require','__filename','__dirname', code)(
 *       mod, mod.exports, require, '/test/_sandbox-loader.js', '/test');
 *     mod.exports.run('/test/dodge-check.js');
 *   "
 */
const path = require('path');
const { BossEncounter } = require(path.join(__dirname, '..', 'lib', 'encounter.js'));

const balance = {
  classes: { warrior: { baseHP: 120, hpGrowth: 18, baseDEF: 6, defGrowth: 1.0, effectiveDpsBase: 8, effectiveDpsGrowth: 1.4 } },
  enhancement: { maxLevel: 5, costGold: [20, 45, 80, 130, 200], statBonusPctPerLevel: 5, successRate: 1.0 },
  boss: {
    hp: 999999, // 이번 테스트는 dodge 판정만 볼 것 — 보스가 도중에 죽어 페이즈/종료 이벤트가 섞이면 안 됨
    enrageSeconds: 999,
    phases: [{ hpPct: [0, 100], aoeIntervalSec: 5, telegraphSec: 2, adds: 0 }],
    telegraphNetworkSlackMs: [150, 250], // 중간값 200ms -> windowEndSec = telegraphAtSec + 2.2
  },
};

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

function mkMembers(ids) {
  return ids.map((id) => ({ characterId: id, className: 'warrior', level: 6, enhanceLevel: 0 }));
}

function stepUntilTelegraph(enc, guard) {
  // telegraph 이벤트가 뜰 때까지(첫 aoeIntervalSec) 1초씩 진행 — 그 시점의 elapsedSec을 반환.
  for (let i = 0; i < guard; i++) {
    const { events } = enc.step(1, () => 0.5);
    const tg = events.find((e) => e.action === 'telegraph');
    if (tg) return enc.elapsedSec;
  }
  throw new Error('telegraph event did not fire within guard');
}

function stepUntilResolved(enc, guard) {
  for (let i = 0; i < guard; i++) {
    const { events } = enc.step(1, () => 0.5);
    const hit = events.filter((e) => e.action === 'aoe_hit');
    const down = events.filter((e) => e.action === 'member_down');
    if (!enc.pendingTelegraph) return { hits: hit, downs: down };
  }
  throw new Error('telegraph did not resolve within guard');
}

// ---------- 케이스 1: dodge 안 보낸 멤버는 기존 공식대로 맞는다 ----------
{
  const enc = new BossEncounter(balance, mkMembers(['no-dodge']));
  stepUntilTelegraph(enc, 10);
  const { hits } = stepUntilResolved(enc, 10);
  check('dodge 미전송 멤버는 aoe_hit 이벤트로 데미지를 받는다', hits.length === 1 && hits[0].value.damage > 0, hits);
}

// ---------- 케이스 2: 반응윈도우 내 dodge를 보낸 멤버는 이번 AoE 데미지 0 ----------
{
  const enc = new BossEncounter(balance, mkMembers(['dodger']));
  const telegraphAtSec = stepUntilTelegraph(enc, 10);
  const result = enc.registerDodge('dodger', telegraphAtSec); // 윈도우 시작 시점에 즉시 반응
  check('윈도우 내 dodge 판정이 success:true를 반환한다', result.success === true, result);
  check('dodge_attempt 이벤트가 success:true로 생성된다', result.event.action === 'dodge_attempt' && result.event.value.success === true, result.event);
  const { hits, downs } = stepUntilResolved(enc, 10);
  check('dodge 성공 멤버는 aoe_hit 이벤트 자체가 없다(데미지 0)', hits.length === 0, hits);
  check('dodge 성공 멤버는 당연히 다운되지 않는다', downs.length === 0, downs);
}

// ---------- 케이스 3: 윈도우 밖(텔레그래프 뜨기 전)에 보낸 dodge는 무효 ----------
{
  const enc = new BossEncounter(balance, mkMembers(['early']));
  const result = enc.registerDodge('early', -5); // 아직 pendingTelegraph 없음
  check('반응윈도우 밖(텔레그래프 발생 전) dodge는 실패로 판정된다', result.success === false, result);
}

// ---------- 케이스 4: dodge 쿨다운(2.5s) — 같은 시각에 두 번 보내면 두 번째는 실패 ----------
{
  const enc = new BossEncounter(balance, mkMembers(['spammer']));
  const t = stepUntilTelegraph(enc, 10);
  const r1 = enc.registerDodge('spammer', t);
  const r2 = enc.registerDodge('spammer', t); // 쿨다운 0초 경과 상태로 즉시 재시도
  check('첫 dodge는 성공한다', r1.success === true, r1);
  check('쿨다운(2.5s) 내 재시도는 실패한다(스팸 방지)', r2.success === false, r2);
}

// ---------- 케이스 5: 쿨다운이 지난 뒤 다음 텔레그래프에서는 다시 dodge 가능 ----------
{
  const enc = new BossEncounter(balance, mkMembers(['recover']));
  const t1 = stepUntilTelegraph(enc, 10);
  enc.registerDodge('recover', t1);
  stepUntilResolved(enc, 10); // 첫 AoE 소화(회피 성공 처리)
  const t2 = stepUntilTelegraph(enc, 10); // aoeIntervalSec=5s ≫ 쿨다운 2.5s
  const r2 = enc.registerDodge('recover', t2);
  check('쿨다운 경과 후 다음 텔레그래프에서는 다시 dodge에 성공한다', r2.success === true, { t1, t2, r2 });
}

// ---------- 케이스 6: 다운/은퇴한 멤버는 dodge 불가(다른 멤버가 있어 인카운터 자체는 계속 진행) ----------
{
  const enc = new BossEncounter(balance, mkMembers(['retiree', 'survivor']));
  enc.retireMember('retiree');
  stepUntilTelegraph(enc, 10);
  const r = enc.registerDodge('retiree', enc.elapsedSec);
  check('은퇴(retired) 멤버는 dodge 판정 자체가 실패한다', r.success === false, r);
}

console.log(`\n결과: PASS ${pass} / FAIL ${fail}`);
process.exit(fail > 0 ? 1 : 0);
