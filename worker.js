/**
 * Cloudflare Worker — Banner Studio AI Image Proxy
 *
 * 功能：接收前端傳來的 prompt，呼叫 OpenAI DALL-E 3 生成圖片，
 *      回傳 base64 圖片給前端（避免 CORS 與金鑰外洩）。
 *
 * 部署步驟：
 *   1. 到 https://dash.cloudflare.com/ 登入
 *   2. 左側 Workers & Pages → Create → Worker → "Hello World" 範本 → Deploy
 *   3. 部署後點該 Worker → "Edit Code"
 *   4. 把整個檔案內容貼進去，Save & Deploy
 *   5. 回到 Worker 設定頁 → Settings → Variables → Add variable
 *      Name: OPENAI_KEY  /  Value: sk-...（你的 OpenAI key）
 *      勾選 "Encrypt" → Save
 *   6. 複製 Worker 網址（類似 https://banner-ai.your-name.workers.dev）
 *   7. 回到 banner-studio 美編面板貼上該網址
 *
 * 費用：
 *   - Cloudflare Worker：免費版每天 10 萬次請求
 *   - OpenAI DALL-E 3：
 *     - 1024×1024 standard $0.040 / HD $0.080
 *     - 1792×1024 standard $0.080 / HD $0.120
 *     - 1024×1792 standard $0.080 / HD $0.120
 *   - 一張 banner 約 $0.04～$0.12（NT$ 1.3～4 元）
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

// DALL-E 3 只支援這三種尺寸，依照寬高比自動選擇最接近的
function pickDalleSize(w, h) {
  const ratio = w / h;
  if (ratio >= 1.3) return '1792x1024'; // 寬版
  if (ratio <= 0.75) return '1024x1792'; // 高版
  return '1024x1024'; // 方形 / 接近方形
}

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed. Use POST.' }, 405);
    }

    if (!env.OPENAI_KEY) {
      return json({ error: '伺服器未設定 OPENAI_KEY 環境變數' }, 500);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const {
      prompt,
      width = 1792,
      height = 1024,
      quality = 'standard', // 'standard' or 'hd'
      style = 'vivid',       // 'vivid' or 'natural'
      model = 'dall-e-3',
    } = body;

    if (!prompt || typeof prompt !== 'string') {
      return json({ error: 'prompt 欄位必填' }, 400);
    }

    const size = pickDalleSize(width, height);

    try {
      const aiRes = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.OPENAI_KEY}`,
        },
        body: JSON.stringify({
          model,
          prompt,
          size,
          quality,
          style,
          n: 1,
          response_format: 'b64_json',
        }),
      });

      if (!aiRes.ok) {
        const errText = await aiRes.text();
        return json({ error: `OpenAI 回傳錯誤 (${aiRes.status})`, detail: errText }, aiRes.status);
      }

      const data = await aiRes.json();
      const b64 = data.data?.[0]?.b64_json;
      const revisedPrompt = data.data?.[0]?.revised_prompt;

      if (!b64) {
        return json({ error: 'OpenAI 沒有回傳圖片' }, 500);
      }

      return json({
        image: `data:image/png;base64,${b64}`,
        actualSize: size,
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
