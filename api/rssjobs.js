const url = require('url');

module.exports = async (req, res) => {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

	if (req.method === 'OPTIONS') return res.status(200).end();

	const q = (req.query && req.query.q) ? String(req.query.q).trim() : 'data analyst';
	const location = (req.query && req.query.location) ? String(req.query.location).trim() : 'remote';

	if (!q || !location) {
		return res.status(400).json({ ok: false, error: 'Missing query or location' });
	}

	try {
		// 1. Trigger the feed creation via POST
		await fetch('https://rssjobs.app/feeds', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
			},
			body: new URLSearchParams({ keywords: q, location }).toString(),
			signal: AbortSignal.timeout(10000)
		});

		// 2. Fetch the XML feed content
		const feedUrl = `https://rssjobs.app/feeds?keywords=${encodeURIComponent(q)}&location=${encodeURIComponent(location)}`;
		const r = await fetch(feedUrl, {
			headers: {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
				'Accept': 'application/rss+xml, text/xml'
			},
			signal: AbortSignal.timeout(15000)
		});

		if (!r.ok) {
			return res.status(502).json({ ok: false, error: `Failed to fetch from rssjobs.app: HTTP ${r.status}` });
		}

		const xml = await r.text();
		
		// Parse RSS items simply using regex
		const items = [];
		const itemBlocks = xml.match(/<item[^>]*>[\s\S]*?<\/item>/gi) || [];
		
		function stripTag(xmlBlock, tag) {
			const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>', 'i');
			const m = xmlBlock.match(re);
			if (!m) return '';
			return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
		}

		for (let i = 0; i < Math.min(itemBlocks.length, 100); i++) {
			const block = itemBlocks[i];
			const title = stripTag(block, 'title');
			const link = stripTag(block, 'link');
			const pubDate = stripTag(block, 'pubDate') || '';
			const desc = stripTag(block, 'description') || '';
			
			if (title && link) {
				let company = 'Unknown';
				let cleanTitle = title;
				if (title.includes(' at ')) {
					const parts = title.split(' at ');
					company = parts[parts.length - 1].trim();
					cleanTitle = parts.slice(0, -1).join(' at ').trim();
				}
				
				items.push({
					id: `rssjobs_${link.split('/').pop() || Math.random().toString(36).slice(2)}`,
					title: cleanTitle,
					company: company,
					location: location,
					url: link,
					description: desc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400),
					source: 'rssjobs',
					date: pubDate
				});
			}
		}

		return res.status(200).json({
			ok: true,
			query: q,
			location: location,
			count: items.length,
			jobs: items
		});

	} catch (err) {
		return res.status(500).json({ ok: false, error: `rssjobs proxy failed: ${err.message}` });
	}
};
