import { getStore } from "@netlify/blobs";

export default async (request) => {
  const url = new URL(request.url);
  const key = url.searchParams.get("key") || "hb-default";
  const store = getStore("hb-schedule");

  if (request.method === "GET") {
    const data = await store.get(key, { type: "json" });
    return new Response(JSON.stringify(data || {}), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
    });
  }

  if (request.method === "PUT") {
    const body = await request.json();
    await store.set(key, body);
    return new Response("", { status: 204 });
  }

  return new Response("Method Not Allowed", { status: 405 });
};
