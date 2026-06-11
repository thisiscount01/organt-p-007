'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Sample Data ───────────────────────────────────────────────────────────────
let SAMPLE_DATA = [];
try {
  const raw = fs.readFileSync(path.join(__dirname, 'data', 'festivals-sample.json'), 'utf-8');
  SAMPLE_DATA = JSON.parse(raw);
  console.log(`[sample] ${SAMPLE_DATA.length}개 로드 완료`);
} catch (e) {
  console.warn('[sample] 샘플 데이터 로드 실패:', e.message);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function isValidYMD(s) {
  return typeof s === 'string' && /^\d{8}$/.test(s);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

function addMonthsToStr(dateStr, months) {
  const y = parseInt(dateStr.slice(0, 4), 10);
  const m = parseInt(dateStr.slice(4, 6), 10) - 1;
  const d = parseInt(dateStr.slice(6, 8), 10);
  const dt = new Date(y, m, d);
  dt.setMonth(dt.getMonth() + months);
  return dt.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * 날짜 범위 필터:
 * 축제가 [startDate, endDate] 구간과 겹치면 포함
 * ( f.startDate <= endDate AND f.endDate >= startDate )
 */
function filterSample(startDate, endDate) {
  return SAMPLE_DATA.filter((f) => {
    const fStart = f.startDate || '';
    const fEnd = f.endDate || fStart;
    if (startDate && fEnd < startDate) return false;
    if (endDate && fStart > endDate) return false;
    return true;
  }).sort((a, b) => (a.startDate < b.startDate ? -1 : 1));
}

function normalizeTourItem(item) {
  const lat = parseFloat(item.mapy);
  const lng = parseFloat(item.mapx);
  return {
    id: String(item.contentid),
    title: (item.title || '이름 없음').trim(),
    startDate: item.eventstartdate || '',
    endDate: item.eventenddate || item.eventstartdate || '',
    lat: Number.isFinite(lat) ? lat : 0,
    lng: Number.isFinite(lng) ? lng : 0,
    region: [(item.addr1 || ''), (item.addr2 || '')]
      .join(' ')
      .trim()
      .split(/\s+/)
      .slice(0, 3)
      .join(' '),
    imageUrl: item.firstimage || item.firstimage2 || '',
    description: item.overview || '',
  };
}

async function fetchTourAPI(startDate, endDate) {
  // node-fetch v2 (CommonJS)
  const fetch = require('node-fetch');
  const key = process.env.TOURAPI_KEY;

  const url = new URL('https://apis.data.go.kr/B551011/KorService1/searchFestival1');
  const params = {
    serviceKey: key,
    numOfRows: '100',
    pageNo: '1',
    MobileOS: 'ETC',
    MobileApp: 'FestivalMap',
    _type: 'json',
    listYN: 'Y',
    arrange: 'A',
    eventStartDate: startDate,
    eventEndDate: endDate,
  };
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString(), { timeout: 8000 });
  if (!res.ok) throw new Error(`TourAPI HTTP ${res.status}`);

  const json = await res.json();

  // API 오류 코드 방어
  const errCode = json?.response?.header?.resultCode;
  if (errCode && errCode !== '0000') {
    throw new Error(`TourAPI resultCode=${errCode}: ${json?.response?.header?.resultMsg}`);
  }

  const items = json?.response?.body?.items?.item;
  if (!items) return [];

  return (Array.isArray(items) ? items : [items])
    .filter((i) => i.mapy && i.mapx && parseFloat(i.mapy) !== 0)
    .map(normalizeTourItem)
    .sort((a, b) => (a.startDate < b.startDate ? -1 : 1));
}

async function fetchTourDetail(id) {
  const fetch = require('node-fetch');
  const key = process.env.TOURAPI_KEY;

  const url = new URL('https://apis.data.go.kr/B551011/KorService1/detailCommon1');
  const params = {
    serviceKey: key,
    MobileOS: 'ETC',
    MobileApp: 'FestivalMap',
    _type: 'json',
    contentId: id,
    contentTypeId: '15',
    defaultYN: 'Y',
    firstImageYN: 'Y',
    overviewYN: 'Y',
    addrinfoYN: 'Y',
    mapinfoYN: 'Y',
  };
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString(), { timeout: 8000 });
  if (!res.ok) throw new Error(`TourAPI detail HTTP ${res.status}`);

  const json = await res.json();
  const raw = json?.response?.body?.items?.item;
  if (!raw) return null;
  return normalizeTourItem(Array.isArray(raw) ? raw[0] : raw);
}

// ── No-cache middleware ───────────────────────────────────────────────────────
function noCache(_req, res, next) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  next();
}

// API routes: no-cache
app.use('/api', noCache);

// ── API Routes ────────────────────────────────────────────────────────────────

/**
 * GET /api/festivals?startDate=YYYYMMDD&endDate=YYYYMMDD
 * 응답: [{id, title, startDate, endDate, lat, lng, region, imageUrl, description}]
 */
app.get('/api/festivals', async (req, res) => {
  let { startDate, endDate } = req.query;

  if (startDate !== undefined && !isValidYMD(startDate)) {
    return res.status(400).json({ error: 'startDate는 YYYYMMDD 형식이어야 합니다' });
  }
  if (endDate !== undefined && !isValidYMD(endDate)) {
    return res.status(400).json({ error: 'endDate는 YYYYMMDD 형식이어야 합니다' });
  }

  const today = todayStr();
  if (!startDate) startDate = today;
  if (!endDate) endDate = addMonthsToStr(today, 3);

  if (endDate < startDate) {
    return res.status(400).json({ error: 'endDate는 startDate 이상이어야 합니다' });
  }

  // TourAPI 실호출
  if (process.env.TOURAPI_KEY) {
    try {
      const data = await fetchTourAPI(startDate, endDate);
      return res.json(data);
    } catch (err) {
      console.error('[TourAPI 오류] 샘플 폴백:', err.message);
      // 폴백 → 아래 샘플 반환
    }
  }

  return res.json(filterSample(startDate, endDate));
});

/**
 * GET /api/festivals/:id
 * 응답: 축제 상세 객체 or 404
 */
app.get('/api/festivals/:id', async (req, res) => {
  const { id } = req.params;

  if (!id || !/^[\w-]{1,50}$/.test(id)) {
    return res.status(400).json({ error: '유효하지 않은 id' });
  }

  // 샘플 데이터 우선 검색
  const sample = SAMPLE_DATA.find((f) => f.id === id);
  if (sample) return res.json(sample);

  // TourAPI 상세 조회
  if (process.env.TOURAPI_KEY) {
    try {
      const detail = await fetchTourDetail(id);
      if (detail) return res.json(detail);
    } catch (err) {
      console.error('[TourAPI detail 오류]', err.message);
    }
  }

  return res.status(404).json({ error: '해당 축제를 찾을 수 없습니다' });
});

// ── Static Files ──────────────────────────────────────────────────────────────
app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders(res) {
      // 정적 파일도 캐시 방지 — "고쳤는데 그대로"를 원천 차단
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
    },
  })
);

// SPA fallback: GET / → public/index.html
app.get('*', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('public/index.html 없음');
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🗺  Festival Map  →  http://localhost:${PORT}`);
  console.log(`   TourAPI: ${process.env.TOURAPI_KEY ? '✅ 실API 모드' : '⚠️  샘플 데이터 폴백'}`);
  console.log(`   샘플 축제: ${SAMPLE_DATA.length}개\n`);
});
