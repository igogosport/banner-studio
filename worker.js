/**
 * Cloudflare Worker — Banner Studio AI Image Proxy
 *
 * 支援兩種模型：
 *   - dall-e-3       (預設，無需 verification)
 *   - gpt-image-1    (最強，需 OpenAI Organization Verification)
 *
 * 部署步驟：
 *   1. 到 https://dash.cloudflare.com/ 登入
 *   2. 左側 Workers & Pages → Create → Worker → "Hello World" 範本 → Deploy
 *   3. 部署後點該 Worker → "Edit Code"
 *   4. 把整個檔案內容貼進去，Save & Deploy
 *   5. 回到 Worker 設定頁 → Settings → Variables → Add variable
 *      Name: OPENAI_KEY  /  Type: Secret  /  Value: sk-...（你的 OpenAI key）→ Save
 *   6. 複製 Worker 網址（類似 https://banner-ai.your-name.workers.dev）
 *
 * 費用（每張）：
 *   DALL-E 3:
 *     1024×1024 standard $0.040 / HD $0.080
 *     1792×1024 standard $0.080 / HD $0.120
 *     1024×1792 standard $0.080 / HD $0.120
 *   GPT-Image-1:
 *     1024×1024 low $0.011 / medium $0.042 / high $0.167
 *     1536×1024 low $0.016 / medium $0.063 / high $0.250
 *     1024×1536 low $0.016 / medium $0.063 / high $0.250
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

// 依寬高比挑選最接近的支援尺寸
function pickSize(w, h, model) {
  const ratio = w / h;
  if (model === 'gpt-image-1') {
    if (ratio >= 1.3) return '1536x1024';
    if (ratio <= 0.75) return '1024x1536';
    return '1024x1024';
  }
  // dall-e-3
  if (ratio >= 1.3) return '1792x1024';
  if (ratio <= 0.75) return '1024x1792';
  return '1024x1024';
}

// 把 banner-studio 的 quality 對應到模型支援的值
function normalizeQuality(model, quality) {
  if (model === 'gpt-image-1') {
    // 'standard' → 'medium', 'hd' → 'high', 'low' → 'low'
    if (quality === 'standard') return 'medium';
    if (quality === 'hd') return 'high';
    if (['low', 'medium', 'high', 'auto'].includes(quality)) return quality;
    return 'medium';
  }
  // dall-e-3 only supports 'standard' or 'hd'
  return quality === 'hd' ? 'hd' : 'standard';
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
    if (request.method !== 'POST') return json({ error: 'Method not allowed. Use POST.' }, 405);
    if (!env.OPENAI_KEY) return json({ error: '伺服器未設定 OPENAI_KEY 環境變數' }, 500);

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

    if (!prompt || typeof prompt !== 'string') {
      return json({ error: 'prompt 欄位必填' }, 400);
    }

    const size = pickSize(width, height, model);
    const normalizedQuality = normalizeQuality(model, quality);

    const payload = {
      model,
      prompt,
      size,
      quality: normalizedQuality,
      n: 1,
    };

    // dall-e-3 才有 style 與 response_format 參數
    if (model === 'dall-e-3') {
      payload.style = style;
      payload.response_format = 'b64_json';
    }
    // gpt-image-1 預設就回 b64_json，不能加 response_format

    try {
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
          error: `OpenAI 回傳錯誤 (${aiRes.status})`,
          detail: errText,
          hint: errText.includes('verified')
            ? '此模型需要 Organization Verification。請到 https://platform.openai.com/settings/organization/general 申請驗證。'
            : null,
        }, aiRes.status);
      }

      const data = await aiRes.json();
      const b64 = data.data?.[0]?.b64_json;
      const revisedPrompt = data.data?.[0]?.revised_prompt;

      if (!b64) return json({ error: 'OpenAI 沒有回傳圖片', detail: JSON.stringify(data) }, 500);

      return json({
        image: `data:image/png;base64,${b64}`,
        actualSize: size,
        actualQuality: normalizedQuality,
        actualModel: model,
        revisedPrompt,
      });
    } catch (e) {
      return json({ error: 'Worker 內部錯誤', detail: e.message }, 500);
    }
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
