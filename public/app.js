'use strict';

// ── 계절 팔레트 정의 ──────────────────────────────────────────────────────────
const SEASON_PALETTES = {
  spring: {
    label: '🌸 봄',
    primary:    '#C2185B',
    secondary:  '#4CAF50',
    bg:         '#FFF0F5',
    accent:     '#880E4F',
    light:      '#FFD6E7',
    text:       '#880E4F',
    panelBg:    '#FFFAFC',
    marker:     '#D81B60',
    markerDot:  '#F48FB1',
    emoji:      '🌸',
  },
  summer: {
    label: '☀️ 여름',
    primary:    '#0277BD',
    secondary:  '#F9A825',
    bg:         '#E3F2FD',
    accent:     '#01579B',
    light:      '#B3E5FC',
    text:       '#01579B',
    panelBg:    '#F0F9FF',
    marker:     '#E65100',
    markerDot:  '#FFCC80',
    emoji:      '☀️',
  },
  fall: {
    label: '🍂 가을',
    primary:    '#D84315',
    secondary:  '#5D4037',
    bg:         '#FFF8F5',
    accent:     '#BF360C',
    light:      '#FFD4B8',
    text:       '#BF360C',
    panelBg:    '#FFFAF7',
    marker:     '#E64A19',
    markerDot:  '#FFAB91',
    emoji:      '🍂',
  },
  winter: {
    label: '❄️ 겨울',
    primary:    '#1565C0',
    secondary:  '#455A64',
    bg:         '#EEF5FF',
    accent:     '#0D47A1',
    light:      '#BBDEFB',
    text:       '#0D47A1',
    panelBg:    '#F7FAFF',
    marker:     '#1565C0',
    markerDot:  '#90CAF9',
    emoji:      '❄️',
  },
};

const MONTH_TO_SEASON = {
  1:'winter', 2:'winter',
  3:'spring', 4:'spring', 5:'spring',
  6:'summer', 7:'summer', 8:'summer',
  9:'fall',  10:'fall',  11:'fall',
  12:'winter',
};

function getCurrentSeason() {
  return MONTH_TO_SEASON[new Date().getMonth() + 1] || 'summer';
}

function getFestivalSeason(dateStr) {
  const m = parseInt(dateStr.slice(4, 6), 10);
  return MONTH_TO_SEASON[m] || 'summer';
}

let currentSeason;
let currentPalette;

function applySeason(season) {
  currentSeason = season;
  currentPalette = SEASON_PALETTES[season];
  const root = document.documentElement;
  root.style.setProperty('--season-primary',    currentPalette.primary);
  root.style.setProperty('--season-secondary',  currentPalette.secondary);
  root.style.setProperty('--season-bg',         currentPalette.bg);
  root.style.setProperty('--season-accent',     currentPalette.accent);
  root.style.setProperty('--season-light',      currentPalette.light);
  root.style.setProperty('--season-text',       currentPalette.text);
  root.style.setProperty('--season-panel-bg',   currentPalette.panelBg);
  root.style.setProperty('--season-marker',     currentPalette.marker);
  root.style.setProperty('--season-marker-bg',  currentPalette.light);

  document.body.dataset.season = season;
  document.getElementById('seasonBadge').textContent = currentPalette.label;
}

// ── 날짜 유틸 ─────────────────────────────────────────────────────────────────
function fmtDate(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function getDateRange(filter) {
  const now = new Date();
  let start, end;
  if (filter === 'week') {
    const day = now.getDay(); // 0=일
    start = new Date(now);
    start.setDate(now.getDate() - day);
    start.setHours(0, 0, 0, 0);
    end = new Date(start);
    end.setDate(start.getDate() + 6);
  } else if (filter === 'month') {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    end   = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  } else {
    start = new Date(now);
    end   = new Date(now);
    end.setMonth(now.getMonth() + 3);
  }
  return { startDate: fmtDate(start), endDate: fmtDate(end) };
}

function toKR(dateStr) {
  if (!dateStr || dateStr.length < 8) return dateStr || '';
  return `${dateStr.slice(0, 4)}.${dateStr.slice(4, 6)}.${dateStr.slice(6, 8)}`;
}

function toKRRange(s, e) {
  if (!s) return '';
  if (!e || s === e) return toKR(s);
  return `${toKR(s)} ~ ${toKR(e)}`;
}

function toShortRange(s, e) {
  if (!s) return '';
  const fmt = d => `${d.slice(4, 6)}-${d.slice(6, 8)}`;
  if (!e || s === e) return fmt(s);
  // 같은 연도면 연도 생략
  const sy = s.slice(0, 4), ey = e.slice(0, 4);
  if (sy === ey) return `${fmt(s)} ~ ${fmt(e)}`;
  return `${toKR(s)} ~ ${toKR(e)}`;
}

// ── 마커 아이콘 ───────────────────────────────────────────────────────────────
function makeMarkerIcon(season, active = false) {
  const p = SEASON_PALETTES[season] || currentPalette;
  const color  = active ? p.accent   : p.marker;
  const ring   = active ? '#fff'     : 'rgba(255,255,255,0.9)';
  const base   = active ? 38 : 30;
  const height = Math.round(base * 1.38);

  const svg = `<svg width="${base}" height="${height}" viewBox="0 0 30 41"
      xmlns="http://www.w3.org/2000/svg">
    <defs>
      <filter id="sh" x="-30%" y="-10%" width="160%" height="150%">
        <feDropShadow dx="0" dy="2" stdDeviation="2.5" flood-opacity="0.28"/>
      </filter>
    </defs>
    <path d="M15 1C7.268 1 1 7.268 1 15
             c0 5.5 3.2 10.3 7.9 12.7
             L15 40l6.1-12.3C25.8 25.3 29 20.5 29 15
             C29 7.268 22.732 1 15 1z"
          fill="${color}" stroke="#fff" stroke-width="1.8"
          filter="url(#sh)"/>
    <circle cx="15" cy="14" r="6.5" fill="${ring}"/>
  </svg>`;

  return L.divIcon({
    className: 'custom-marker-div',
    html: svg,
    iconSize:   [base, height],
    iconAnchor: [base / 2, height],
    popupAnchor:[0, -height],
  });
}

// ── Leaflet Map ───────────────────────────────────────────────────────────────
let map;
const markerStore = new Map(); // id → { marker, festival, season }
let activeId = null;

function initMap() {
  map = L.map('map', {
    center: [36.5, 127.8],
    zoom: 7,
    zoomControl: true,
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
    maxZoom: 18,
  }).addTo(map);
}

function clearMarkers() {
  markerStore.forEach(({ marker }) => marker.remove());
  markerStore.clear();
  activeId = null;
}

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderMarkers(festivals) {
  clearMarkers();

  festivals.forEach((f) => {
    if (!f.lat || !f.lng || (f.lat === 0 && f.lng === 0)) return;

    const season = getFestivalSeason(f.startDate);
    const icon   = makeMarkerIcon(season, false);
    const marker = L.marker([f.lat, f.lng], { icon, title: f.title });

    const popupHtml = `
      <div class="popup-card">
        <div class="popup-title">${escHtml(f.title)}</div>
        <div class="popup-region">📍 ${escHtml(f.region)}</div>
        <div class="popup-dates">📅 ${toShortRange(f.startDate, f.endDate)}</div>
        <button class="popup-btn" onclick="selectFestival('${escHtml(f.id)}')">상세 보기 →</button>
      </div>`;

    marker.bindPopup(popupHtml, { maxWidth: 240, autoPan: true });

    marker.on('click', () => {
      activateMarker(f.id);
      showDetail(f);
    });

    marker.addTo(map);
    markerStore.set(f.id, { marker, festival: f, season });
  });

  // 지도 핀 개수 표시
  const cnt = markerStore.size;
  document.getElementById('mapPinCount').textContent =
    cnt > 0 ? `📍 ${cnt}개 축제` : '';
}

function activateMarker(id) {
  // 기존 active 해제
  if (activeId && markerStore.has(activeId)) {
    const { marker, season } = markerStore.get(activeId);
    marker.setIcon(makeMarkerIcon(season, false));
  }
  // 새 active 설정
  if (id && markerStore.has(id)) {
    const { marker, season } = markerStore.get(id);
    marker.setIcon(makeMarkerIcon(season, true));
  }
  activeId = id;
}

// ── 사이드 패널: 상세 ─────────────────────────────────────────────────────────
function showDetail(f) {
  const el        = document.getElementById('festivalDetail');
  const img       = document.getElementById('detailImage');
  const ph        = document.getElementById('detailImgPlaceholder');
  const title     = document.getElementById('detailTitle');
  const dates     = document.getElementById('detailDates');
  const region    = document.getElementById('detailRegion');
  const desc      = document.getElementById('detailDesc');
  const tag       = document.getElementById('detailSeasonTag');

  const season    = getFestivalSeason(f.startDate);
  const palette   = SEASON_PALETTES[season];

  // 이미지
  ph.hidden = true;
  img.classList.remove('hidden');
  if (f.imageUrl) {
    img.alt  = f.title;
    img.src  = f.imageUrl;
    img.onerror = () => {
      img.classList.add('hidden');
      ph.textContent = palette.emoji;
      ph.style.background = palette.light;
      ph.hidden = false;
    };
  } else {
    img.classList.add('hidden');
    ph.textContent = palette.emoji;
    ph.style.background = palette.light;
    ph.hidden = false;
  }

  title.textContent  = f.title;
  dates.textContent  = toKRRange(f.startDate, f.endDate);
  region.textContent = f.region;
  desc.textContent   = f.description || '상세 설명이 없습니다.';

  tag.textContent     = palette.label;
  tag.style.background = palette.marker;

  el.hidden = false;

  // 목록 active 하이라이트
  document.querySelectorAll('.festival-list-item').forEach((li) => {
    li.classList.toggle('active', li.dataset.id === f.id);
  });

  // 모바일: 패널 스크롤
  if (window.innerWidth <= 768) {
    document.getElementById('sidePanel')
      .scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function hideDetail() {
  document.getElementById('festivalDetail').hidden = true;
  document.querySelectorAll('.festival-list-item').forEach((li) =>
    li.classList.remove('active')
  );
  activateMarker(null);
}

// 팝업 버튼용 전역 함수
window.selectFestival = function (id) {
  const entry = markerStore.get(id);
  if (!entry) return;
  activateMarker(id);
  showDetail(entry.festival);
  map.setView([entry.festival.lat, entry.festival.lng],
    Math.max(map.getZoom(), 10), { animate: true });
  entry.marker.openPopup();
};

// ── 사이드 패널: 목록 ─────────────────────────────────────────────────────────
let currentFestivals = [];

function renderList(festivals) {
  currentFestivals = festivals;

  const list  = document.getElementById('festivalList');
  const empty = document.getElementById('emptyState');
  const count = document.getElementById('panelCount');

  // 기존 목록 항목 제거 (empty-state 제외)
  list.querySelectorAll('.festival-list-item').forEach((el) => el.remove());

  count.textContent = `${festivals.length}개의 축제`;

  if (festivals.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  festivals.forEach((f) => {
    const season  = getFestivalSeason(f.startDate);
    const palette = SEASON_PALETTES[season];

    const item = document.createElement('div');
    item.className    = 'festival-list-item';
    item.dataset.id   = f.id;
    item.role         = 'listitem';
    item.tabIndex     = 0;
    item.setAttribute('aria-label', f.title);

    item.innerHTML = `
      <div class="item-dot" style="background:${palette.marker}" aria-hidden="true"></div>
      <div class="item-info">
        <div class="item-title">${escHtml(f.title)}</div>
        <div class="item-meta">${toShortRange(f.startDate, f.endDate)} · ${escHtml(f.region)}</div>
      </div>`;

    const onClick = () => {
      activateMarker(f.id);
      showDetail(f);
      const entry = markerStore.get(f.id);
      if (entry) {
        map.setView([f.lat, f.lng], Math.max(map.getZoom(), 10), { animate: true });
        entry.marker.openPopup();
      }
    };

    item.addEventListener('click', onClick);
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
    });

    list.insertBefore(item, empty);
  });
}

// ── 데이터 로딩 ──────────────────────────────────────────────────────────────
let currentFilter = 'three';

function setLoading(on) {
  document.getElementById('loadingOverlay').classList.toggle('hidden', !on);
}

async function loadFestivals(filter) {
  currentFilter = filter;
  const range = getDateRange(filter);

  document.getElementById('panelRange').textContent =
    `${toKR(range.startDate)} ~ ${toKR(range.endDate)}`;

  setLoading(true);
  hideDetail();

  try {
    const url = `/api/festivals?startDate=${range.startDate}&endDate=${range.endDate}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    renderMarkers(data);
    renderList(data);

    // 마커 있으면 지도 바운드 맞춤
    const coords = data.filter((f) => f.lat && f.lng).map((f) => [f.lat, f.lng]);
    if (coords.length > 0) {
      const bounds = L.latLngBounds(coords);
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 11 });
    }
  } catch (err) {
    console.error('[loadFestivals]', err);
    renderMarkers([]);
    renderList([]);
  } finally {
    setLoading(false);
  }
}

// ── 필터 버튼 ─────────────────────────────────────────────────────────────────
function initFilters() {
  document.querySelectorAll('.filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      loadFestivals(btn.dataset.filter);
    });
  });
}

// ── 초기화 ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // 1. 계절 팔레트 적용
  applySeason(getCurrentSeason());

  // 2. 지도 초기화
  initMap();

  // 3. 필터 이벤트
  initFilters();

  // 4. 상세 닫기
  document.getElementById('detailClose').addEventListener('click', hideDetail);

  // 5. 기본 로드 (3개월)
  loadFestivals('three');
});
