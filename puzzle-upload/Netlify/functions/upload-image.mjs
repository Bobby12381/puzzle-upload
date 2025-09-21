import { fileFrom } from "undici";
import busboy from "busboy";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---- helpers ----
const SAFE_IMAGE_MIME = (mt) => {
  if (!mt) return "image/jpeg";
  mt = String(mt).toLowerCase();
  if (!mt.startsWith("image/")) return "image/jpeg";
  if (mt.includes("heic") || mt.includes("heif")) return "image/jpeg";
  if (mt.includes("webp")) return "image/webp";
  if (mt.includes("png")) return "image/png";
  if (mt.includes("gif")) return "image/gif";
  if (mt.includes("bmp")) return "image/bmp";
  if (mt.includes("tif")) return "image/tiff";
  return "image/jpeg";
};

const SAFE_FILENAME = (name, fallbackExt = ".jpg") => {
  if (!name) name = "upload" + fallbackExt;
  name = name.split("/").pop().split("\\").pop();
  const m = name.match(/\.([a-z0-9]{2,5})$/i);
  let ext = m ? "." + m[1].toLowerCase() : fallbackExt;
  if ([".heic", ".heif", ".heifs"].includes(ext)) ext = ".jpg";
  let base = name.replace(/\.[a-z0-9]{2,5}$/i, "");
  base = base.replace(/[^a-z0-9\-_.]+/gi, "-").replace(/-+/g, "-").replace(/^[-_.]+|[-_.]+$/g, "");
  if (!base) base = "upload";
  if (base.length > 80) base = base.slice(0, 80);
  return `${base}${ext}`;
};

const GQL = async (store, token, query, variables = {}) => {
  const res = await fetch(`https://${store}/admin/api/2024-07/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token
    },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    throw new Error((json.errors && JSON.stringify(json.errors)) || `GraphQL HTTP ${res.status}`);
  }
  return json.data;
};

const STAGED_UPLOADS_CREATE = `
  mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets { url resourceUrl parameters { name value } }
      userErrors { field message }
    }
  }
`;

const FILES_CREATE = `
  mutation filesCreate($files: [FileCreateInput!]!) {
    filesCreate(files: $files) {
      files {
        __typename
        ... on MediaImage { id image { url } }
        ... on GenericFile { id url }
      }
      userErrors { field message }
    }
  }
`;

// ---- CORS ----
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}

// ---- multipart parser for Netlify events ----
function parseMultipart(event) {
  return new Promise((resolve, reject) => {
    const bb = busboy({ headers: event.headers });
    const tmpdir = os.tmpdir();
    let filepath = "", filename = "", mimetype = "", size = 0;

    bb.on("file", (name, file, info) => {
      ({ filename, mimeType: mimetype } = info);
      const saveTo = path.join(tmpdir, `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      filepath = saveTo;
      const out = fs.createWriteStream(saveTo);
      file.on("data", (d) => { size += d.length; });
      file.pipe(out);
    });
    bb.on("finish", () => resolve({ filepath, filename, mimetype, size }));
    bb.on("error", reject);

    const buf = Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8");
    bb.end(buf);
  });
}

// ---- function handler ----
export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders() };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders(), body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const store = process.env.SHOPIFY_STORE;       // e.g. your-store.myshopify.com
  const token = process.env.SHOPIFY_ADMIN_TOKEN; // Admin API token with write_files
  if (!store || !token) {
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: "Missing Shopify env vars" }) };
  }

  try {
    const { filepath, filename, mimetype, size } = await parseMultipart(event);
    if (!filepath) throw new Error("No file uploaded");

    const mimeType = SAFE_IMAGE_MIME(mimetype);
    const safeName = SAFE_FILENAME(filename, ".jpg");
    const fileSize = String(size || 0);

    // 1) staged upload target
    const staged = await GQL(store, token, STAGED_UPLOADS_CREATE, {
      input: [{ resource: "IMAGE", filename: safeName, mimeType, httpMethod: "POST", fileSize }]
    });
    const target = staged.stagedUploadsCreate.stagedTargets?.[0];
    const err1 = staged.stagedUploadsCreate.userErrors?.[0];
    if (!target || err1) throw new Error(err1?.message || "Failed stagedUploadsCreate");

    // 2) upload to staged target
    const fd = new FormData();
    for (const p of target.parameters) fd.append(p.name, p.value);
    fd.append("file", await fileFrom(filepath, safeName, { type: mimeType }));
    const upRes = await fetch(target.url, { method: "POST", body: fd });
    if (!upRes.ok) {
      const txt = await upRes.text().catch(() => "");
      throw new Error(`Staged upload failed: ${upRes.status} ${txt}`);
    }

    // 3) finalize in Shopify Files
    const created = await GQL(store, token, FILES_CREATE, {
      files: [{ originalSource: target.resourceUrl, contentType: "IMAGE", alt: safeName, fileName: safeName }]
    });
    const err2 = created.filesCreate.userErrors?.[0];
    if (err2) throw new Error(err2.message);

    const node = created.filesCreate.files?.[0];
    const url =
      (node?.__typename === "MediaImage" && node.image?.url) ||
      (node?.__typename === "GenericFile" && node.url) || null;
    if (!url) throw new Error("No URL on created file");

    try { fs.unlinkSync(filepath); } catch {}

    return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ url, id: node.id, filename: safeName, mimeType }) };
  } catch (e) {
    const msg = /did not match the expected pattern/i.test(String(e.message))
      ? "Shopify rejected the upload data format (likely MIME/filename). Try JPG/PNG and a simple filename."
      : e.message || "Upload failed";
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: msg }) };
  }
}
