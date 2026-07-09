'use strict';
/**
 * 밸런스 몬테카를로 시뮬레이션 — GDD §9(난이도 케이스표)의 4케이스 + 존재이유테스트B(전사궁수마법사궁수 4인 L1)를
 * 각 n회 반복 실행해 승패/소요시간 분포를 숫자로 출력한다.
 *
 * 보스 전투 판정은 lib/encounter.js(BossEncounter)를 그대로 재사용한다 — server.js의 실제 보스룸과
 * "같은 코드"로 판정하므로, 여기서 나온 승률/시간이 실제 라이브 서버 동작과 어긋날 수 없다
 * (시뮬레이션 따로, 서버 따로 구현했다가 둘이 다른 결론을 내는 게 이런 프로젝트에서 제일 흔한 신뢰붕괴 지점).
 *
 * 실행: node sim/balance-sim.js [n]  (기본 n=500)
 */
const path = require('path');
const fs = require('fs');
const { BossEncounter } = require('../lib/encounter');

const balance = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'balance.json'), 'utf8'));

// GDD §6 재검증 지시: 가상 플레이어는 매 텔레그래프 반응윈도우마다 dodge를 "시도"하되
// 실제 반응 성공률은 80%로 모델링(나머지 20%는 반응 실패 = 그대로 맞음). 100% 완벽 회피를
// 가정하면 저DEF·저레벨도 회피만으로 스탯열세를 상쇄해버려 존재이유B 곡선이 무너질 수 있어
// 일부러 실패율을 넣는다.
const DODGE_REACTION_SUCCESS_RATE = 0.8;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function runOnce(members, rngSeed) {
  const rng = mulberry32(rngSeed);
  const enc = new BossEncounter(balance, members);
  const DT = 1; // 1초 해상도 — 서버 실시간 tick(TICK_MS=1000)과 동일 해상도
  let guardTicks = 0;
  const maxTicks = balance.boss.enrageSeconds + 5;
  while (!enc.finished && guardTicks < maxTicks) {
    const { events } = enc.step(DT, rng);
    for (const ev of events) {
      if (ev.action !== 'telegraph') continue;
      // 텔레그래프가 뜬 이번 윈도우 — 살아있는 멤버 전원이 dodge를 시도하되 80%만 반응 성공.
      // registerDodge에 넘기는 nowElapsedSec은 telegraphAtSec(=지금 enc.elapsedSec)과 같은 값이라
      // 윈도우 진입 즉시 반응한 것으로 취급(쿨다운 2.5s < aoeIntervalSec 최소 4s라 실전에서도 매
      // 윈도우 쿨다운 없이 시도 가능 — 유일한 실패 원인은 반응 성공률 자체).
      for (const m of enc.activeMembers()) {
        if (rng() < DODGE_REACTION_SUCCESS_RATE) {
          enc.registerDodge(m.characterId, enc.elapsedSec);
        }
      }
    }
    guardTicks += 1;
  }
  return {
    win: enc.result === 'clear',
    result: enc.result || 'timeout_guard',
    elapsedSec: enc.elapsedSec,
    survivors: enc.activeMembers().length,
    totalMembers: enc.members.length,
  };
}

function party(spec) {
  // spec: [{class, level}] — enhanceLevel 0(순수 레벨/클래스 성능만으로 검증, 강화는 별도 변수라 섞지 않음)
  return spec.map((s, i) => ({
    characterId: `sim-${i}-${s.class}`,
    className: s.class,
    level: s.level,
    enhanceLevel: 0,
  }));
}

function stats(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const sum = arr.reduce((a, b) => a + b, 0);
  const mean = arr.length ? sum / arr.length : 0;
  const pick = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))];
  return { mean, p50: pick(0.5), p90: pick(0.9), min: sorted[0], max: sorted[sorted.length - 1] };
}

function runCase(label, spec, n) {
  let wins = 0;
  const clearTimes = [];
  const wipeTimes = [];
  const resultCounts = {};
  for (let i = 0; i < n; i++) {
    const members = party(spec);
    const r = runOnce(members, i * 2654435761 + 1); // 케이스별/회차별 결정론적이되 서로 다른 시드
    resultCounts[r.result] = (resultCounts[r.result] || 0) + 1;
    if (r.win) {
      wins++;
      clearTimes.push(r.elapsedSec);
    } else {
      wipeTimes.push(r.elapsedSec);
    }
  }
  const winRate = (wins / n) * 100;
  console.log(`\n=== ${label} (n=${n}) ===`);
  console.log(`  파티: ${spec.map((s) => `${s.class}Lv${s.level}`).join(', ')}`);
  console.log(`  승률: ${winRate.toFixed(1)}% (${wins}/${n})`);
  if (clearTimes.length) {
    const s = stats(clearTimes);
    console.log(
      `  클리어 소요시간(초) — 평균 ${s.mean.toFixed(1)} / p50 ${s.p50.toFixed(1)} / p90 ${s.p90.toFixed(1)} / 최소 ${s.min.toFixed(1)} / 최대 ${s.max.toFixed(1)}`
    );
  }
  if (wipeTimes.length) {
    const s = stats(wipeTimes);
    console.log(
      `  실패까지 걸린시간(초, 광폭화=${balance.boss.enrageSeconds}s) — 평균 ${s.mean.toFixed(1)} / p50 ${s.p50.toFixed(1)}`
    );
  }
  console.log(`  결과분포: ${JSON.stringify(resultCounts)}`);
  return { label, winRate, wins, n, meanClearSec: clearTimes.length ? stats(clearTimes).mean : null };
}

function main() {
  const n = parseInt(process.argv[2], 10) || 500;
  console.log(`레이드 RPG 밸런스 시뮬레이션 — boss.hp=${balance.boss.hp}, enrageSeconds=${balance.boss.enrageSeconds}, targetClearSeconds=${balance.boss.targetClearSeconds}`);
  console.log(`반복 횟수 n=${n} (케이스당)`);

  const results = [];

  // ---- GDD §9 난이도 케이스표 4종 ----
  results.push(
    runCase('①최약체 — 전사 4인 Lv6', [
      { class: 'warrior', level: 6 },
      { class: 'warrior', level: 6 },
      { class: 'warrior', level: 6 },
      { class: 'warrior', level: 6 },
    ], n)
  );
  results.push(
    runCase('②최속 — 마법사 4인 Lv6', [
      { class: 'mage', level: 6 },
      { class: 'mage', level: 6 },
      { class: 'mage', level: 6 },
      { class: 'mage', level: 6 },
    ], n)
  );
  results.push(
    runCase('③2인 Lv10 러시(궁수+마법사)', [
      { class: 'archer', level: 10 },
      { class: 'mage', level: 10 },
    ], n)
  );
  results.push(
    runCase('④솔로 Lv6(마법사, 최고 DPS 단일클래스로 최선의 경우 가정)', [{ class: 'mage', level: 6 }], n)
  );

  // ---- 존재이유 테스트 A: 솔로는 이론상 DPS로도 못 이긴다(방 상태머신 자체는 minToStart=2로 별도 차단) ----
  console.log(
    `\n[존재이유 테스트 A] 솔로 DPS 승률 = ${results[3].winRate.toFixed(1)}% → 0%에 근접해야 함(보스룸 상태머신도 minToStart=${balance.bossRoom.minToStart}로 1인 LOCKED 전이 자체를 별도 차단).`
  );

  // ---- 존재이유 테스트 B: 레벨1 초기스탯 파티 vs 목표 파밍레벨대(5~8) 파티 ----
  const lv1 = runCase('⑤존재이유B-1 — 전사궁수마법사궁수 4인 Lv1(초기스탯)', [
    { class: 'warrior', level: 1 },
    { class: 'archer', level: 1 },
    { class: 'mage', level: 1 },
    { class: 'archer', level: 1 },
  ], n);
  const lv5 = runCase('⑥존재이유B-2 — 전사궁수마법사궁수 4인 Lv5(파밍 하한)', [
    { class: 'warrior', level: 5 },
    { class: 'archer', level: 5 },
    { class: 'mage', level: 5 },
    { class: 'archer', level: 5 },
  ], n);
  const lv8 = runCase('⑦존재이유B-3 — 전사궁수마법사궁수 4인 Lv8(파밍 상한)', [
    { class: 'warrior', level: 8 },
    { class: 'archer', level: 8 },
    { class: 'mage', level: 8 },
    { class: 'archer', level: 8 },
  ], n);

  console.log(
    `\n[존재이유 테스트 B] Lv1 승률 ${lv1.winRate.toFixed(1)}% → Lv5 승률 ${lv5.winRate.toFixed(1)}% → Lv8 승률 ${lv8.winRate.toFixed(1)}% : ${
      lv1.winRate < 20 && lv5.winRate > 60 ? 'PASS(경계 실존 확인)' : 'REVIEW(경계가 뚜렷하지 않음 — balance.json 재조정 검토 필요)'
    }`
  );

  const summary = {
    generatedAt: new Date().toISOString(),
    n,
    boss: { hp: balance.boss.hp, enrageSeconds: balance.boss.enrageSeconds, targetClearSeconds: balance.boss.targetClearSeconds },
    cases: results.map((r) => ({ label: r.label, winRate: r.winRate, meanClearSec: r.meanClearSec })),
    existenceTestB: {
      lv1WinRate: lv1.winRate,
      lv5WinRate: lv5.winRate,
      lv8WinRate: lv8.winRate,
    },
  };
  fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify(summary, null, 2));
  console.log('\n결과 요약을 sim/results.json에 저장했습니다.');
}

main();
