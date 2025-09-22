// netlify/functions/upload-image.mjs
// Simple upload handler using req.formData() (Node 18+). No undici/fileFrom.

export default async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("", { status: 204, headers: cors() });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const form = await req.formData(); // Netlify’s Node 18 supports this
    const file = form.get("file");

    if (!file || typeof file.arrayBuffer !== "function") {
      return json({ error: "No file found in form field 'file'" }, 400);
    }

    const buf = Buffer.from(await file.arrayBuffer());

    // TODO: upload `buf` to Shopify Admin if desired. For now we just echo back.
    return json({
      ok: true,
      name: file.name,
      size: buf.length,
      type: file.type,
    });
  } catch (e) {
    return json(
      { error: "Failed to parse form data", details: String(e) },
      400
    );
  }
};

/* helpers */
function cors(extra = {}) {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    ...extra,
  };
}
function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors(extraHeaders) },
  });
}
