export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    // Read env values (you already created these in Netlify)
    const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;          // dl2fxh3g6
    const UPLOAD_PRESET = process.env.CLOUDINARY_UPLOAD_PRESET;    // mrp_unsigned

    // Netlify sends body as base64 when multipart/form-data; we’ll rebuild the FormData
    const contentType = event.headers['content-type'] || event.headers['Content-Type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Expected multipart/form-data' }) };
    }

    // Turn the base64 body back into a Blob so we can send it to Cloudinary
    const raw = Buffer.from(event.body || '', 'base64');
    const blob = new Blob([raw], { type: contentType });

    // Build a new multipart request for Cloudinary
    const form = new FormData();
    // IMPORTANT: Cloudinary expects the file field to be called "file"
    // We forward the entire original multipart here:
    //   fetch will split this into parts again, but we still need to provide "file".
    // The simplest trick is to use the original multipart payload as "file".
    form.append('file', blob, 'upload.bin');
    form.append('upload_preset', UPLOAD_PRESET);

    const cloudUrl = `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`;
    const up = await fetch(cloudUrl, { method: 'POST', body: form });
    const data = await up.json();

    if (!up.ok || !data.secure_url) {
      return {
        statusCode: up.status,
        body: JSON.stringify({ error: data.error?.message || 'Upload failed', details: data }),
      };
    }

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true, url: data.secure_url, public_id: data.public_id, bytes: data.bytes }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Server error' }) };
  }
};


