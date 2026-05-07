/**
 * Cloudflare Worker — Banner Studio AI Image Proxy v2
 *
 * 支援兩種生成模式：
 *   1. JSON POST  → /v1/images/generations  (純文字 prompt → 圖)
 *   2. FormData POST (multipart) → /v1/images/edits  (商品圖 + prompt → 完整設計圖)
 *
 * 模型：dall-e-3 / gpt-image-1（後者支援 image edits）
 *
 * 部署：到 https://dash.cloudflare.com/ → Workers & Pages → 你的 worker → Edit Code
 *      全選刪除 → 貼這個檔案 → Save and deploy
 *      Settings → Variables → OPENAI_KEY (Secret) 設好你的 sk- key
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function pickSize(w, h, model) {
  const ratio = w / h;
  if (model === 'gpt-image-1') {
    if (ratio >= 1.3) return '1536x1024';
    if (ratio <= 0.75) return '1024x1536';
    return '1024x1024';
  }
  if (ratio >= 1.3) return '1792x1024';
  if (ratio <= 0.75) return '1024x1792';
  return '1024x1024';
}

function normalizeQuality(model, quality) {
  if (model === 'gpt-image-1') {
    if (quality === 'standard') return 'medium';
    if (quality === 'hd') return 'high';
    if (['low', 'medium', 'high', 'auto'].includes(quality)) return quality;
    return 'medium';
  }
  return quality === 'hd' ? 'hd' : 'standard';
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
    if (!env.OPENAI_KEY) return json({ error: '伺服器未設定 OPENAI_KEY' }, 500);

    const contentType = request.headers.get('content-type') || '';

    try {
      // === Mode 1: image edits（multipart with product image）===
      if (contentType.includes('multipart/form-data')) {
        return await handleImageEdit(request, env);
      }
      // === Mode 2: image generation（JSON, text-only）===
      return await handleImageGeneration(request, env);
    } catch (e) {
      return json({ error: 'Worker 內部錯誤', detail: e.message }, 500);
    }
  },
};

/* ========== Mode 1: 完整 AI 設計（image edits） ========== */
async function handleImageEdit(request, env) {
  const formData = await request.formData();
  const prompt = formData.get('prompt');
  const productImage = formData.get('image');
  const model = formData.get('model') || 'gpt-image-1';
  const quality = formData.get('quality') || 'medium';
  const width = parseInt(formData.get('width') || '1536', 10);
  const height = parseInt(formData.get('height') || '1024', 10);

  if (!prompt) return json({ error: 'prompt 必填' }, 400);
  if (!productImage) return json({ error: 'image 必填（請上傳商品圖）' }, 400);

  const size = pickSize(width, height, model);
  const normalizedQuality = normalizeQuality(model, quality);

  const fwdForm = new FormData();
  fwdForm.append('model', model);
  fwdForm.append('prompt', prompt);
  fwdForm.append('image', productImage, 'product.png');
  fwdForm.append('size', size);
  fwdForm.append('quality', normalizedQuality);
  fwdForm.append('n', '1');

  const aiRes = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.OPENAI_KEY}` },
    body: fwdForm,
  });

  if (!aiRes.ok) {
    const errText = await aiRes.text();
    return json({
      error: `OpenAI edits 錯誤 (${aiRes.status})`,
      detail: errText,
      hint: errText.includes('verified')
        ? '此模型需要 Organization Verification。'
        : null,
    }, aiRes.status);
  }

  const data = await aiRes.json();
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) return json({ error: 'OpenAI 沒有回傳圖片', detail: JSON.stringify(data) }, 500);

  return json({
    image: `data:image/png;base64,${b64}`,
    actualSize: size,
    actualQuality: normalizedQuality,
    actualModel: model,
    mode: 'edit',
  });
}

/* ========== Mode 2: 純背景生成（text-to-image） ========== */
async function handleImageGeneration(request, env) {
  let body;
  try { body = await request.json(); }
  catch (e) { return json({ error: 'Invalid JSON body' }, 400); }

  const {
    prompt,
    width = 1792,
    height = 1024,
    quality = 'standard',
    style = 'vivid',
    model = 'dall-e-3',
  } = body;

  if (!prompt || typeof prompt !== 'string') return json({ error: 'prompt 必填' }, 400);

  const size = pickSize(width, height, model);
  const normalizedQuality = normalizeQuality(model, quality);

  const payload = { model, prompt, size, quality: normalizedQuality, n: 1 };
  if (model === 'dall-e-3') {
    payload.style = style;
    payload.response_format = 'b64_json';
  }

  const aiRes = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.OPENAI_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!aiRes.ok) {
    const errText = await aiRes.text();
    return json({
      error: `OpenAI generations 錯誤 (${aiRes.status})`,
      detail: errText,
      hint: errText.includes('verified')
        ? '此模型需要 Organization Verification。'
        : null,
    }, aiRes.status);
  }

  const data = await aiRes.json();
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) return json({ error: 'OpenAI 沒有回傳圖片', detail: JSON.stringify(data) }, 500);

  return json({
    image: `data:image/png;base64,${b64}`,
    actualSize: size,
    actualQuality: normalizedQuality,
    actualModel: model,
    revisedPrompt: data.data?.[0]?.revised_prompt,
    mode: 'generation',
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
