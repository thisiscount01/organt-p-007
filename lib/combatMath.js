'use strict';
/**
 * 순수 계산 함수 모음 — balance.json 수치를 서버(server.js)와 시뮬레이션(sim/balance-sim.js)이
 * 동일 코드로 공유한다(공식이 두 곳에서 따로 구현되어 어긋나는 걸 원천 차단).
 * 이 파일은 I/O가 전혀 없다(순수 함수) — 테스트·시뮬레이션에서 그대로 재사용 가능.
 */

function classBaseStats(balance, className, level) {
  const c = balance.classes[className];
  if (!c) throw new Error(`unknown class: ${className}`);
  const lv = Math.max(1, Math.floor(level));
  return {
    hp: c.baseHP + c.hpGrowth * (lv - 1),
    def: c.baseDEF + c.defGrowth * (lv - 1),
    dps: c.effectiveDpsBase + c.effectiveDpsGrowth * (lv - 1),
  };
}

// 강화(enhancement)는 방어구/무기 1개 슬롯 기준 — HP/DEF/DPS에 동일 비율로 곱해
// "장비 강화 = 전반적 전투력 상승"을 체감시킨다(개별 슬롯 분리는 이번 MVP 범위 밖).
function applyEnhancement(balance, stats, enhanceLevel) {
  const lvl = Math.max(0, Math.min(balance.enhancement.maxLevel, enhanceLevel || 0));
  const pct = (balance.enhancement.statBonusPctPerLevel * lvl) / 100;
  return {
    hp: stats.hp * (1 + pct),
    def: stats.def * (1 + pct),
    dps: stats.dps * (1 + pct),
  };
}

function finalStats(balance, className, level, enhanceLevel) {
  return applyEnhancement(balance, classBaseStats(balance, className, level), enhanceLevel);
}

function zoneTierForLevel(balance, level) {
  const tiers = balance.huntingZone.tiers;
  for (const t of tiers) {
    if (level >= t.levelRange[0] && level <= t.levelRange[1]) return t;
  }
  return level < tiers[0].levelRange[0] ? tiers[0] : tiers[tiers.length - 1];
}

function expRequired(balance, level) {
  const key = String(level);
  if (balance.expTable[key] != null) return balance.expTable[key];
  // 테이블 범위(1~9) 밖은 마지막 성장비로 외삽 — 이 밸런스표는 L10 도달까지만 실제 케이스가 있음.
  const keys = Object.keys(balance.expTable).map(Number).sort((a, b) => a - b);
  const lastLevel = keys[keys.length - 1];
  const lastVal = balance.expTable[String(lastLevel)];
  const prevVal = balance.expTable[String(lastLevel - 1)] || lastVal;
  const ratio = prevVal ? lastVal / prevVal : 1.3;
  let val = lastVal;
  for (let lv = lastLevel; lv < level; lv++) val *= ratio;
  return Math.round(val);
}

// 레벨업 처리: 초과 exp를 이월하며 여러 레벨 동시 상승도 지원.
function applyExp(balance, character, gainedExp) {
  let { level, exp } = character;
  exp += gainedExp;
  let leveledUp = false;
  while (exp >= expRequired(balance, level)) {
    exp -= expRequired(balance, level);
    level += 1;
    leveledUp = true;
  }
  return { level, exp, leveledUp };
}

// 보스 페이즈: phases는 hpPct[0](하한) 내림차순으로 정렬돼 있다고 가정.
// hpPct > lo 인 첫 페이즈를 채택(동률 70/40 경계는 "그 이하로 내려간 페이즈"로 귀속).
function bossPhaseForHpPct(balance, hpPct) {
  const phases = balance.boss.phases;
  for (let i = 0; i < phases.length; i++) {
    const lo = phases[i].hpPct[0];
    if (hpPct > lo || i === phases.length - 1) return { index: i, phase: phases[i] };
  }
  return { index: phases.length - 1, phase: phases[phases.length - 1] };
}

module.exports = {
  classBaseStats,
  applyEnhancement,
  finalStats,
  zoneTierForLevel,
  expRequired,
  applyExp,
  bossPhaseForHpPct,
};
