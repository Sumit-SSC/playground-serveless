/**
 * RSS/Atom fetch proxy (CORS-friendly) for the Jobs/Trends pages.
 * Usage: /api/rss?url=<ENCODED_FEED_URL>&count=20
 *
 * Security: SSRF protection via hostname allowlist + basic private-host blocking.
 */

const DEFAULT_COUNT = 20;
const MAX_COUNT = 50;
const TIMEOUT_MS = 12_000;
const MAX_XML_BYTES = 1_000_000; // 1MB
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

const crypto = require('crypto');

// Optional KV cache (better consistency across serverless instances).
// If KV isn't configured, we fall back to in-memory caching per instance.
let kv = null;
try {
	({ kv } = require('@vercel/kv'));
} catch (e) {
	kv = null;
}

var __rssMemCache = new Map(); // cacheKey -> { ts, payload }

function makeCacheKey(feedUrl, count) {
	return 'rss:' + crypto.createHash('sha256').update(String(feedUrl) + '|' + String(count)).digest('hex');
}

function getMemCache(key) {
	try {
		var v = __rssMemCache.get(key);
		if (!v) return null;
		if (!v.ts || Date.now() - v.ts > CACHE_TTL_MS) {
			__rssMemCache.delete(key);
			return null;
		}
		return v.payload || null;
	} catch (e) {
		return null;
	}
}

function setMemCache(key, payload) {
	try {
		__rssMemCache.set(key, { ts: Date.now(), payload: payload });
	} catch (e) {
		// ignore
	}
}

async function getCached(cacheKey) {
	// 1) In-memory (fast path)
	var mem = getMemCache(cacheKey);
	if (mem) return mem;

	// 2) KV (optional)
	if (kv && process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
		try {
			var cached = await kv.get(cacheKey);
			if (cached && cached.payload) return cached.payload;
		} catch (e) {
			// ignore KV errors; fall back to live fetch
		}
	}

	return null;
}

async function setCached(cacheKey, payload) {
	// 1) In-memory (always)
	setMemCache(cacheKey, payload);

	// 2) KV (optional)
	if (kv && process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
		try {
			// KV supports TTL via expirationTtl; keep aligned with CACHE_TTL_MS
			var seconds = Math.max(60, Math.floor(CACHE_TTL_MS / 1000));
			await kv.set(cacheKey, { payload: payload }, { expirationTtl: seconds });
		} catch (e) {
			// ignore KV errors
		}
	}
}

// Keep this tight. Aligned with jobs-snapshot RSS sources (job-search-api parity).
const ALLOWED_HOSTS = new Set([
	'remoteok.io', 'www.remoteok.io', 'remoteok.com', 'www.remoteok.com',
	'weworkremotely.com', 'www.weworkremotely.com',
	'remotive.com', 'www.remotive.com',
	'jobscollider.com', 'www.jobscollider.com',
	'stackoverflow.com', 'www.stackoverflow.com',
	'wellfound.com', 'www.wellfound.com',
	'indeed.com', 'www.indeed.com', 'rss.indeed.com',
	'remote.co', 'www.remote.co',
	'jobspresso.co', 'www.jobspresso.co',
	'himalayas.app', 'www.himalayas.app',
	'authenticjobs.com', 'www.authenticjobs.com',
	'rssjobs.app', 'www.rssjobs.app',
	'towardsdatascience.com', 'www.towardsdatascience.com',
	'medium.com', 'www.medium.com',
	// Trends/news feeds
	'news.google.com',
	'torrentfreak.com', 'www.torrentfreak.com',
	'xda-developers.com', 'www.xda-developers.com',
	'visualcapitalist.com', 'www.visualcapitalist.com'
	,
	// Resources live feed
	'freecodecamp.org', 'www.freecodecamp.org',
	// Alerts/disasters
	'gdacs.org', 'www.gdacs.org'
]);

function isPrivateHost(hostname) {
	if (!hostname) return true;
	const h = String(hostname).toLowerCase();
	if (h === 'localhost' || h.endsWith('.local')) return true;
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
		const parts = h.split('.').map(n => parseInt(n, 10));
		if (parts.some(n => isNaN(n) || n < 0 || n > 255)) return true;
		const [a, b] = parts;
		if (a === 10) return true;
		if (a === 127) return true;
		if (a === 0) return true;
		if (a === 169 && b === 254) return true;
		if (a === 192 && b === 168) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		return false;
	}
	if (h === '::1' || h.startsWith('[')) return true;
	return false;
}

function stripCdata(s) {
	if (!s) return '';
	return String(s).replace(/^<!\[CDATA\[(.*)\]\]>$/s, '$1').trim();
}

function decodeBasicEntities(s) {
	if (!s) return '';
	return String(s)
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

function stripTags(html) {
	if (!html) return '';
	return String(html)
		.replace(/<script[\s\S]*?<\/script>/gi, '')
		.replace(/<style[\s\S]*?<\/style>/gi, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function extractFirst(text, tag) {
	if (!text) return '';
	const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>', 'i');
	const m = String(text).match(re);
	return m ? m[1] : '';
}

function extractAllBlocks(text, tag) {
	if (!text) return [];
	const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>', 'gi');
	const out = [];
	let m;
	while ((m = re.exec(String(text)))) out.push(m[1]);
	return out;
}

function parseAtomLink(entryXml) {
	if (!entryXml) return '';
	const m1 = String(entryXml).match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
	if (m1 && m1[1]) return m1[1];
	const linkText = extractFirst(entryXml, 'link');
	return decodeBasicEntities(stripCdata(linkText)).trim();
}

function parseRss(xml, count) {
	const channelTitle = decodeBasicEntities(stripCdata(extractFirst(xml, 'title')));
	const items = extractAllBlocks(xml, 'item').slice(0, count).map(function (itemXml) {
		const title = decodeBasicEntities(stripCdata(extractFirst(itemXml, 'title')));
		const link = decodeBasicEntities(stripCdata(extractFirst(itemXml, 'link')));
		const pubDate = decodeBasicEntities(stripCdata(extractFirst(itemXml, 'pubDate'))) ||
			decodeBasicEntities(stripCdata(extractFirst(itemXml, 'dc:date')));
		const descRaw = extractFirst(itemXml, 'description') || extractFirst(itemXml, 'content:encoded');
		const desc = decodeBasicEntities(stripCdata(descRaw));
		return {
			title,
			link,
			pubDate,
			description: stripTags(desc).slice(0, 280),
			content: desc
		};
	});
	return { title: channelTitle, items };
}

function parseAtom(xml, count) {
	const feedTitle = decodeBasicEntities(stripCdata(extractFirst(xml, 'title')));
	const entries = extractAllBlocks(xml, 'entry').slice(0, count).map(function (entryXml) {
		const title = decodeBasicEntities(stripCdata(extractFirst(entryXml, 'title')));
		const link = decodeBasicEntities(parseAtomLink(entryXml));
		const pubDate = decodeBasicEntities(stripCdata(extractFirst(entryXml, 'updated'))) ||
			decodeBasicEntities(stripCdata(extractFirst(entryXml, 'published')));
		const summaryRaw = extractFirst(entryXml, 'summary') || extractFirst(entryXml, 'content');
		const summary = decodeBasicEntities(stripCdata(summaryRaw));
		return {
			title,
			link,
			pubDate,
			description: stripTags(summary).slice(0, 280),
			content: summary
		};
	});
	return { title: feedTitle, items: entries };
}

function parseFeed(xml, count) {
	const x = String(xml || '');
	if (/<feed[\s>]/i.test(x) && /xmlns=["']http:\/\/www\.w3\.org\/2005\/Atom["']/i.test(x)) {
		return parseAtom(x, count);
	}
	return parseRss(x, count);
}

async function fetchWithTimeout(url) {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
	try {
		return await fetch(url, {
			method: 'GET',
			headers: {
				'User-Agent': 'sumit-personal-site job rss proxy',
				'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*'
			},
			signal: ctrl.signal
		});
	} finally {
		clearTimeout(t);
	}
}

module.exports = async (req, res) => {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
	res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');

	if (req.method === 'OPTIONS') return res.status(200).end();

	const rawUrl = (req.query && req.query.url) ? String(req.query.url) : '';
	let count = DEFAULT_COUNT;
	if (req.query && req.query.count != null) {
		const n = parseInt(String(req.query.count), 10);
		if (!isNaN(n)) count = Math.max(1, Math.min(MAX_COUNT, n));
	}

	if (!rawUrl) return res.status(400).json({ ok: false, error: 'Missing url' });

	let feedUrl;
	try { feedUrl = new URL(rawUrl); } catch (e) { return res.status(400).json({ ok: false, error: 'Invalid url' }); }
	if (feedUrl.protocol !== 'https:' && feedUrl.protocol !== 'http:') return res.status(400).json({ ok: false, error: 'Unsupported protocol' });

	const host = (feedUrl.hostname || '').toLowerCase();
	if (isPrivateHost(host)) return res.status(403).json({ ok: false, error: 'Host not allowed' });
	if (!ALLOWED_HOSTS.has(host)) return res.status(403).json({ ok: false, error: 'Host not allowlisted' });

	var cacheKey = makeCacheKey(feedUrl.toString(), count);
	var cached = await getCached(cacheKey);
	if (cached) {
		return res.status(200).json({
			ok: true,
			feedUrl: feedUrl.toString(),
			title: cached.title || '',
			count: typeof cached.count === 'number' ? cached.count : (cached.items ? cached.items.length : 0),
			items: cached.items || []
		});
	}

	try {
		const r = await fetchWithTimeout(feedUrl.toString());
		if (!r.ok) return res.status(502).json({ ok: false, error: 'Fetch failed', status: r.status });
		const buf = Buffer.from(await r.arrayBuffer());
		if (buf.length > MAX_XML_BYTES) return res.status(413).json({ ok: false, error: 'Feed too large' });
		const xml = buf.toString('utf8');
		const parsed = parseFeed(xml, count);
		var payload = {
			ok: true,
			feedUrl: feedUrl.toString(),
			title: parsed.title || '',
			count: parsed.items.length,
			items: parsed.items
		};
		await setCached(cacheKey, { title: payload.title, count: payload.count, items: payload.items });
		return res.status(200).json(payload);
	} catch (e) {
		return res.status(500).json({ ok: false, error: 'Failed to fetch or parse feed', message: e && e.message ? e.message : String(e) });
	}
};

