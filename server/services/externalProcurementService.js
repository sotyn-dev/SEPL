/**
 * externalProcurementService.js
 * 
 * Standalone integration service for external B2B procurement price discovery.
 * Connects to Moglix Catalog API and IndiaMART to provide benchmark pricing, 
 * supplier options, and market rate comparisons for Price Required, Item Master, and Estimator.
 * 
 * SAFETY GUARANTEES:
 * - 100% Non-blocking: External HTTP calls use strict AbortController timeouts (6s max).
 * - Fault tolerant: Wrapped in Promise.allSettled — failures return empty arrays, never crash.
 * - Zero Schema Alterations: Uses an independent local cache table or in-memory fallback.
 * - Read-only: Queries public catalog listings only; mutates no external data.
 */

const { getDb } = require('../db/schema');

// In-memory fallback cache (TTL 24 hours)
const memoryCache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Ensure independent cache table exists in SQLite
function initCacheTable() {
  try {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS external_price_cache (
        query_key TEXT PRIMARY KEY,
        result_json TEXT,
        cached_at INTEGER
      )
    `);
  } catch (_) {
    // If DB busy or read-only, memoryCache will be used automatically
  }
}
initCacheTable();

/**
 * Intelligent Query Extractor for EPC / MEP Tender Items (Solution A)
 * Converts verbose, contractual BOQ clauses into clean commercial procurement queries
 */
function extractCleanProcurementQuery(rawText, size = '', make = '', spec = '') {
  let text = String(rawText || '').trim();
  if (!text) return '';

  const hasBoqNoise = text.length > 25 && /(conforming to|together with|including|excavation|supply,?\s*install|providing|necessary|adapter pieces|flanges,\s*gaskets)/i.test(text);
  if (!hasBoqNoise && text.length <= 40) {
    if (size && !text.toLowerCase().includes(size.toLowerCase().replace(/\s*dia\b/i, ''))) {
      text = `${text} ${size}`.trim();
    }
    return text.replace(/\s+/g, ' ').trim();
  }

  // 1. Strip leading numbering / bullets: i), (i), 1., 1.1, a), (a), A., 1)
  text = text.replace(/^(\([0-9a-zivx]+\)|[0-9a-zivx]+[\).])\s*/i, '');

  // 2. Strip tender contract prefixes (case-insensitive)
  text = text.replace(/^(providing\s*(and|&)?\s*fixing(\s*of)?|supply\s*(and|&)?\s*delivery(\s*of)?|supply\s*,?\s*(installation\s*,?\s*)?testing\s*(and|&)?\s*commissioning(\s*of)?)\s*/i, '');
  text = text.replace(/^all\s+/i, '');

  // 3. Detect standards (IS 1239, IS 3589, BS 5154, ASTM A53) before cutting
  const standardMatch = text.match(/\b(IS\s*\d+|BS\s*\d+|ASTM\s*[A-Z0-9]+)\b/i);
  const standard = standardMatch ? standardMatch[1].replace(/\s+/g, ' ') : '';

  // 4. Cut off trailing contractual / site activity clauses
  const cutOffKeywords = [
    /\btogether with\b.*/i,
    /\balong with\b.*/i,
    /\bcomplete with\b.*/i,
    /\bincluding\b.*/i,
    /\bas per\b.*/i,
    /\bas specified\b.*/i,
    /\bconforming to\b.*/i,
    /\bnecessary\b.*/i
  ];
  for (const regex of cutOffKeywords) {
    text = text.replace(regex, '');
  }

  // 5. Clean brackets and extra punctuation
  text = text.replace(/[();:,]/g, ' ').replace(/\s+/g, ' ').trim();

  // 6. Domain-specific normalization:
  // PIPES:
  if (/\bpipes?\b/i.test(text)) {
    const isGI = /\b(gi|galvanised|galvanized)\b/i.test(rawText);
    const pipeType = isGI ? 'GI Pipe' : 'MS Pipe';
    const cls = rawText.match(/class[-\s]*([abc])/i);
    const classStr = cls ? 'Class ' + cls[1].toUpperCase() : '';
    text = `${pipeType} ${classStr}`.trim();
  }

  // 7. Append structured size if not already included
  if (size && !text.toLowerCase().includes(size.toLowerCase().replace(/\s*dia\b/i, ''))) {
    text = `${text} ${size}`.trim();
  }

  // 8. Append IS standard if extracted and not included
  if (standard && !text.toLowerCase().includes(standard.toLowerCase())) {
    text = `${text} ${standard}`.trim();
  }

  // 9. Append Make/Brand if valid single make
  if (make && !/^[—\-]|n\/?a|any|reputed|approved/i.test(make) && !text.toLowerCase().includes(make.toLowerCase())) {
    const firstMake = make.split(/[\/,]/)[0].trim();
    if (firstMake && firstMake.length > 1) {
      text = `${text} ${firstMake}`.trim();
    }
  }

  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Fetch internal historical rates paid by SEPL across previous Vendor POs & Item Master
 * Supports exact phrase matching and smart token-overlap scoring
 */
function getInternalHistoricalRates(query) {
  try {
    const db = getDb();
    const clean = String(query || '').trim().toLowerCase();
    if (!clean) return { pastPoRates: [], masterRate: null };

    // 1. Search recent Vendor PO items - Exact phrase first
    let pastPoRates = db.prepare(`
      SELECT 
        vpi.rate,
        vpi.quantity,
        vpi.created_at,
        vpi.description,
        vp.po_number,
        vp.po_date,
        v.name AS vendor_name
      FROM vendor_po_items vpi
      JOIN vendor_pos vp ON vp.id = vpi.vendor_po_id
      LEFT JOIN vendors v ON v.id = vp.vendor_id
      WHERE LOWER(vpi.description) LIKE ?
      ORDER BY vpi.id DESC
      LIMIT 5
    `).all(`%${clean}%`);

    // 2. Search Item Master baseline - Exact phrase first
    let masterRate = db.prepare(`
      SELECT 
        item_code,
        item_name,
        current_price,
        source_type,
        make,
        model_number
      FROM item_master
      WHERE LOWER(item_name) LIKE ? OR LOWER(item_code) LIKE ?
      ORDER BY id DESC
      LIMIT 1
    `).get(`%${clean}%`, `%${clean}%`);

    // 3. Fallback: Smart keyword matching (e.g. "SS Ball Valve 50mm" -> "ball", "valve")
    const words = clean
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3 && !w.match(/^\d+mm$/i) && !['item', 'updated', 'test', 'temp', 'draft'].includes(w));

    if (words.length > 0) {
      if (!masterRate) {
        try {
          const sqlWhere = words.map(() => 'LOWER(item_name) LIKE ?').join(' OR ');
          const params = words.map(w => `%${w}%`);
          const candidates = db.prepare(`
            SELECT 
              item_code,
              item_name,
              current_price,
              source_type,
              make,
              model_number
            FROM item_master
            WHERE ${sqlWhere}
            LIMIT 50
          `).all(...params);

          if (candidates.length > 0) {
            candidates.forEach(c => {
              const name = (c.item_name || '').toLowerCase();
              c.score = words.reduce((acc, w) => acc + (name.includes(w) ? (w.length >= 5 ? 3 : 1) : 0), 0);
            });
            candidates.sort((a, b) => b.score - a.score);
            if (candidates[0].score > 0) {
              masterRate = candidates[0];
            }
          }
        } catch (_) {}
      }

      if (!pastPoRates || pastPoRates.length === 0) {
        try {
          const sqlWhere = words.map(() => 'LOWER(vpi.description) LIKE ?').join(' OR ');
          const params = words.map(w => `%${w}%`);
          const candidates = db.prepare(`
            SELECT 
              vpi.rate,
              vpi.quantity,
              vpi.created_at,
              vpi.description,
              vp.po_number,
              vp.po_date,
              v.name AS vendor_name
            FROM vendor_po_items vpi
            JOIN vendor_pos vp ON vp.id = vpi.vendor_po_id
            LEFT JOIN vendors v ON v.id = vp.vendor_id
            WHERE ${sqlWhere}
            ORDER BY vpi.id DESC
            LIMIT 20
          `).all(...params);

          if (candidates.length > 0) {
            candidates.forEach(c => {
              const desc = (c.description || '').toLowerCase();
              c.score = words.reduce((acc, w) => acc + (desc.includes(w) ? (w.length >= 5 ? 3 : 1) : 0), 0);
            });
            candidates.sort((a, b) => b.score - a.score);
            pastPoRates = candidates.slice(0, 5);
          }
        } catch (_) {}
      }
    }

    return {
      pastPoRates: pastPoRates || [],
      masterRate: masterRate || null,
    };
  } catch (err) {
    return { pastPoRates: [], masterRate: null };
  }
}

function getFromCache(key, query = '') {
  const now = Date.now();
  let cached = null;

  if (memoryCache.has(key)) {
    const item = memoryCache.get(key);
    if (now - item.timestamp < CACHE_TTL_MS) {
      cached = item.data;
    } else {
      memoryCache.delete(key);
    }
  }

  if (!cached) {
    try {
      const db = getDb();
      const row = db.prepare('SELECT result_json, cached_at FROM external_price_cache WHERE query_key = ?').get(key);
      if (row && (now - row.cached_at < CACHE_TTL_MS)) {
        cached = JSON.parse(row.result_json);
        memoryCache.set(key, { data: cached, timestamp: row.cached_at });
      }
    } catch (_) {}
  }

  if (cached) {
    // Quality validation: purge stale placeholder (IndiaMART price 0) or garden items returned for fire fighting
    const qLower = (query || '').toLowerCase();
    const hasPlaceholderIM = cached.indiamart?.length > 0 && cached.indiamart.every(i => !i.price || i.price === 0);
    const hasGardenInFire = qLower.includes('fire') && (cached.moglix || []).some(p => /garden|agri|lawn|hose/i.test(p.title));
    if (hasPlaceholderIM || hasGardenInFire) {
      memoryCache.delete(key);
      try {
        const db = getDb();
        db.prepare('DELETE FROM external_price_cache WHERE query_key = ?').run(key);
      } catch (_) {}
      return null;
    }
    return cached;
  }

  return null;
}

function saveToCache(key, data) {
  const now = Date.now();
  memoryCache.set(key, { data, timestamp: now });
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO external_price_cache (query_key, result_json, cached_at)
      VALUES (?, ?, ?)
      ON CONFLICT(query_key) DO UPDATE SET result_json = excluded.result_json, cached_at = excluded.cached_at
    `).run(key, JSON.stringify(data), now);
  } catch (_) {}
}

/**
 * Fetch raw search results from Moglix catalog endpoint
 */
async function fetchMoglixRaw(searchTerm, timeoutMs = 6000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const apiUrl = `https://apinew.moglix.com/nodeApi/v1/search/v2?str=${encodeURIComponent(searchTerm)}&pageIndex=0&pageSize=15&type=d`;
    const response = await fetch(apiUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://www.moglix.com',
        'Referer': 'https://www.moglix.com/'
      }
    });
    clearTimeout(timeoutId);
    if (!response.ok) return [];

    const data = await response.json();
    return data?.productSearchResult?.products || [];
  } catch (_) {
    clearTimeout(timeoutId);
    return [];
  }
}

/**
 * High-precision Moglix Search with Domain & Dimension Matching
 */
async function searchMoglix(query) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) return [];

  // Strip noise words like 'updated', 'test', 'draft', 'temp'
  const sanitized = cleanQuery
    .replace(/\b(updated|test|draft|new|temp)\b/gi, '')
    .replace(/[()]/g, ' ')
    .trim();
  const baseTerm = sanitized || cleanQuery;
  const queryLower = cleanQuery.toLowerCase();

  // Detect dimension / size specifications (e.g. 50mm, 2 inch, 2", 15mm, dn50)
  const sizeMatch = baseTerm.match(/\b(\d+(?:\.\d+)?\s*mm|\d+(?:\/\d+)?\s*(?:inch|\"|in)|dn\s*\d+)\b/i);
  const sizeToken = sizeMatch ? sizeMatch[1].toLowerCase().replace(/\s+/g, '') : null;

  // Build targeted search terms
  const searchTerms = [baseTerm];
  if (baseTerm !== cleanQuery) searchTerms.push(cleanQuery);

  // If query is for fire fighting sprinkler, query fire safety catalog specifically
  if (queryLower.includes('fire') && queryLower.includes('sprinkler')) {
    searchTerms.push('Fire Sprinkler');
    searchTerms.push('Pendent Fire Sprinkler');
    searchTerms.push('Automatic Fire Sprinkler');
  }

  if (sizeMatch) {
    const rawSize = sizeMatch[0];
    const withoutSize = baseTerm.replace(rawSize, '').trim();
    searchTerms.push(`${rawSize} ${withoutSize}`);
    searchTerms.push(`${withoutSize} ${rawSize}`);
    if (/ss|stainless/i.test(baseTerm) && /valve/i.test(baseTerm)) {
      searchTerms.push(`Stainless Steel Ball Valve ${rawSize}`);
    }
  }

  // Fetch products across targeted variations
  const allProducts = [];
  const seen = new Set();
  const uniqueTerms = [...new Set(searchTerms)].slice(0, 4);

  for (const term of uniqueTerms) {
    const prods = await fetchMoglixRaw(term);
    for (const p of prods) {
      const id = p.moglixPartNumber || p.productName;
      if (id && !seen.has(id)) {
        seen.add(id);
        allProducts.push(p);
      }
    }
  }

  if (allProducts.length === 0) return [];

  const queryTokens = queryLower.replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(w => w.length >= 2);

  // Score relevance: reward exact item type & size, strictly penalize conflicting domains & sizes
  allProducts.forEach(p => {
    const title = (p.productName || '').toLowerCase();
    const desc = (p.shortDesc || '').toLowerCase();
    const cat = (p.taxonomyName || []).join(' ').toLowerCase();
    const text = `${title} ${desc} ${cat}`;
    let score = 0;

    // 1. Fire Sprinkler vs Garden Sprinkler
    if (queryLower.includes('fire') && queryLower.includes('sprinkler')) {
      if (text.includes('fire sprinkler') || text.includes('fire protection') || (text.includes('fire') && text.includes('sprinkler'))) {
        score += 60;
      } else if (text.includes('safety') && text.includes('sprinkler')) {
        score += 40;
      }
      if (text.includes('pendent') || text.includes('pendant')) score += 25;

      // STRICTLY ELIMINATE GARDEN, AGRICULTURE, HOSE, AND SPRAY GUNS
      if (/\b(garden|gardening|agri|agriculture|lawn|spray gun|sprayer pipe|hose pipe|watering|spikes|nozzle for garden)\b/i.test(text)) {
        score -= 100;
      }
    } else if (queryLower.includes('ball valve')) {
      if (text.includes('ball valve')) score += 30;
      else if (text.includes('valve')) score += 5;
      else score -= 30; // Not a ball valve
    } else if (queryLower.includes('sprinkler')) {
      if (text.includes('sprinkler')) score += 30;
      else score -= 20;
    }

    // 2. Exact size match vs conflicting size
    if (sizeToken) {
      const is50mm = sizeToken.includes('50') || sizeToken.includes('2inch') || sizeToken.includes('2"');
      if (is50mm) {
        if (text.includes('50mm') || text.includes('50 mm') || text.includes('2 inch') || text.includes('2"') || text.includes('dn50') || text.includes('dn-50')) {
          score += 50;
        } else if (/\b(1\/4|1\/2|3\/8|3\/4|1 inch|1"|6mm|8mm|10mm|12mm|15mm|20mm|25mm|32mm|40mm)\b/i.test(text)) {
          score -= 50; // Heavy penalty for wrong size
        }
      } else {
        if (text.includes(sizeToken)) {
          score += 40;
        }
      }
    }

    // 3. Material match (SS / Stainless Steel)
    if (queryLower.includes('ss') || queryLower.includes('stainless')) {
      if (text.includes('stainless steel') || text.includes('ss ') || text.includes(' ss') || text.includes('304') || text.includes('316')) {
        score += 20;
      }
    }

    // 4. Token overlap
    for (const tok of queryTokens) {
      if (tok.length > 2 && text.includes(tok)) score += 3;
    }

    p._score = score;
  });

  allProducts.sort((a, b) => b._score - a._score);

  // STRICT RELEVANCE ONLY - NEVER PAD WITH UNRELATED ITEMS
  const finalProds = allProducts.filter(p => {
    if (p._score <= 0) return false;
    const title = (p.productName || '').toLowerCase();
    const cat = (p.taxonomyName || []).join(' ').toLowerCase();
    const text = `${title} ${cat}`;

    // STRICT REJECTION: Automotive / Car accessories unless user explicitly queried car
    if (!/\b(car|auto|vehicle|mercedes)\b/i.test(queryLower)) {
      if (/\b(car|automotive|mercedes|audi|bmw|towing rope|wiper|bumper|seat cover|air filter|oil filter|key cover)\b/i.test(text)) {
        return false;
      }
    }

    if (queryLower.includes('fire')) {
      if (/\b(garden|gardening|agri|agriculture|lawn|spray gun|sprayer|hose|pipe|watering|spike|drip|fittings)\b/i.test(text)) {
        return false;
      }
      return text.includes('fire sprinkler') || (text.includes('fire') && text.includes('sprinkler')) || text.includes('safety');
    }

    if (queryLower.includes('ball valve')) {
      if (!title.includes('ball valve')) return false;
      if (sizeToken) {
        const is50mm = sizeToken.includes('50') || sizeToken.includes('2inch') || sizeToken.includes('2"');
        if (is50mm) {
          const has50 = title.includes('50mm') || title.includes('50 mm') || title.includes('2 inch') || title.includes('2"') || title.includes('dn50') || title.includes('dn-50');
          if (!has50) return false;
        } else if (!title.includes(sizeToken)) {
          return false;
        }
      }
      return true;
    }

    // PIPE / PIPES: Must be an actual pipe or pipe fitting
    if (/\bpipes?\b/i.test(queryLower)) {
      const isPipe = /\b(pipe|pipes|tube|tubes|conduit|nipple|flange|elbow|tee|coupling)\b/i.test(title);
      if (!isPipe) return false;
      if (sizeToken && !title.includes(sizeToken)) {
        return false;
      }
      return true;
    }

    // VALVE / VALVES
    if (/\bvalves?\b/i.test(queryLower)) {
      if (!title.includes('valve')) return false;
      if (sizeToken && !title.includes(sizeToken)) return false;
      return true;
    }

    // CABLE / WIRE
    if (/\b(cable|wire)\b/i.test(queryLower)) {
      if (!/\b(cable|wire)\b/i.test(title)) return false;
      return true;
    }

    return p._score >= 35;
  }).slice(0, 10);

  return finalProds.map(p => {
    const rawPrice = Number(p.priceWithoutTax || p.salesPrice || p.mrp || 0);
    // Parse pack quantity if present (e.g. "Pack of 10")
    const packMatch = (p.productName || '').match(/pack of (\d+)/i);
    const packQty = packMatch ? parseInt(packMatch[1], 10) : 1;
    const unitPrice = packQty > 1 ? Math.round(rawPrice / packQty) : rawPrice;

    return {
      platform: 'Moglix',
      title: p.productName || p.variantName || 'Industrial Item',
      brand: p.brandName || 'Standard',
      price: unitPrice,
      packPrice: packQty > 1 ? rawPrice : null,
      packQty: packQty > 1 ? packQty : null,
      mrp: Number(p.mrp || 0),
      currency: 'INR',
      inStock: p.quantityAvailable > 0 || p.isActive === true,
      url: p.productUrl ? (p.productUrl.startsWith('http') ? p.productUrl : `https://www.moglix.com/${p.productUrl}`) : `https://www.moglix.com/search?controller=search&s=${encodeURIComponent(cleanQuery)}`,
      imageUrl: p.mainImageLink ? (p.mainImageLink.startsWith('http') ? p.mainImageLink : `https://cdn.moglix.com/${p.mainImageLink}`) : (p.mainImagePath ? `https://cdn.moglix.com/${p.mainImagePath}` : null),
    };
  });
}

/**
 * Live IndiaMART Search with Mobile Catalog Engine
 * Extracts real product cards, live prices, verified suppliers, and locations
 */
async function searchIndiaMart(query) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) return [];

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);

  try {
    const url = `https://dir.indiamart.com/search.mp?ss=${encodeURIComponent(cleanQuery)}`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G981B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.162 Mobile Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    clearTimeout(timeoutId);
    if (!res.ok) return [];

    const html = await res.text();
    const sections = html.split('<div class="ncui-product-price">');
    const items = [];
    const qLower = cleanQuery.toLowerCase();

    for (let i = 1; i < sections.length && items.length < 10; i++) {
      const prevChunk = sections[i - 1];
      const nextChunk = sections[i];

      const titleMatch = prevChunk.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*title="([^"]+)"/i) ||
                         prevChunk.match(/<h2[^>]*>[\s\S]*?<a[^>]*title="([^"]+)"[^>]*href="([^"]+)"/i) ||
                         prevChunk.match(/title="([^"]+)"/i);
      const priceMatch = nextChunk.match(/<span class="ncui-price-value">([^<]+)<\/span>/i);
      const unitMatch = nextChunk.match(/<span class="ncui-price-unit">([^<]+)<\/span>/i);
      const sellerMatch = nextChunk.match(/class="ncui-company-name"[^>]*>([^<]+)<\/a>/i);
      const locationMatch = nextChunk.match(/class="ncui-seller-meta">([^<•]+)/i);

      if (titleMatch && priceMatch) {
        const rawHref = titleMatch[1] && titleMatch[1].startsWith('/') ? titleMatch[1] : '';
        const href = rawHref ? `https://dir.indiamart.com${rawHref}` : `https://dir.indiamart.com/search.mp?ss=${encodeURIComponent(cleanQuery)}`;
        const title = (titleMatch[2] || titleMatch[1] || cleanQuery).replace(/&quot;/g, '"').replace(/&amp;/g, '&');
        const rawPrice = priceMatch[1].replace(/[^\d.]/g, '');
        const price = parseFloat(rawPrice) || 0;
        const unit = unitMatch ? unitMatch[1].replace(/<!-- -->/g, '').trim() : '';
        const seller = sellerMatch ? sellerMatch[1].trim() : 'IndiaMART Verified Supplier';
        const location = locationMatch ? locationMatch[1].trim() : 'Pan India';

        const titleLower = title.toLowerCase();

        // STRICT FILTERING FOR INDIAMART TOO
        // 1. Automotive exclusion
        if (!/\b(car|auto|vehicle|mercedes)\b/i.test(qLower)) {
          if (/\b(car|automotive|mercedes|audi|bmw|towing rope|wiper|bumper|seat cover|air filter|oil filter|key cover)\b/i.test(titleLower)) {
            continue;
          }
        }

        // 2. Fire Sprinkler vs Garden
        if (qLower.includes('fire')) {
          if (/\b(garden|gardening|agri|agriculture|lawn|spray gun|sprayer|hose|watering|drip|irrigation)\b/i.test(titleLower)) {
            continue;
          }
        }

        // 3. Pipe Size & Type matching
        if (/\bpipes?\b/i.test(qLower)) {
          if (!/\b(pipe|tube|pipes|tubes)\b/i.test(titleLower)) {
            continue;
          }
          const sizeMatch = qLower.match(/\b(\d+(?:\.\d+)?\s*mm|\d+(?:\/\d+)?\s*(?:inch|\"))\b/i);
          if (sizeMatch) {
            const rawSize = sizeMatch[1].replace(/\s+/g, '');
            if (rawSize === '100mm' && !/\b(100\s*mm|4\s*inch|4\")\b/i.test(titleLower) && /\b(24\s*inch|50\s*x\s*50|150\s*mm|200\s*mm|25\s*mm|50\s*mm|80\s*mm)\b/i.test(titleLower)) {
              continue;
            }
            if (rawSize === '150mm' && !/\b(150\s*mm|6\s*inch|6\")\b/i.test(titleLower) && /\b(24\s*inch|50\s*x\s*50|100\s*mm|200\s*mm|25\s*mm|50\s*mm)\b/i.test(titleLower)) {
              continue;
            }
          }
        }

        items.push({
          platform: 'IndiaMART',
          title,
          brand: seller,
          price,
          priceRange: `${priceMatch[1].trim()} ${unit}`.trim(),
          supplier: seller,
          location,
          url: href,
          inStock: true
        });
      }
    }

    return items;
  } catch (_) {
    clearTimeout(timeoutId);
    return [];
  }
}

/**
 * Main unified search method with caching & parallel resolution
 */
async function getMarketRates(query, options = {}) {
  const raw = String(query || '').trim();
  if (!raw) {
    return { query: '', moglix: [], indiamart: [], summary: null };
  }

  // Auto-clean query if verbose BOQ clause or if options provided
  const cleanSearch = extractCleanProcurementQuery(raw, options.size, options.make, options.spec);
  const activeQuery = cleanSearch || raw;
  const cleanKey = activeQuery.toLowerCase().trim();

  const cacheKey = `market_rates:${cleanKey}`;
  const cached = getFromCache(cacheKey, cleanKey);
  if (cached) {
    return { ...cached, isCached: true };
  }

  // Run searches in parallel with complete isolation
  const [moglixResult, indiamartResult] = await Promise.allSettled([
    searchMoglix(activeQuery),
    searchIndiaMart(activeQuery),
  ]);

  const moglixItems = moglixResult.status === 'fulfilled' ? moglixResult.value : [];
  const indiamartItems = indiamartResult.status === 'fulfilled' ? indiamartResult.value : [];

  // Calculate market benchmark stats across both portals
  const allPrices = [
    ...moglixItems.map(p => p.price),
    ...indiamartItems.map(p => p.price)
  ].filter(pr => pr > 0);

  let summary = null;
  if (allPrices.length > 0) {
    const min = Math.min(...allPrices);
    const max = Math.max(...allPrices);
    const avg = Math.round(allPrices.reduce((a, b) => a + b, 0) / allPrices.length);
    summary = {
      lowestPrice: min,
      highestPrice: max,
      averagePrice: avg,
      sampleCount: allPrices.length,
      currency: 'INR'
    };
  }

  const internalHistory = getInternalHistoricalRates(activeQuery);

  const directLinks = {
    moglix: `https://www.moglix.com/search?controller=search&s=${encodeURIComponent(activeQuery)}`,
    indiamart: `https://dir.indiamart.com/search.mp?ss=${encodeURIComponent(activeQuery)}`,
    amazon: `https://www.amazon.in/s?k=${encodeURIComponent(activeQuery)}`,
    industrybuying: `https://www.industrybuying.com/search/?q=${encodeURIComponent(activeQuery)}`,
  };

  const result = {
    rawQuery: raw,
    query: activeQuery,
    moglix: moglixItems,
    indiamart: indiamartItems,
    internalHistory,
    directLinks,
    summary,
    searchedAt: new Date().toISOString()
  };

  // Cache whenever meaningful results are found
  if (moglixItems.length > 0 || indiamartItems.length > 0) {
    saveToCache(cacheKey, result);
  }

  return { ...result, isCached: false };
}

module.exports = {
  getMarketRates,
  getInternalHistoricalRates,
  searchMoglix,
  searchIndiaMart,
  extractCleanProcurementQuery,
};
