
// netlify/functions/upload-image.mjs
// Simple upload handler without fileFrom / undici

export default async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "content-type": "application/json" },
    });
  }

  let form;
  try {
    form = await req.formData(); // multipart/form-data support in Netlify (Node 18)
  } catch (e) {
    return new Response(
      JSON.stringify({ error: "Failed to parse form data", details: String(e) }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }

  const file = form.get("file");
  if (!file || typeof file.arrayBuffer !== "function") {
    return new Response(
      JSON.stringify({ error: 'No file field named "file" found' }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  // Sanity-check response. Once this is good, we’ll push to Shopify.
  return new Response(
    JSON.stringify({
      ok: true,
      name: file.name || "upload",
      size: buffer.length,
      type: file.type || "application/octet-stream",
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
};
