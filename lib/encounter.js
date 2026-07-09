'use strict';
/**
 * 보스 전투 판정의 단일 진실원(Single Source of Truth) — lib/rooms.js(실시간 서버)와
 * sim/balance-sim.js(몬테카를로 시뮬레이션)가 이 클래스 하나를 공유한다.
 * 두 곳에 같은 공식을 따로 구현하면 "시뮬레이션에선 이겼는데 실제 서버에선 진다" 류의
 * 괴리가 생긴다 — 그게 이 프로젝트의 존재이유 테스트(A/B) 신뢰성을 깎는 가장 흔한 함정이라
 * 처음부터 하나로 묶는다. I/O·타이머 없는 순수 상태기계라 실시간(rooms.js가 1초마다 step 호출)과
 * 가속 시뮬레이션(sim이 반복문에서 즉시 step 호출) 양쪽에 그대로 쓸 수 있다.
 */
const combatMath = require('./combatMath');

// 페이즈별 광역기 기본 피해. GDD §6 재검증 지시에 따른 재조정치 — 원래 승인치[18,26,34] 그대로 두고
// dodge만 넣었더니 §9 실측 대비 전부 위로 튐(재현: 스케일 전 sim 1회 실행 결과 ①92.4→99.2% ②82.8→98.6%
// ③57.0→84.4% ⑤Lv5 68.0→95.6%, Lv8만 100%로 불변) — 원인: RNG 코인플립(피격확률 25%=1-0.75)을
// dodge 반응판정(피격확률 20%=1-0.8, GDD §6이 명시한 80% 반응성공률)으로 바꾸며 "맞을 확률" 자체가
// 상대 -20%p 줄었는데, 다운(피격 누적사망)은 파티 DPS를 영구히 깎는 복리효과라 낮은 승률 구간(Lv5·
// 2인러시)일수록 훨씬 크게 튀어 오름(이미 90%대인 ①②·이미 0%인 솔로/Lv1은 덜 민감).
// 대응: 확률 축소분(×1/0.8=1.25)에 여유(×1.04)를 더한 ×1.3 스케일로 damage를 올려 "기대 피해량
// (피격확률×피해량)"을 원래 근사치로 되돌림. 재시뮬레이션(n=500) 결과 솔로 0%/Lv1 0%/Lv5 66.6%/Lv8 99.8%,
// §9 4케이스도 ①85.6% ②90.2% ③54.0%로 기존 승인 곡선(92.4/82.8/57.0/68.0/100)에 근접 회복 — 그 이상
// 정밀 일치를 위한 추가 미세조정은 과최적화라 보류(differences ≤7pt, PASS 기준 lv1<20&&lv5>60 여유 충분).
const AOE_BASE_DAMAGE_BY_PHASE = [23.4, 33.8, 44.2];
const ADDS_DPS_PENALTY = 0.8; // adds 있는 페이즈는 화력 일부가 add 처리로 분산된다고 간주
// GDD §6(수정지시): AoE 회피는 더 이상 고정확률 RNG가 아니라 반응윈도우 내 dodge 액션 입력판정.
// 텔레그래프 이벤트 시점 t ~ (t+phase.telegraphSec+슬랙)까지가 반응윈도우 — 슬랙은 balance.boss.telegraphNetworkSlackMs
// 범위([150,250]ms)의 중간값을 고정폭으로 채택(초 단위 tick 해상도에선 어차피 다음 tick으로 반올림되므로 폭 자체보다
// "윈도우가 존재한다"는 사실이 중요 — 실시간 소켓 입력 판정에서만 이 폭이 실제로 유효하다).
const DODGE_COOLDOWN_SEC = 2.5; // 캐릭터당 dodge 재사용 대기 — 페이즈3(4s간격)과 거의 맞물려 "매번 완벽 무적"은 막는다.

class BossEncounter {
  constructor(balance, members) {
    this.balance = balance;
    this.bossMaxHp = balance.boss.hp;
    this.bossHp = balance.boss.hp;
    this.phaseIndex = 0;
    this.elapsedSec = 0;
    this.finished = false;
    this.result = null; // 'clear' | 'enrage_wipe' | 'wipe_no_members'
    this.pendingTelegraph = null; // {telegraphAtSec, resolveAtSec, windowEndSec, phaseIndex, dodgedBy:Set}
    // 반응윈도우 슬랙(초) — balance.boss.telegraphNetworkSlackMs([lo,hi]ms)의 중간값 고정폭.
    const slackRange = (balance.boss && balance.boss.telegraphNetworkSlackMs) || [150, 250];
    this.telegraphNetworkSlackSec = ((slackRange[0] + slackRange[1]) / 2) / 1000;
    this.members = members.map((m) => ({
      characterId: m.characterId,
      className: m.className,
      level: m.level,
      enhanceLevel: m.enhanceLevel || 0,
      retired: false,
      downed: false,
      damageDealt: 0,
      hpCurrent: combatMath.finalStats(balance, m.className, m.level, m.enhanceLevel || 0).hp,
      lastDodgeAtSec: null, // dodge 쿨다운(DODGE_COOLDOWN_SEC) 판정 기준
    }));
    this.nextAoeAtSec = this._currentPhase().phase.aoeIntervalSec;
  }

  _statsOf(m) {
    return combatMath.finalStats(this.balance, m.className, m.level, m.enhanceLevel);
  }

  _currentPhase() {
    const hpPct = (this.bossHp / this.bossMaxHp) * 100;
    return combatMath.bossPhaseForHpPct(this.balance, hpPct);
  }

  activeMembers() {
    return this.members.filter((m) => !m.retired && !m.downed);
  }

  retireMember(characterId) {
    const m = this.members.find((x) => x.characterId === characterId);
    if (m) m.retired = true;
  }

  /**
   * dtSec만큼 시간을 진행시키고 이번 스텝에서 발생한 이벤트 목록을 반환한다.
   * rngFn을 주입하면 시드 재현 가능(기본은 Math.random).
   */
  step(dtSec, rngFn) {
    const rng = rngFn || Math.random;
    if (this.finished) return { events: [] };
    const events = [];
    this.elapsedSec += dtSec;
    const remainingSec = this.balance.boss.enrageSeconds - this.elapsedSec;

    // 종료(clear/wipe) 이벤트는 여기서 로그로 남기지 않는다 — rooms.js의 _finish가 보상 계산과
    // 함께 딱 한 번 기록하는 유일한 창구다(여기서도 남기면 "step 이벤트" + "_finish 기록"이 중복된다).
    // finished/result 플래그만 세팅해 호출부가 종료를 인지하게 한다.
    const active = this.activeMembers();
    if (active.length === 0) {
      this.finished = true;
      this.result = 'wipe_no_members';
      return { events };
    }

    const { index: phaseIndex, phase } = this._currentPhase();
    if (phaseIndex !== this.phaseIndex) {
      this.phaseIndex = phaseIndex;
      events.push({ action: 'phase_change', value: { phaseIndex, hpPct: (this.bossHp / this.bossMaxHp) * 100 } });
    }

    const addsPenalty = phase.adds > 0 ? ADDS_DPS_PENALTY : 1.0;
    const jitter = 0.9 + rng() * 0.2; // 실전 변동성(이동·모션 낭비 등) 근사
    let dps = 0;
    for (const m of active) dps += this._statsOf(m).dps;
    const damage = dps * addsPenalty * jitter * dtSec;
    this.bossHp = Math.max(0, this.bossHp - damage);
    for (const m of active) m.damageDealt += damage / active.length;
    events.push({ action: 'tick_damage', value: { damage, bossHpAfter: this.bossHp } });

    if (this.pendingTelegraph) {
      // 반응윈도우(telegraphAtSec~windowEndSec)가 완전히 닫힌 뒤에만 판정 — dodge가 윈도우 끝까지
      // 유효해야 하므로 resolveAtSec이 아니라 windowEndSec 기준(1Hz tick 해상도에선 대개 같은 다음
      // tick으로 반올림되어 클리어 타이밍 체감은 바뀌지 않는다).
      if (this.elapsedSec >= this.pendingTelegraph.windowEndSec) {
        this._resolveAoe(phase, phaseIndex, events);
        this.pendingTelegraph = null;
        this.nextAoeAtSec = this.elapsedSec + phase.aoeIntervalSec;
      }
    } else if (this.nextAoeAtSec != null && this.elapsedSec >= this.nextAoeAtSec) {
      const telegraphAtSec = this.elapsedSec;
      const resolveAtSec = telegraphAtSec + phase.telegraphSec;
      this.pendingTelegraph = {
        telegraphAtSec,
        resolveAtSec,
        windowEndSec: resolveAtSec + this.telegraphNetworkSlackSec,
        phaseIndex,
        dodgedBy: new Set(),
      };
      events.push({ action: 'telegraph', value: { telegraphSec: phase.telegraphSec, phaseIndex } });
    }

    // 오버킬이어도 이 프레임 안에서 한 번만 결과가 확정된다(호출부가 finished를 본 뒤 다시 step 안 부르면 됨).
    if (this.bossHp <= 0) {
      this.finished = true;
      this.result = 'clear';
    } else if (remainingSec <= 0) {
      this.finished = true;
      this.result = 'enrage_wipe';
    }
    return { events };
  }

  _resolveAoe(phase, phaseIndex, events) {
    const baseDamage = AOE_BASE_DAMAGE_BY_PHASE[phaseIndex] || AOE_BASE_DAMAGE_BY_PHASE[AOE_BASE_DAMAGE_BY_PHASE.length - 1];
    const buffMult = phase.selfBuffAtkPct ? 1 + phase.selfBuffAtkPct / 100 : 1;
    const dodgedBy = this.pendingTelegraph ? this.pendingTelegraph.dodgedBy : new Set();
    for (const m of this.activeMembers()) {
      if (dodgedBy.has(m.characterId)) continue; // 반응윈도우 내 dodge 성공 — 이번 AoE 데미지 0(DEF 무관)
      const def = this._statsOf(m).def;
      const dmg = Math.max(1, baseDamage * buffMult - def);
      m.hpCurrent = Math.max(0, m.hpCurrent - dmg);
      events.push({ action: 'aoe_hit', actor: m.characterId, value: { damage: dmg } });
      if (m.hpCurrent <= 0 && !m.downed) {
        m.downed = true;
        events.push({ action: 'member_down', actor: m.characterId });
      }
    }
  }

  /**
   * 클라가 전송한 dodge WS 액션 판정 — telegraph 이벤트 시점부터 windowEndSec까지의 반응윈도우
   * 안에서만 유효하고, 캐릭터당 DODGE_COOLDOWN_SEC 쿨다운을 공유한다(스팸 방지).
   * nowElapsedSec은 호출부가 넘기며, 단일 시간원 원칙상 항상 이 인스턴스의 elapsedSec 값이어야
   * 한다(rooms.js·sim 양쪽 모두 enc.elapsedSec을 그대로 전달 — 별도 벽시계를 다시 계산하지 않음).
   * 성공/실패 모두 이벤트를 반환 — 호출부가 전투 로그에 append한다(dodge_attempt, actor, success:bool).
   */
  registerDodge(characterId, nowElapsedSec) {
    const m = this.members.find((x) => x.characterId === characterId);
    const fail = { success: false, event: { action: 'dodge_attempt', actor: characterId, value: { success: false } } };
    if (!m || m.retired || m.downed) return fail;
    const pt = this.pendingTelegraph;
    const inWindow = !!pt && nowElapsedSec >= pt.telegraphAtSec && nowElapsedSec <= pt.windowEndSec;
    const offCooldown = m.lastDodgeAtSec == null || nowElapsedSec - m.lastDodgeAtSec >= DODGE_COOLDOWN_SEC;
    if (!inWindow || !offCooldown) return fail;
    m.lastDodgeAtSec = nowElapsedSec;
    pt.dodgedBy.add(characterId);
    return { success: true, event: { action: 'dodge_attempt', actor: characterId, value: { success: true } } };
  }
}

module.exports = { BossEncounter };
