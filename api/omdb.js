/**
 * OMDb proxy — keeps the API key on the server. Use this repo alone on Vercel.
 * Env: OMDB_API_KEY (required). Optional: ALLOWED_ORIGINS, API_SECRET, RATE_LIMIT_PER_MINUTE.
 * Tracks daily API hits (resets at midnight UTC); limit 1000/day. Use ?usage=1 to get count without calling OMDb.
 */

const OMDB_BASE = 'https://www.omdbapi.com/';
const MAX_TITLE_LENGTH = 200;
const DAILY_LIMIT = 1000;

// Daily counter: reset at midnight UTC. Persists in global across warm invocations.
function getGlobalDaily() {
	if (typeof global === 'undefined') return { date: '', count: 0 };
	global.__omdbDaily = global.__omdbDaily || { date: '', count: 0 };
	const today = new Date().toISOString().slice(0, 10);
	if (global.__omdbDaily.date !== today) {
		global.__omdbDaily = { date: today, count: 0 };
	}
	return global.__omdbDaily;
}
function incrementDaily() {
	const d = getGlobalDaily();
	d.count += 1;
	return d.count;
}
function getDailyCount() {
	return getGlobalDaily().count;
}
function usagePayload() {
	return { dailyCount: getDailyCount(), dailyLimit: DAILY_LIMIT };
}

// Daily stats: by type, category, and source (website, vercel_app, manual, form_bot, other). Last 31 days.
var STATS_DAYS = 31;
var CATEGORIES = ['movies', 'kdrama', 'anime', 'bollywood'];
var SOURCES = ['website', 'vercel_app', 'manual', 'form_bot', 'other'];

function getStats() {
	if (typeof global === 'undefined') return { daily: {} };
	global.__omdbStats = global.__omdbStats || { daily: {} };
	return global.__omdbStats;
}

function getSource(req) {
	var s = (req.query && req.query.source) ? String(req.query.source).toLowerCase().trim() : '';
	if (!s && req.headers['x-omdb-source']) s = String(req.headers['x-omdb-source']).toLowerCase().trim();
	return SOURCES.indexOf(s) !== -1 ? s : 'other';
}

function recordRequest(type, category, source) {
	var today = new Date().toISOString().slice(0, 10);
	var stats = getStats();
	if (!stats.daily[today]) {
		stats.daily[today] = {
			count: 0,
			byType: { search: 0, detail: 0, poster: 0 },
			byCategory: { movies: 0, kdrama: 0, anime: 0, bollywood: 0 },
			bySource: { website: 0, vercel_app: 0, manual: 0, form_bot: 0, other: 0 }
		};
	}
	var d = stats.daily[today];
	d.count += 1;
	d.byType[type] = (d.byType[type] || 0) + 1;
	if (category && CATEGORIES.indexOf(category) !== -1) {
		d.byCategory[category] = (d.byCategory[category] || 0) + 1;
	}
	var src = source && SOURCES.indexOf(source) !== -1 ? source : 'other';
	d.bySource[src] = (d.bySource[src] || 0) + 1;
	// Trim to last STATS_DAYS
	var dates = Object.keys(stats.daily).sort();
	while (dates.length > STATS_DAYS) {
		delete stats.daily[dates[0]];
		dates.shift();
	}
}

function getStatsPayload() {
	var stats = getStats();
	var daily = stats.daily || {};
	var dates = Object.keys(daily).sort().reverse().slice(0, STATS_DAYS);
	var out = {};
	dates.forEach(function (d) { out[d] = daily[d]; });
	var now = new Date();
	var weekAgo = new Date(now);
	weekAgo.setUTCDate(weekAgo.getUTCDate() - 7);
	var monthAgo = new Date(now);
	monthAgo.setUTCDate(monthAgo.getUTCDate() - 30);
	var weeklyTotal = 0;
	var monthlyTotal = 0;
	dates.forEach(function (d) {
		var n = daily[d].count || 0;
		if (d >= weekAgo.toISOString().slice(0, 10)) weeklyTotal += n;
		if (d >= monthAgo.toISOString().slice(0, 10)) monthlyTotal += n;
	});
	return { daily: out, weeklyTotal: weeklyTotal, monthlyTotal: monthlyTotal, dailyLimit: DAILY_LIMIT };
}

// In-memory rate limit (per deployment instance). For strict limits across all instances use Vercel KV/Redis.
var rateLimitMap = Object.create(null);
var rateLimitWindowMs = 60 * 1000;

function getKey() {
	return process.env.OMDB_API_KEY || '';
}

function getApiSecret() {
	return (process.env.API_SECRET || '').trim();
}

function allowedOrigin(origin) {
	if (!origin) return true;
	const list = (process.env.ALLOWED_ORIGINS || '').trim().split(',').map(function (o) { return o.trim(); }).filter(Boolean);
	if (list.length === 0) return true;
	return list.some(function (o) { return o === origin || origin.endsWith(o); });
}

function getClientIp(req) {
	return req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : (req.headers['x-real-ip'] || 'unknown');
}

function checkRateLimit(ip) {
	const limit = parseInt(process.env.RATE_LIMIT_PER_MINUTE || '0', 10);
	if (!limit || limit <= 0) return null;
	const now = Date.now();
	if (!rateLimitMap[ip]) rateLimitMap[ip] = [];
	const times = rateLimitMap[ip];
	while (times.length && times[0] < now - rateLimitWindowMs) times.shift();
	if (times.length >= limit) return { retryAfter: 60 };
	times.push(now);
	return null;
}

async function getPremiumPosterFallback(imdbID, title, type, year) {
	const tmdbKey = (process.env.TMDB_API_KEY || '').trim();
	const rpdbKey = (process.env.RPDB_API_KEY || '').trim();

	if (rpdbKey && imdbID && /^tt\d+$/.test(imdbID)) {
		return `https://api.rpdb.co/v1/lookup?api_key=${rpdbKey}&imdb_id=${imdbID}`;
	}

	if (tmdbKey) {
		try {
			if (imdbID && /^tt\d+$/.test(imdbID)) {
				const findUrl = `https://api.themoviedb.org/3/find/${imdbID}?api_key=${tmdbKey}&external_source=imdb_id`;
				const res = await fetch(findUrl);
				if (res.ok) {
					const data = await res.json();
					const movie = (data.movie_results && data.movie_results[0]);
					const tv = (data.tv_results && data.tv_results[0]);
					const item = movie || tv;
					if (item && item.poster_path) {
						return `https://image.tmdb.org/t/p/w600_and_h900_bestv2${item.poster_path}`;
					}
				}
			}
			
			if (title) {
				let searchUrl = `https://api.themoviedb.org/3/search/multi?api_key=${tmdbKey}&query=${encodeURIComponent(title)}`;
				const res = await fetch(searchUrl);
				if (res.ok) {
					const data = await res.json();
					if (data.results && data.results.length > 0) {
						let bestMatch = data.results[0];
						if (year) {
							const matched = data.results.find(item => {
								const date = item.release_date || item.first_air_date || '';
								return date.startsWith(year);
							});
							if (matched) bestMatch = matched;
						}
						if (bestMatch && bestMatch.poster_path) {
							return `https://image.tmdb.org/t/p/w600_and_h900_bestv2${bestMatch.poster_path}`;
						}
					}
				}
			}
		} catch (e) {
			console.error('TMDb poster fallback failed:', e);
		}
	}
	return null;
}


module.exports = async function handler(req, res) {
	var origin = req.headers.origin || '';
	if (!origin && req.headers.referer) {
		try { origin = new URL(req.headers.referer).origin; } catch (e) {}
	}
	if (req.method === 'OPTIONS') {
		res.setHeader('Access-Control-Allow-Origin', allowedOrigin(origin) ? (origin || '*') : '');
		res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, X-OMDb-Source');
		res.setHeader('Access-Control-Max-Age', '86400');
		return res.status(204).end();
	}

	if (req.method !== 'GET') {
		res.setHeader('Access-Control-Allow-Origin', origin || '*');
		return res.status(405).json({ poster: null, error: 'Method not allowed', usage: usagePayload() });
	}

	const apiSecret = getApiSecret();
	if (apiSecret) {
		const provided = (req.headers['x-api-key'] || '').trim();
		if (provided !== apiSecret) {
			res.setHeader('Access-Control-Allow-Origin', origin || '*');
			return res.status(401).json({ poster: null, error: 'Invalid or missing API key', usage: usagePayload() });
		}
	}

	const ip = getClientIp(req);
	const rateErr = checkRateLimit(ip);
	if (rateErr) {
		res.setHeader('Retry-After', String(rateErr.retryAfter));
		res.setHeader('Access-Control-Allow-Origin', origin || '*');
		return res.status(429).json({ poster: null, error: 'Too many requests', usage: usagePayload() });
	}

	// Usage-only: return daily count without incrementing and without calling OMDb.
	if (req.query && req.query.usage === '1') {
		res.setHeader('Access-Control-Allow-Origin', allowedOrigin(origin) ? (origin || '*') : '*');
		res.setHeader('Cache-Control', 'no-store');
		return res.status(200).json(usagePayload());
	}
	// Stats: daily table + weekly/monthly totals (read-only).
	if (req.query && req.query.stats === '1') {
		res.setHeader('Access-Control-Allow-Origin', allowedOrigin(origin) ? (origin || '*') : '*');
		res.setHeader('Cache-Control', 'no-store');
		return res.status(200).json(getStatsPayload());
	}

	const key = getKey();
	if (!key) {
		res.setHeader('Access-Control-Allow-Origin', origin || '*');
		return res.status(503).json({ poster: null, error: 'OMDb proxy not configured', usage: usagePayload() });
	}

	// Enforce daily OMDb limit (resets midnight UTC). Do not increment if at limit.
	if (getDailyCount() >= DAILY_LIMIT) {
		res.setHeader('Access-Control-Allow-Origin', origin || '*');
		return res.status(429).json({
			error: 'Daily API limit reached (1000). Resets at midnight UTC.',
			usage: usagePayload()
		});
	}
	incrementDaily();

	const setCors = function () {
		res.setHeader('Access-Control-Allow-Origin', allowedOrigin(origin) ? (origin || '*') : '*');
	};
	function getCategory() {
		var c = (req.query && req.query.category) ? String(req.query.category).toLowerCase().trim() : '';
		return CATEGORIES.indexOf(c) !== -1 ? c : '';
	}
	var source = getSource(req);

	// Search: s=query, optional y=year to narrow results (e.g. "Reply 1988" + y=2015 for the drama)
	const searchQuery = typeof req.query.s === 'string' ? req.query.s.trim() : '';
	const yearParam = typeof req.query.y === 'string' ? req.query.y.trim() : '';
	const year = /^(19|20)\d{2}$/.test(yearParam) ? yearParam : '';
	if (searchQuery && searchQuery.length <= MAX_TITLE_LENGTH) {
		recordRequest('search', getCategory(), source);
		try {
			let url = OMDB_BASE + '?s=' + encodeURIComponent(searchQuery) + '&apikey=' + encodeURIComponent(key);
			if (year) url += '&y=' + encodeURIComponent(year);
			const r = await fetch(url);
			const data = await r.json().catch(function () { return null; });
			const list = (data && data.Search && Array.isArray(data.Search)) ? data.Search : [];
			const results = await Promise.all(list.slice(0, 10).map(async function (item) {
				let poster = (item.Poster && item.Poster !== 'N/A' && String(item.Poster).indexOf('http') === 0) ? item.Poster : null;
				if (!poster) {
					poster = await getPremiumPosterFallback(item.imdbID, item.Title, item.Type, item.Year ? item.Year.slice(0, 4) : '');
				}
				return {
					Title: item.Title || '',
					Year: item.Year || '',
					imdbID: item.imdbID || '',
					Poster: poster,
					Type: item.Type || ''
				};
			}));
			setCors();
			res.setHeader('Cache-Control', 'public, max-age=300');
			return res.status(200).json({ results: results, usage: usagePayload() });
		} catch (e) {
			res.setHeader('Access-Control-Allow-Origin', origin || '*');
			return res.status(502).json({ results: [], error: 'Upstream error', usage: usagePayload() });
		}
	}

	// By ID: i=imdbID
	const idQuery = typeof req.query.i === 'string' ? req.query.i.trim() : '';
	if (idQuery && /^tt\d+$/.test(idQuery)) {
		recordRequest('detail', getCategory(), source);
		try {
			const url = OMDB_BASE + '?i=' + encodeURIComponent(idQuery) + '&apikey=' + encodeURIComponent(key);
			const r = await fetch(url);
			const data = await r.json().catch(function () { return null; });
			if (!data || data.Response === 'False') {
				setCors();
				return res.status(200).json({ error: 'Not found', usage: usagePayload() });
			}
			let poster = (data.Poster && data.Poster !== 'N/A' && String(data.Poster).indexOf('http') === 0) ? data.Poster : null;
			if (!poster) {
				poster = await getPremiumPosterFallback(data.imdbID, data.Title, data.Type, data.Year ? data.Year.slice(0, 4) : '');
			}
			const out = {
				Title: data.Title || '', Year: data.Year || '', Rated: data.Rated || '', Released: data.Released || '',
				Runtime: data.Runtime || '', Genre: data.Genre || '', Director: data.Director || '', Writer: data.Writer || '',
				Actors: data.Actors || '', Plot: data.Plot || '', Language: data.Language || '', Country: data.Country || '',
				Awards: data.Awards || '', BoxOffice: data.BoxOffice || '',
				Poster: poster,
				imdbRating: data.imdbRating || '', imdbID: data.imdbID || '', Type: data.Type || ''
			};
			setCors();
			res.setHeader('Cache-Control', 'public, max-age=86400');
			return res.status(200).json(Object.assign({}, out, { usage: usagePayload() }));
		} catch (e) {
			res.setHeader('Access-Control-Allow-Origin', origin || '*');
			return res.status(502).json({ error: 'Upstream error', usage: usagePayload() });
		}
	}

	// Poster by title: t=Title&type=movie|series
	const t = typeof req.query.t === 'string' ? req.query.t.trim() : '';
	if (!t || t.length > MAX_TITLE_LENGTH) {
		res.setHeader('Access-Control-Allow-Origin', origin || '*');
		return res.status(400).json({ poster: null, error: 'Missing or invalid title', usage: usagePayload() });
	}
	const type = (req.query.type === 'movie' || req.query.type === 'series') ? req.query.type : '';
	recordRequest('poster', getCategory(), source);
	const url = OMDB_BASE + '?t=' + encodeURIComponent(t) + '&apikey=' + encodeURIComponent(key) + (type ? '&type=' + type : '');
	try {
		const r = await fetch(url);
		const data = await r.json().catch(function () { return null; });
		let poster = data && data.Poster && data.Poster !== 'N/A' && String(data.Poster).indexOf('http') === 0 ? data.Poster : null;
		if (!poster) {
			poster = await getPremiumPosterFallback(data ? data.imdbID : null, t, type, data && data.Year ? data.Year.slice(0, 4) : '');
		}
		setCors();
		res.setHeader('Cache-Control', 'public, max-age=86400');
		return res.status(200).json({ poster: poster, usage: usagePayload() });
	} catch (e) {
		res.setHeader('Access-Control-Allow-Origin', origin || '*');
		return res.status(502).json({ poster: null, error: 'Upstream error', usage: usagePayload() });
	}
};
