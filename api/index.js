const { URL } = require('node:url');

const APPLE_MUSIC_FALLBACK_TOKEN =
  'eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiIsImtpZCI6IldlYlBsYXlLaWQifQ' +
  '.eyJpc3MiOiJBTVBXZWJQbGF5IiwiaWF0IjoxNzgxMDMyODU1LCJleHAiOjE3ODQw' +
  'NTY4NTUsInJvb3RfaHR0cHNfb3JpZ2luIjpbImFwcGxlLmNvbSJdfQ' +
  '.fiMFcJWkfSlxKP9NVA0UW9CbItD1Rge0SISuepz203XcpU762OqdCpU9M-YkmtKkjRmaIWtjsfGgqZPrlMonpA';

const AMP_BASE_URL = 'https://amp-api.music.apple.com';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const PREFERRED_VIDEO_KEYS = [
  'motionDetailRaw',
  'motionDetailTall',
  'motionDetailSquare',
  'motionSquareVideo1x1',
  'motionTallVideo3x4',
];

let cachedAppleToken = null;
let tokenExpiryMs = 0;
let tokenSource = 'none';
const canvasCache = new Map();

async function getOrFetchAppleToken(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedAppleToken && now < tokenExpiryMs - 60_000) {
    return { token: cachedAppleToken, source: 'cached', expiryMs: tokenExpiryMs };
  }

  try {
    const browseRes = await fetch('https://music.apple.com/us/browse', {
      headers: { 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(12_000),
    });
    const html = await browseRes.text();

    const scriptRegex = /\/assets\/index(?:-legacy)?[~-][a-zA-Z0-9_-]+\.js/g;
    const scripts = [...new Set(html.match(scriptRegex) || [])];

    let fetchedToken = null;
    let fetchedExpMs = 0;

    for (const scriptPath of scripts) {
      const scriptUrl = `https://music.apple.com${scriptPath}`;
      const scriptRes = await fetch(scriptUrl, {
        headers: { 'User-Agent': BROWSER_UA },
        signal: AbortSignal.timeout(15_000),
      });
      const scriptText = await scriptRes.text();

      const tokenRegex = /ey[a-zA-Z0-9_-]+\.ey[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g;
      const tokens = scriptText.match(tokenRegex) || [];

      for (const token of tokens) {
        try {
          const payloadPart = token.split('.')[1];
          const decoded = Buffer.from(payloadPart, 'base64url').toString('utf8');
          if (decoded.includes('iss') && decoded.includes('exp')) {
            const parsed = JSON.parse(decoded);
            const expSeconds = Number(parsed.exp) || 0;
            if (expSeconds * 1000 > now) {
              fetchedToken = token;
              fetchedExpMs = expSeconds * 1000;
              break;
            }
          }
        } catch {
          // Ignore invalid JWT candidates
        }
      }
      if (fetchedToken) break;
    }

    if (fetchedToken) {
      cachedAppleToken = fetchedToken;
      tokenExpiryMs = fetchedExpMs;
      tokenSource = 'scraped';
      return { token: cachedAppleToken, source: 'scraped', expiryMs: tokenExpiryMs };
    }
  } catch (err) {
    console.warn('[AppleMusic] Token scrape error:', err.message);
  }

  tokenSource = 'fallback';
  return { token: APPLE_MUSIC_FALLBACK_TOKEN, source: 'fallback', expiryMs: 0 };
}

function extractEditorialVariants(editorialData, category) {
  if (!editorialData || typeof editorialData !== 'object') return [];
  const variants = [];
  const seenKeys = new Set();

  for (const key of PREFERRED_VIDEO_KEYS) {
    const entry = editorialData[key];
    if (entry && typeof entry.video === 'string' && entry.video.trim()) {
      variants.push({ key, category, videoUrl: entry.video, preferred: true });
      seenKeys.add(key);
    }
  }

  for (const [key, entry] of Object.entries(editorialData)) {
    if (seenKeys.has(key)) continue;
    if (entry && typeof entry.video === 'string' && entry.video.trim()) {
      variants.push({ key, category, videoUrl: entry.video, preferred: false });
    }
  }

  return variants;
}

async function queryAvidCanvas(artistName) {
  const start = Date.now();
  const formattedName = artistName.toLowerCase().replace(/[^a-z0-9]/g, '_');
  const trace = {
    provider: 'AvidCanvas',
    formattedName,
    checks: [],
    url: null,
    mimeType: null,
    durationMs: 0,
  };

  if (!formattedName.trim()) {
    trace.durationMs = Date.now() - start;
    return trace;
  }

  const baseUrl = `https://raw.githubusercontent.com/cgens67/avidtune-canvas/main/canvas/${formattedName}`;

  for (const ext of ['mp4', 'm3u8']) {
    const candidate = `${baseUrl}.${ext}`;
    try {
      const res = await fetch(candidate, {
        method: 'HEAD',
        signal: AbortSignal.timeout(5_000),
      });
      trace.checks.push({ url: candidate, status: res.status, ok: res.ok });
      if (res.ok) {
        trace.url = candidate;
        trace.mimeType = ext === 'mp4' ? 'video/mp4' : 'application/x-mpegURL';
        break;
      }
    } catch (err) {
      trace.checks.push({ url: candidate, status: 0, ok: false, error: err.message });
    }
  }

  trace.durationMs = Date.now() - start;
  return trace;
}

async function queryAppleMusicCanvas(artistName, storefront = 'us') {
  const start = Date.now();
  const trace = {
    provider: 'Apple Music',
    storefront,
    tokenSource: null,
    matchedArtist: null,
    candidates: [],
    variants: [],
    url: null,
    mimeType: null,
    durationMs: 0,
    error: null,
  };

  if (!artistName.trim()) {
    trace.durationMs = Date.now() - start;
    return trace;
  }

  try {
    const tokenInfo = await getOrFetchAppleToken();
    trace.tokenSource = tokenInfo.source;

    const ampHeaders = {
      Authorization: `Bearer ${tokenInfo.token}`,
      Origin: 'https://music.apple.com',
      Referer: 'https://music.apple.com/',
      'User-Agent': BROWSER_UA,
    };

    const searchUrl = new URL(`${AMP_BASE_URL}/v1/catalog/${encodeURIComponent(storefront)}/search`);
    searchUrl.searchParams.set('term', artistName);
    searchUrl.searchParams.set('types', 'artists');
    searchUrl.searchParams.set('limit', '3');

    const searchRes = await fetch(searchUrl, {
      headers: ampHeaders,
      signal: AbortSignal.timeout(15_000),
    });

    if (!searchRes.ok) {
      trace.error = `Search API HTTP ${searchRes.status}`;
      trace.durationMs = Date.now() - start;
      return trace;
    }

    const searchJson = await searchRes.json();
    const artistsData = searchJson?.results?.artists?.data || [];

    const lowerQuery = artistName.toLowerCase();
    const scoredResults = artistsData
      .map((obj) => {
        const resultName = obj?.attributes?.name || '';
        const lowerResult = resultName.toLowerCase();
        if (!lowerResult.includes(lowerQuery) && !lowerQuery.includes(lowerResult)) {
          return null;
        }
        const score = lowerResult === lowerQuery ? 10 : 5;
        return { score, obj, name: resultName, id: obj?.id };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    trace.candidates = scoredResults.map((r) => ({
      id: r.id,
      name: r.name,
      score: r.score,
    }));

    for (const candidate of scoredResults) {
      if (candidate.score < 4 || !candidate.id) continue;

      const artistUrl = new URL(
        `${AMP_BASE_URL}/v1/catalog/${encodeURIComponent(storefront)}/artists/${encodeURIComponent(candidate.id)}`
      );
      artistUrl.searchParams.set('extend', 'editorialVideo,editorialArtwork');

      const artistRes = await fetch(artistUrl, {
        headers: ampHeaders,
        signal: AbortSignal.timeout(15_000),
      });

      if (!artistRes.ok) continue;

      const artistJson = await artistRes.json();
      const firstData = artistJson?.data?.[0];
      const attrs = firstData?.attributes || {};

      const evVariants = extractEditorialVariants(attrs.editorialVideo, 'editorialVideo');
      const eaVariants = extractEditorialVariants(attrs.editorialArtwork, 'editorialArtwork');
      const allVariants = [...evVariants, ...eaVariants];

      if (allVariants.length > 0) {
        const primaryUrl = allVariants[0].videoUrl;
        let artworkUrl = attrs?.artwork?.url || null;
        if (artworkUrl) {
          artworkUrl = artworkUrl.replace('{w}', '600').replace('{h}', '600');
        }

        trace.matchedArtist = {
          id: candidate.id,
          name: attrs.name || candidate.name,
          genres: attrs.genreNames || [],
          appleMusicUrl: attrs.url || null,
          artworkUrl,
        };
        trace.variants = allVariants;
        trace.url = primaryUrl;
        trace.mimeType = primaryUrl.toLowerCase().includes('.mp4')
          ? 'video/mp4'
          : 'application/x-mpegURL';
        break;
      }
    }
  } catch (err) {
    trace.error = err.message;
  }

  trace.durationMs = Date.now() - start;
  return trace;
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  for (const [k, v] of Object.entries(extraHeaders)) {
    res.setHeader(k, v);
  }
  res.end(JSON.stringify(payload));
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.end();
  }

  const reqUrl = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;

  if (pathname === '/api/health') {
    return sendJson(res, 200, {
      status: 'ok',
      runtime: 'vercel-serverless',
      tokenCached: Boolean(cachedAppleToken && Date.now() < tokenExpiryMs - 60_000),
      tokenSource,
      cacheSize: canvasCache.size,
    });
  }

  if (pathname === '/api/cache/clear' && req.method === 'POST') {
    canvasCache.clear();
    return sendJson(res, 200, { cleared: true, cacheSize: 0 });
  }

  if (pathname === '/api/canvas' && req.method === 'GET') {
    const artist = (reqUrl.searchParams.get('artist') || '').trim();
    const storefront = (reqUrl.searchParams.get('storefront') || 'us').toLowerCase();
    const orderParam = reqUrl.searchParams.get('order') || 'AvidCanvas,Apple Music';
    const enabledParam = reqUrl.searchParams.get('enabled') || 'AvidCanvas,Apple Music';
    const skipCache = reqUrl.searchParams.get('refresh') === 'true';

    if (!artist) {
      return sendJson(res, 400, { error: 'Artist name is required.' });
    }

    const enabledSet = new Set(enabledParam.split(',').map((s) => s.trim()).filter(Boolean));
    const orderList = orderParam.split(',').map((s) => s.trim()).filter(Boolean);
    for (const p of ['AvidCanvas', 'Apple Music']) {
      if (!orderList.includes(p)) orderList.push(p);
    }

    const cacheKey = `${storefront}|${artist}|${orderList.join(',')}|${[...enabledSet].sort().join(',')}`;
    if (!skipCache && canvasCache.has(cacheKey)) {
      return sendJson(res, 200, { ...canvasCache.get(cacheKey), fromCache: true });
    }

    const traces = [];
    let resolvedUrl = null;
    let resolvedProvider = null;
    let resolvedMimeType = null;
    let matchedArtist = null;
    let variants = [];

    for (const providerName of orderList) {
      if (!enabledSet.has(providerName)) {
        traces.push({ provider: providerName, skipped: true, reason: 'Disabled in settings' });
        continue;
      }

      if (providerName === 'AvidCanvas') {
        const t = await queryAvidCanvas(artist);
        traces.push(t);
        if (t.url && !resolvedUrl) {
          resolvedUrl = t.url;
          resolvedProvider = 'AvidCanvas';
          resolvedMimeType = t.mimeType;
          variants.push({ key: 'avidCanvas', category: 'github', videoUrl: t.url, preferred: true });
          break;
        }
      } else if (providerName === 'Apple Music') {
        const t = await queryAppleMusicCanvas(artist, storefront);
        traces.push(t);
        if (t.url && !resolvedUrl) {
          resolvedUrl = t.url;
          resolvedProvider = 'Apple Music';
          resolvedMimeType = t.mimeType;
          matchedArtist = t.matchedArtist;
          variants = t.variants;
          break;
        }
      }
    }

    const payload = {
      artist,
      storefront,
      cacheKey: `${storefront}|${artist}`,
      fromCache: false,
      resolvedUrl,
      resolvedProvider,
      resolvedMimeType,
      matchedArtist,
      variants,
      traces,
      timestamp: Date.now(),
    };

    if (resolvedUrl) {
      canvasCache.set(cacheKey, payload);
    }

    // Cache successful lookups on Vercel's Edge CDN for 1 hour unless force-refreshed
    const cacheHeader = !skipCache && resolvedUrl
      ? { 'Cache-Control': 's-maxage=3600, stale-while-revalidate=86400' }
      : { 'Cache-Control': 'no-store' };

    return sendJson(res, 200, payload, cacheHeader);
  }

  return sendJson(res, 404, { error: 'Not found' });
};
