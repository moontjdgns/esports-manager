// 기기 간 이어하기: 이어하기 코드별로 압축된 세이브를 비공개 Blob 저장소에 보관한다.
//  POST /api/save            (본문: gzip 세이브, 헤더 x-meta: 슬롯 정보 JSON) → 새 코드 발급
//  POST /api/save?code=XXX   (헤더 x-base: 마지막으로 맞춘 저장 시각) → 덮어쓰기. 서버 쪽이 더 최신이면 409
//  GET  /api/save?code=XXX&meta=1 → 저장 정보   ·   GET /api/save?code=XXX → gzip 세이브
// 코드 = 32종 문자 10자리(약 10^15가지). 코드를 아는 기기만 읽고 쓸 수 있다.
import { get, put } from '@vercel/blob';

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[A-HJ-NP-Z2-9]{10}$/;
const MAX = 4 * 1024 * 1024;
const ORIGINS = [/^https:\/\/moontjdgns\.github\.io$/, /^https:\/\/esports-manager[a-z0-9-]*\.vercel\.app$/, /^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/, /^http:\/\/192\.168\.\d+\.\d+(:\d+)?$/];

const newCode = () => { const b = crypto.getRandomValues(new Uint8Array(10)); return [...b].map(x => ALPHA[x % 32]).join(''); };
async function readMeta(code) {
  const r = await get(`saves/${code}.json`, { access: 'private', useCache: false }).catch(() => null);
  if (!r || r.statusCode !== 200) return null;
  return JSON.parse(await new Response(r.stream).text());
}
async function body(req) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > MAX) throw Object.assign(new Error('too big'), { status: 413 }); chunks.push(c); }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ORIGINS.some(r => r.test(origin))) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type,x-meta,x-base,x-force');
  res.setHeader('Access-Control-Expose-Headers', 'x-meta');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  const url = new URL(req.url, 'http://x');
  let code = (url.searchParams.get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  try {
    if (req.method === 'GET') {
      if (!CODE_RE.test(code)) return res.status(400).json({ error: '코드 형식이 올바르지 않습니다.' });
      const meta = await readMeta(code);
      if (!meta) return res.status(404).json({ error: '해당 코드의 저장이 없습니다.' });
      if (url.searchParams.get('meta')) return res.status(200).json(meta);
      const r = await get(`saves/${code}.bin`, { access: 'private', useCache: false });
      if (!r || r.statusCode !== 200) return res.status(404).json({ error: '저장 파일이 없습니다.' });
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('x-meta', encodeURIComponent(JSON.stringify(meta)));
      return res.status(200).send(Buffer.from(await new Response(r.stream).arrayBuffer()));
    }
    if (req.method === 'POST') {
      let meta; try { meta = JSON.parse(decodeURIComponent(req.headers['x-meta'] || '')); } catch { return res.status(400).json({ error: '저장 정보가 없습니다.' }); }
      const data = await body(req);
      if (data.length < 20 || data[0] !== 0x1f || data[1] !== 0x8b) return res.status(400).json({ error: '압축된 세이브가 아닙니다.' });
      if (code) {
        if (!CODE_RE.test(code)) return res.status(400).json({ error: '코드 형식이 올바르지 않습니다.' });
        const cur = await readMeta(code);
        if (!cur) return res.status(404).json({ error: '해당 코드의 저장이 없습니다.' });
        const base = Number(req.headers['x-base'] || 0);
        // 다른 기기가 그사이 더 진행해서 올렸으면 덮어쓰지 않는다 (사용자가 고른 경우만 강제)
        if (cur.saved > base && cur.device !== meta.device && req.headers['x-force'] !== '1') return res.status(409).json({ error: 'conflict', remote: cur });
      } else code = newCode();
      const m = { team: String(meta.team || '').slice(0, 40), short: String(meta.short || '').slice(0, 8), color: String(meta.color || '').slice(0, 16), season: Number(meta.season) || 0, week: Number(meta.week) || 0,
        manager: String(meta.manager || '').slice(0, 24), mode: String(meta.mode || '').slice(0, 12), saved: Number(meta.saved) || Date.now(), device: String(meta.device || '').slice(0, 40), deviceName: String(meta.deviceName || '').slice(0, 20), size: data.length };
      await put(`saves/${code}.bin`, data, { access: 'private', allowOverwrite: true, addRandomSuffix: false, contentType: 'application/octet-stream' });
      await put(`saves/${code}.json`, JSON.stringify(m), { access: 'private', allowOverwrite: true, addRandomSuffix: false, contentType: 'application/json' });
      return res.status(200).json({ code, meta: m });
    }
    return res.status(405).json({ error: 'method' });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.status === 413 ? '세이브가 너무 큽니다.' : '서버 오류가 났습니다. 잠시 뒤 다시 시도해 주세요.' });
  }
}
