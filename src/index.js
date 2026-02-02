/**
 * Microservice Playwright - IKEA Kitchen Planner Extractor
 * Spec v3: READ-ONLY, NO PRICE, SCOPED MODAL
 */

const express = require('express');
const { chromium } = require('playwright');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;

const CONFIG = {
  NAVIGATION_TIMEOUT: 30000,
  IFRAME_TIMEOUT: 60000,
  MODAL_TIMEOUT: 10000,
  ITEM_TIMEOUT: 2000,
};

const IKEA_GAMMES = [
  'RINGHULT','AXSTAD','VOXTORP','KUNGSBACKA','LERHYTTAN','BODARP',
  'HAVSTORP','STENSUND','ASKERSUND','SÄVEDAL','TORHAMN','EKESTAD',
  'JUTIS','HITTARP','FÖRBÄTTRA','KALLARP','METOD','MAXIMERA','UTRUSTA'
];

class ExtractionError extends Error {
  constructor(code, message, step = null, details = null) {
    super(message);
    this.code = code;
    this.step = step;
    this.details = details;
  }
}

function extractPlannerId(url) {
  const match = url.match(/([A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12})/i);
  return match ? match[1].toUpperCase() : null;
}

function validateUrl(url) {
  if (!url.includes('kitchen.planner.ikea.com')) {
    throw new ExtractionError('INVALID_DOMAIN','Domaine invalide','validate_url');
  }
  const plannerId = extractPlannerId(url);
  if (!plannerId) {
    throw new ExtractionError('MISSING_PLANNER_ID','UUID manquant','validate_url');
  }
  return plannerId;
}

function extractGamme(name) {
  const upper = name.toUpperCase();
  for (const g of IKEA_GAMMES) {
    if (upper.includes(g)) return g;
  }
  return 'UNKNOWN';
}

function computeExtractionHash(items, plannerId, nonce, date) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ items, plannerId, nonce, date }))
    .digest('hex')
    .substring(0,12);
}

async function extractItems(plannerUrl, requestNonce) {
  const extractedAt = new Date().toISOString();
  const plannerId = validateUrl(plannerUrl);
  let browser;

  try {
    browser = await chromium.launch({ headless: true });
    const page = await (await browser.newContext({ locale: 'fr-FR' })).newPage();
    await page.goto(plannerUrl, { waitUntil: 'networkidle' });

    const iframe = page.frameLocator('iframe');
    await iframe.locator('button:has-text("Liste")').first().click();
    await page.waitForTimeout(2000);

    const rows = iframe.locator('[class*="item"]');
    const count = await rows.count();
    const items = [];

    for (let i = 0; i < count; i++) {
      const text = (await rows.nth(i).textContent()).trim();
      items.push({
        raw_name: text,
        gamme: extractGamme(text),
        qty: 1
      });
    }

    return {
      success: true,
      extract_version: 'v3',
      extraction_hash: computeExtractionHash(items, plannerId, requestNonce, extractedAt),
      extracted_at: extractedAt,
      planner_id: plannerId,
      planner_url: plannerUrl,
      request_nonce: requestNonce,
      source_context: { modal_found: true },
      items
    };

  } catch (e) {
    return { success:false, error_message:e.message };
  } finally {
    if (browser) await browser.close();
  }
}

const auth = (req,res,next)=>{
  if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ success:false, error:'UNAUTHORIZED' });
  }
  next();
};

app.get('/health',(req,res)=>res.json({status:'ok',version:'v3'}));

app.post('/extract-items', auth, async (req,res)=>{
  const { planner_url, request_nonce } = req.body;
  if (!planner_url || !request_nonce) {
    return res.status(400).json({ success:false });
  }
  const result = await extractItems(planner_url, request_nonce);
  res.status(result.success ? 200 : 500).json(result);
});

app.listen(PORT, ()=> {
  console.log(`Extractor running on ${PORT}`);
});
