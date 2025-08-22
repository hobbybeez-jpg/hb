import { getStore } from '@netlify/blobs';

// GET  /.netlify/functions/schedule?key=hb-default  -> 讀取 JSON
// PUT  /.netlify/functions/schedule?key=hb-default  -> 寫入 JSON
export default async (req) => {
  const url = new URL(req.url);
  const key = url.searchParams.get('key') || 'hb-default';
  const store = getStore('hb-schedule');

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: cors });
  }

  if (req.method === 'GET') {
    const data = await store.get(`${key}.json`, { type: 'json' });
    return new Response(JSON.stringify(data || {}), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  if (req.method === 'PUT') {
    const body = await req.json();
    await store.setJSON(`${key}.json`, body);
    return new Response(null, { status: 204, headers: cors });
  }

  return new Response('Method Not Allowed', { status: 405, headers: cors });
};
