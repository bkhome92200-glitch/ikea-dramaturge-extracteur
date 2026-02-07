import express from "express";
import crypto from "crypto";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// IMPORTANT: sur Railway, mets bien API_KEY dans Variables
const API_KEY = process.env.API_KEY || "";

// Optionnel (si tu veux Browserless plus tard)
const BROWSERLESS_API_KEY = process.env.BROWSERLESS_API_KEY || "";
const BROWSERLESS_URL = process.env.BROWSERLESS_URL || "https://production-sfo.browserless.io";

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function ok(res, payload) {
  res.status(200).json(payload);
}

function bad(res, status, payload) {
  res.status(status).json(payload);
}

function extractPlannerId(url) {
  const uuidPattern = /([A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12})/i;
  const match = String(url || "").match(uuidPattern);
  return match ? match[1].toUpperCase() : null;
}

function computeHash(items, plannerId, nonce, extractedAt) {
  const payload = JSON.stringify({
    items: items.map((i) => ({
      raw_name: i.raw_name,
      article_number: i.article_number,
      qty: i.qty,
    })),
    planner_id: plannerId,
    request_nonce: nonce,
    extracted_at: extractedAt,
  });

  return crypto.createHash("sha256").update(payload).digest("hex").substring(0, 12);
}

function parseItemsFromText(text) {
  // Cherche des numéros d’article IKEA type 123.456.78 ou 123-456-78
  const articlePattern = /(\d{3})[.\-](\d{3})[.\-](\d{2})/g;

  const items = [];
  const seen = new Set();

  let m;
  while ((m = articlePattern.exec(text)) !== null) {
    const art = `${m[1]}.${m[2]}.${m[3]}`;
    if (seen.has(art)) continue;
    seen.add(art);

    // On prend un "contexte" autour pour raw_name (best effort)
    const start = Math.max(0, m.index - 80);
    const end = Math.min(text.length, m.index + 80);
    const ctx = text.slice(start, end).replace(/\s+/g, " ").trim();

    items.push({
      raw_name: ctx || "UNKNOWN",
      article_number: art,
      qty: 1,
    });
  }

  return items;
}

// ─────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  ok(res, { ok: true, service: "ikea-dramaturge-extracteur" });
});

app.post("/extract-items", async (req, res) => {
  const startTime = Date.now();
  const extractedAt = new Date().toISOString();

  try {
    // AUTH: header x-api-key
    const clientKey = req.headers["x-api-key"];
    if (!API_KEY || String(clientKey || "") !== String(API_KEY)) {
      return bad(res, 401, { success: false, error: "UNAUTHORIZED" });
    }

    const { planner_url, request_nonce } = req.body || {};
    if (!planner_url) {
      return bad(res, 400, { success: false, error: { code: "MISSING_URL", message: "planner_url est obligatoire" } });
    }

    if (!String(planner_url).includes("kitchen.planner.ikea.com")) {
      return bad(res, 400, { success: false, error: { code: "INVALID_DOMAIN", message: "URL doit être kitchen.planner.ikea.com" } });
    }

    const plannerId = extractPlannerId(planner_url);
    if (!plannerId) {
      return bad(res, 400, { success: false, error: { code: "MISSING_PLANNER_ID", message: "UUID manquant dans l'URL" } });
    }

    const nonce = request_nonce || crypto.randomUUID();

    // ─────────────────────────────────────────────
    // PLAYWRIGHT LOCAL (Railway) – version SIMPLE
    // ─────────────────────────────────────────────
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ locale: "fr-FR" });

      // On va juste charger et lire le texte de la page (pas de click)
      await page.goto(planner_url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(6000);

      // Récupère texte visible + HTML pour trouver les articles
      const bodyText = await page.evaluate(() => document.body?.innerText || "");
      const html = await page.content();

      const combined = `${bodyText}\n${html}`;
      const items = parseItemsFromText(combined);

      const duration = Date.now() - startTime;
      const hash = computeHash(items, plannerId, nonce, extractedAt);

      return ok(res, {
        success: true,
        status: "OK",
        data: {
          extract_version: "simple-v1",
          extraction_method: "playwright_no_click",
          extraction_hash: hash,
          extracted_at: extractedAt,
          planner_id: plannerId,
          planner_url,
          request_nonce: nonce,
          totals: {
            items_count: items.length,
            total_quantity: items.reduce((s, i) => s + (i.qty || 0), 0),
          },
          items,
          debug: {
            duration_ms: duration,
            note: "Extraction simple: aucun clic, on cherche les numéros d’article dans le texte/HTML.",
          },
        },
      });
    } catch (e) {
      const duration = Date.now() - startTime;
      return ok(res, {
        success: false,
        status: "EXTRACTION_FAILED",
        error: {
          code: "PLAYWRIGHT_FAILED",
          message: e?.message || "Playwright failed",
        },
        debug: { duration_ms: duration },
      });
    } finally {
      if (browser) {
        try { await browser.close(); } catch {}
      }
    }
  } catch (e) {
    return bad(res, 500, {
      success: false,
      status: "ERROR",
      error: { code: "INTERNAL_ERROR", message: e?.message || "Erreur interne" },
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
