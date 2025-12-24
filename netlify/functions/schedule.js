import { getStore } from '@netlify/blobs';

// GET  /.netlify/functions/schedule?key=hb-default  -> 讀取 JSON
// PUT  /.netlify/functions/schedule?key=hb-default  -> 寫入 JSON
// POST /.netlify/functions/schedule?action=share    -> 建立分享短碼
// GET  /.netlify/functions/schedule?code=XXXXXX     -> 讀取分享資料
export default async (req) => {
  const url = new URL(req.url);
  const key = url.searchParams.get('key') || 'hb-default';
  const action = url.searchParams.get('action');
  const code = url.searchParams.get('code');
  const store = getStore('hb-schedule');

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: cors });
  }

  // 讀取分享短碼資料
  if (req.method === 'GET' && code) {
    const data = await store.get(`share-${code}.json`, { type: 'json' });
    if (!data) {
      return new Response(JSON.stringify({ error: '找不到分享資料' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  // 讀取雲端資料
  if (req.method === 'GET') {
    const data = await store.get(`${key}.json`, { type: 'json' });
    return new Response(JSON.stringify(data || {}), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  // 建立分享短碼
  if (req.method === 'POST' && action === 'share') {
    const body = await req.json();
    // 產生 6 字元短碼
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let shareCode = '';
    for (let i = 0; i < 6; i++) {
      shareCode += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    await store.setJSON(`share-${shareCode}.json`, body);
    return new Response(JSON.stringify({ code: shareCode }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  // 儲存雲端資料
  if (req.method === 'PUT') {
    const body = await req.json();
    await store.setJSON(`${key}.json`, body);
    return new Response(null, { status: 204, headers: cors });
  }

  return new Response('Method Not Allowed', { status: 405, headers: cors });
};
