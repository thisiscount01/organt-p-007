// Phaser 씬 — 절차적 Canvas 드로잉만 사용(GPU 없는 환경, 스프라이트 자산은 비주얼팀 인도 전까지 임시).
// 캔버스 논리 해상도 1280x720 고정, Scale.FIT + CENTER_BOTH로 어떤 화면에도 레터박스 대응(비주얼팀과 합의).
// 텔레그래프 자체는 캔버스가 아니라 DOM 오버레이(#telegraphOverlay, 전체판정이라 화면 전체 경고가 더 맞음 — 비주얼팀 결정)
// 가 담당하고, 이 씬은 보스/파티 실루엣과 피격 리액션만 그린다.
const BASE_W = 1280;
const BASE_H = 720;

const PARTY_COLORS = [0xe69f00, 0x56b4e9, 0x009e73, 0xcc79a7]; // CSS --party-1..4와 동일(Okabe-Ito)

function baseConfig(parent, sceneClass) {
  return {
    // CANVAS 고정 — 저사양 안드로이드/구형 브라우저는 WebGL 컨텍스트 생성이 불안정한 경우가 있고
    // (headless 검증 환경에서도 WebGL 부재로 검은 화면이 재현됨), 이 프로토타입은 절차적 도형 위주라
    // WebGL 이득이 크지 않다 — 호환성을 우선한다.
    type: window.Phaser.CANVAS,
    parent,
    width: BASE_W,
    height: BASE_H,
    backgroundColor: '#000000',
    scale: {
      mode: window.Phaser.Scale.FIT,
      autoCenter: window.Phaser.Scale.CENTER_BOTH,
    },
    scene: [sceneClass],
  };
}

// ---------------- 사냥터 씬 ----------------
class HuntingScene extends window.Phaser.Scene {
  constructor() {
    super('hunting');
  }
  create() {
    // fillGradientStyle은 WebGL 전용이라 CANVAS 렌더러에서 무동작(headless 검증 중 발견) — 단색 밴드로 대체.
    const g = this.add.graphics();
    g.fillStyle(0x9dc2dd, 1);
    g.fillRect(0, 0, BASE_W, 260);
    g.fillStyle(0xc9c085, 1);
    g.fillRect(0, 260, BASE_W, 160);
    g.fillStyle(0x5c7a3f, 1);
    g.fillRect(0, 420, BASE_W, BASE_H - 420);
    g.fillStyle(0x466030, 1);
    for (let i = 0; i < 8; i++) {
      g.fillEllipse(60 + i * 160, 470 + (i % 3) * 30, 90, 30);
    }
    this.zoneLabel = this.add.text(24, 24, '', { fontFamily: 'sans-serif', fontSize: 22, color: '#2b2a22' }).setDepth(10);

    this.player = this.add.container(360, 520);
    const pBody = this.add.rectangle(0, 0, 46, 90, 0x274b6b).setStrokeStyle(3, 0xf2ede1);
    this.playerBody = pBody;
    this.player.add(pBody);

    this.monster = this.add.container(860, 500);
    const mBody = this.add.triangle(0, 0, 0, -70, -55, 40, 55, 40, 0x5a3d2b).setStrokeStyle(3, 0x2a1c14);
    this.monster.add(mBody);

    this.popupLayer = this.add.container(0, 0).setDepth(20);
  }
  setZoneLabel(text) {
    if (this.zoneLabel) this.zoneLabel.setText(text);
  }
  setClassTint(className) {
    const tint = { warrior: 0x274b6b, archer: 0x3f6b27, mage: 0x5b2b6b }[className] || 0x274b6b;
    if (this.playerBody) this.playerBody.setFillStyle(tint);
  }
  playHunt(outcome) {
    if (!this.player || !this.monster) return;
    const startX = this.player.x;
    this.tweens.add({
      targets: this.player,
      x: startX + 380,
      duration: 220,
      yoyo: true,
      ease: 'Quad.easeInOut',
      onYoyo: () => this._impact(outcome),
    });
  }
  _impact(outcome) {
    this.cameras.main.shake(120, 0.006);
    const ok = outcome === 'kill';
    const color = ok ? '#e8b23d' : '#e2513f';
    const label = ok ? 'HIT!' : '반격!';
    const txt = this.add.text(this.monster.x - 30, this.monster.y - 110, label, {
      fontFamily: 'sans-serif', fontSize: 30, color, fontStyle: 'bold',
    }).setDepth(21);
    this.tweens.add({ targets: txt, y: txt.y - 40, alpha: 0, duration: 700, onComplete: () => txt.destroy() });
    this.monster.setAlpha(0.4);
    this.tweens.add({ targets: this.monster, alpha: 1, duration: 260 });
  }
}

// ---------------- 보스룸 씬 ----------------
class BossScene extends window.Phaser.Scene {
  constructor() {
    super('boss');
    this.memberSprites = new Map();
  }
  create() {
    // fillGradientStyle은 WebGL 전용이라 CANVAS 렌더러에서 무동작(headless 검증 중 발견) — 단색 밴드로 대체.
    const g = this.add.graphics();
    g.fillStyle(0x142633, 1);
    g.fillRect(0, 0, BASE_W, BASE_H / 2);
    g.fillStyle(0x241830, 1);
    g.fillRect(0, BASE_H / 2, BASE_W, BASE_H / 2);
    // 저앵글 역광 실루엣 기둥
    g.fillStyle(0x0b1119, 0.9);
    for (let i = 0; i < 5; i++) g.fillRect(60 + i * 260, 0, 40, BASE_H);
    g.fillStyle(0xffe9b0, 0.06);
    g.fillEllipse(BASE_W / 2, 60, 900, 220);

    this.bossShape = this.add.triangle(BASE_W / 2, 210, 0, -140, -170, 140, 170, 140, 0x2c1830).setStrokeStyle(4, 0xffcf5c);
    this.bossLabel = this.add.text(BASE_W / 2, 210, '', {
      fontFamily: 'sans-serif', fontSize: 16, color: '#ffe9b0',
    }).setOrigin(0.5).setDepth(5);

    this.addsGroup = this.add.container(0, 0);
    this.partyRow = this.add.container(0, BASE_H - 90);
    this.fxLayer = this.add.container(0, 0).setDepth(30);
  }
  setPhase(phaseIndex) {
    if (!this.bossShape) return;
    const colors = [0x2c1830, 0x3a1a24, 0x521418];
    this.bossShape.setFillStyle(colors[phaseIndex] ?? colors[colors.length - 1]);
    this.cameras.main.flash(200, 255, 207, 92);
  }
  setAdds(count) {
    this.addsGroup.removeAll(true);
    for (let i = 0; i < count; i++) {
      const x = BASE_W / 2 - 120 + i * 240;
      const t = this.add.triangle(x, 330, 0, -40, -32, 30, 32, 30, 0x5a2b3a).setStrokeStyle(2, 0xff9b7a);
      this.addsGroup.add(t);
    }
  }
  setMembers(members) {
    this.partyRow.removeAll(true);
    this.memberSprites.clear();
    const n = Math.max(members.length, 1);
    const spacing = Math.min(260, (BASE_W - 160) / n);
    const startX = BASE_W / 2 - (spacing * (n - 1)) / 2;
    members.forEach((m, i) => {
      const x = startX + i * spacing;
      const color = PARTY_COLORS[i % PARTY_COLORS.length];
      const c = this.add.container(x, 40);
      const body = this.add.rectangle(0, 0, 40, 64, color).setStrokeStyle(3, 0xf2ede1);
      const label = this.add.text(0, 42, m.name, { fontFamily: 'sans-serif', fontSize: 13, color: '#f2ede1' }).setOrigin(0.5, 0);
      c.add([body, label]);
      if (!m.connected) c.setAlpha(0.4);
      if (m.downed) body.setFillStyle(0x333333);
      this.partyRow.add(c);
      this.memberSprites.set(m.characterId, { container: c, body });
    });
  }
  flashAoeHit(characterId) {
    const s = this.memberSprites.get(characterId);
    if (!s) return;
    s.body.setFillStyle(0xe2513f);
    this.tweens.add({ targets: s.container, x: s.container.x + 6, duration: 40, yoyo: true, repeat: 3 });
    this.time.delayedCall(260, () => {
      // 원래 파티색으로 복귀는 setMembers 다음 호출 때 자연 복귀(색상 재계산은 상위에서 관리)
    });
  }
  flashDodge(characterId) {
    const s = this.memberSprites.get(characterId);
    if (!s) return;
    // s.container.x/y는 partyRow 기준 로컬좌표라, this.add.text(s.container.x, s.container.y, ...)로
    // 씬 최상위에 바로 추가하면 로컬값을 절대좌표로 오인해 실제 스프라이트(파티열 하단)와 무관하게
    // 캔버스 상단(대략 y=10)에 렌더된다(버그 재현: run 스크린샷으로 확인 — "회피!" 텍스트가 캐릭터
    // 위가 아니라 보스 실루엣 부근에 찍힘). s.container의 자식으로 붙여 그 캐릭터 로컬좌표계를 그대로
    // 물려받게 하면(부모가 partyRow→container로 두 단계 오프셋) 스프라이트 바로 위에 정확히 뜬다.
    const txt = this.add.text(0, -30, '회피!', {
      fontFamily: 'sans-serif', fontSize: 18, color: '#4caf7d', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(31);
    s.container.add(txt);
    this.tweens.add({ targets: txt, y: txt.y - 30, alpha: 0, duration: 600, onComplete: () => txt.destroy() });
  }
}

export function createHuntingGame(parent) {
  const game = new window.Phaser.Game(baseConfig(parent, HuntingScene));
  return {
    game,
    ready: (cb) => game.events.once('ready', () => cb(game.scene.keys.hunting)),
  };
}

export function createBossGame(parent) {
  const game = new window.Phaser.Game(baseConfig(parent, BossScene));
  return {
    game,
    ready: (cb) => game.events.once('ready', () => cb(game.scene.keys.boss)),
  };
}
