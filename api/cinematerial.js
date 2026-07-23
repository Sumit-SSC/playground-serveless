module.exports = async function handler(req, res) {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

	if (req.method === 'OPTIONS') return res.status(200).end();

	const imdbId = typeof req.query.i === 'string' ? req.query.i.trim() : '';
	const title = typeof req.query.title === 'string' ? req.query.title.trim() : '';
	const year = typeof req.query.year === 'string' ? req.query.year.trim() : '';
	const type = (req.query.type === 'series' || req.query.type === 'movie') ? req.query.type : 'movie';

	if (!title && !imdbId) {
		return res.status(400).json({ error: 'Missing title or IMDb ID.', posters: [] });
	}

	const posters = [];

	// 1. RPDB (Rating Poster Database) integration
	const rpdbKey = (process.env.RPDB_API_KEY || '').trim();
	if (rpdbKey && /^tt\d+$/.test(imdbId)) {
		const rpdbType = type === 'series' ? 'series' : 'movie';
		const rpdbUrl = `https://api.ratingposterdb.com/${rpdbKey}/${rpdbType}/poster-default/${imdbId}.jpg?fallback=true`;
		posters.push({ url: rpdbUrl, label: 'RPDB Premium' });
	}

	// 2. TMDB (The Movie Database) integration
	const tmdbKey = (process.env.TMDB_API_KEY || '').trim();
	if (tmdbKey && /^tt\d+$/.test(imdbId)) {
		try {
			const tmdbUrl = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${tmdbKey}&external_source=imdb_id`;
			const r = await fetch(tmdbUrl);
			if (r.ok) {
				const data = await r.json();
				const results = (type === 'series' ? data.tv_results : data.movie_results) || [];
				if (results.length > 0 && results[0].poster_path) {
					posters.push({
						url: `https://image.tmdb.org/t/p/w780${results[0].poster_path}`,
						label: 'TMDb HD'
					});
				}
			}
		} catch (e) {
			console.warn('TMDb fetch failed:', e.message);
		}
	}

	// 3. Fallback: Search Bing Images for alternate options
	const query = `${title} ${year} movie poster`.trim();
	const bingUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&first=1`;

	try {
		const r = await fetch(bingUrl, {
			headers: {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
				'Accept': 'text/html'
			}
		});

		if (r.ok) {
			const html = await r.text();
			const regex = /&quot;murl&quot;:&quot;(https?:\/\/[^&]+)&quot;/g;
			let match;
			
			while ((match = regex.exec(html)) !== null) {
				const imgUrl = match[1];
				if (imgUrl.startsWith('http') && !imgUrl.includes('bing.net') && !imgUrl.includes('duckduckgo')) {
					if (!posters.some(p => p.url === imgUrl)) {
						posters.push({ url: imgUrl, label: 'Web Poster' });
					}
				}
				if (posters.length >= 35) break;
			}
		}
	} catch (e) {
		console.warn('Bing Images fallback failed:', e.message);
	}

	return res.status(200).json({
		posters: posters,
		query: query,
		source: posters.length > 0 ? 'Integrated API + Web' : 'None',
		pageUrl: bingUrl
	});
};
