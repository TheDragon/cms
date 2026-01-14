export const config = {
  runtime: "edge",
};

function safeFilename(value: string): string {
  return value.replace(/[\\/:*?"<>|]+/g, "_");
}

function decodeValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export default async function handler(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const urlParam = searchParams.get("source") || searchParams.get("url");
  const nameParam = searchParams.get("name") || "attachment";

  if (!urlParam) {
    return new Response("Missing url parameter.", { status: 400 });
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(urlParam);
  } catch {
    return new Response("Invalid url parameter.", { status: 400 });
  }

  if (!targetUrl.hostname.endsWith(".walrus.space")) {
    return new Response("Blocked host.", { status: 403 });
  }

  const upstream = await fetch(targetUrl.toString());
  if (!upstream.ok || !upstream.body) {
    return new Response(`Upstream error (${upstream.status}).`, { status: upstream.status || 502 });
  }

  const headers = new Headers(upstream.headers);
  const safeName = safeFilename(decodeValue(nameParam)) || "attachment";
  headers.set("Content-Disposition", `attachment; filename="${safeName}"`);
  headers.set("Cache-Control", "no-store");

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}
