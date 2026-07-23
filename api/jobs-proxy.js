const url = require('url');

module.exports = async (req, res) => {
	// Enable CORS
	res.setHeader('Access-Control-Allow-Credentials', true);
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
	res.setHeader(
		'Access-Control-Allow-Headers',
		'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
	);

	if (req.method === 'OPTIONS') {
		res.status(200).end();
		return;
	}

	const spaceHost = (process.env.HF_SPACE_HOST || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
	const token = (process.env.HF_READ_TOKEN || '').trim();

	if (!spaceHost) {
		res.status(500).json({ ok: false, error: 'HF_SPACE_HOST environment variable is not configured on Vercel.' });
		return;
	}

	// Determine endpoint from request path (GET /jobs, POST /refresh, GET /health)
	let targetPath = '/jobs';
	let method = 'GET';
	
	const parsedUrl = url.parse(req.url, true);
	const pathname = parsedUrl.pathname || '';
	
	if (pathname.includes('/refresh')) {
		targetPath = '/refresh';
		method = 'POST';
	} else if (pathname.includes('/health')) {
		targetPath = '/health';
		method = 'GET';
	}

	const queryString = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
	const targetUrl = `https://${spaceHost}${targetPath}${queryString}`;

	try {
		const options = {
			method: method,
			headers: {
				'Content-Type': 'application/json'
			}
		};
		if (token) {
			options.headers['Authorization'] = `Bearer ${token}`;
		}

		const response = await fetch(targetUrl, options);
		const data = await response.json();
		res.status(response.status).json(data);
	} catch (err) {
		res.status(500).json({ ok: false, error: `Proxy failed: ${err.message}` });
	}
};
