import express from 'express';
import cors from 'cors';
import axios from 'axios';

const app = express();
const PORT = process.env.PORT || 5000;

// Enable full CORS for all routes
app.use(cors({
  origin: '*',
  methods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Range', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'User-Agent', 'X-Referer'],
  exposedHeaders: ['Content-Range', 'Content-Length', 'Accept-Ranges', 'Content-Type', 'Content-Disposition']
}));

// Root route / health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'QuantumBuffer CORS Proxy Server is running' });
});

// Helper to determine smart referer
function getSmartReferer(targetUrl, customReferer) {
  if (customReferer) return customReferer;
  try {
    const parsed = new URL(targetUrl);
    const host = parsed.hostname.toLowerCase();
    if (host.includes('tapecontent.net') || host.includes('streamtape')) {
      return 'https://streamtape.com/';
    }
    if (host.includes('dood') || host.includes('ds2play')) {
      return 'https://doodstream.com/';
    }
    return `${parsed.origin}/`;
  } catch (e) {
    return '';
  }
}

// Helper to resolve Streamtape direct download link for the server's IP
async function resolveStreamtapeDirectUrl(urlOrId, userAgent) {
  try {
    let fileId = urlOrId;
    const match = urlOrId.match(/(?:streamtape\.com\/(?:v|e)\/|radosgw\/)([a-zA-Z0-9_-]+)/i);
    if (match) {
      fileId = match[1];
    } else {
      return null;
    }

    const embedUrl = `https://streamtape.com/e/${fileId}/`;
    const res = await axios.get(embedUrl, {
      headers: {
        'User-Agent': userAgent,
        'Referer': 'https://streamtape.com/',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      timeout: 10000,
      validateStatus: () => true
    });

    if (res.status >= 400) return null;
    const html = res.data;

    const matchLink = html.match(/document\.getElementById\(['"][a-zA-Z0-9_-]*link['"]\)\.innerHTML\s*=\s*(.+?);/i);
    if (matchLink) {
      const expr = matchLink[1];
      const stringParts = [];
      const strRegex = /['"]([^'"]+)['"]/g;
      let m;
      while ((m = strRegex.exec(expr)) !== null) {
        stringParts.push(m[1]);
      }
      if (stringParts.length > 0) {
        let directUrl = stringParts.join('').trim();
        if (directUrl.startsWith('//')) directUrl = 'https:' + directUrl;
        else if (!directUrl.startsWith('http')) directUrl = 'https://' + directUrl;
        return directUrl;
      }
    }

    const tokenMatch = html.match(/['"](\/\/[^'"]*tapecontent\.net\/get_video\?[^'"]+)['"]/i);
    if (tokenMatch) {
      let directUrl = tokenMatch[1].trim();
      if (directUrl.startsWith('//')) directUrl = 'https:' + directUrl;
      return directUrl;
    }

    return null;
  } catch (err) {
    console.warn('Streamtape auto-resolve error:', err.message);
    return null;
  }
}

// Route to get metadata for a video URL
app.get('/api/info', async (req, res) => {
  let videoUrl = req.query.url;
  if (!videoUrl) {
    const idx = req.originalUrl.indexOf('url=');
    if (idx !== -1) {
      try {
        videoUrl = decodeURIComponent(req.originalUrl.substring(idx + 4));
      } catch (e) {
        videoUrl = req.originalUrl.substring(idx + 4);
      }
    }
  }

  if (!videoUrl) {
    return res.status(400).json({ success: false, error: 'URL query parameter is required' });
  }

  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
  const referer = getSmartReferer(videoUrl, req.query.referer || req.headers['x-referer']);

  const headers = {
    'User-Agent': userAgent,
    'Accept': '*/*',
    'Accept-Encoding': 'identity;q=1, *;q=0'
  };
  if (referer) headers['Referer'] = referer;

  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (clientIp) {
    headers['X-Forwarded-For'] = clientIp;
    headers['X-Real-IP'] = clientIp;
  }

  try {
    let activeUrl = videoUrl;
    let response = await axios.get(activeUrl, {
      headers: { ...headers, 'Range': 'bytes=0-0' },
      timeout: 12000,
      maxRedirects: 5,
      validateStatus: () => true
    });

    if (response.status === 403 && (videoUrl.includes('tapecontent.net') || videoUrl.includes('streamtape'))) {
      const resolved = await resolveStreamtapeDirectUrl(videoUrl, userAgent);
      if (resolved) {
        activeUrl = resolved;
        response = await axios.get(activeUrl, {
          headers: { ...headers, 'Range': 'bytes=0-0' },
          timeout: 12000,
          maxRedirects: 5,
          validateStatus: () => true
        });
      }
    }

    const status = response.status;
    const contentType = (response.headers['content-type'] || '').toLowerCase();
    const contentLength = response.headers['content-length'];
    const contentRange = response.headers['content-range'];
    const acceptRanges = response.headers['accept-ranges'];

    if (status >= 400) {
      let errorHint = `Remote video host returned HTTP ${status}.`;
      if (status === 403) {
        errorHint += " Access forbidden: Streamtape links are locked to your browser's IP. Use 'Stream (Your IP)' to play directly.";
      } else if (status === 404) {
        errorHint += ' Video file not found at the specified URL.';
      }
      return res.json({
        success: false,
        error: errorHint,
        status,
        contentType
      });
    }

    const isNonMedia = contentType.includes('text/html') || contentType.includes('application/json');
    if (isNonMedia) {
      return res.json({
        success: false,
        error: `Remote server returned non-video content (${contentType || 'HTML/JSON'}). The link might be an HTML page or expired token error.`,
        status: 415,
        contentType
      });
    }

    let totalLength = null;
    if (contentRange) {
      const parts = contentRange.split('/');
      if (parts.length > 1 && parts[1] !== '*') {
        totalLength = parseInt(parts[1], 10);
      }
    }
    if (!totalLength && contentLength && status !== 206) {
      totalLength = parseInt(contentLength, 10);
    }

    res.json({
      success: true,
      contentLength: totalLength || null,
      contentType: contentType || 'video/mp4',
      acceptRanges: acceptRanges === 'bytes' || !!contentRange || status === 206,
      resolvedUrl: activeUrl !== videoUrl ? activeUrl : undefined,
      status
    });
  } catch (error) {
    console.error('Info extraction failed:', error.message);
    res.status(500).json({ success: false, error: `Could not retrieve video details: ${error.message}` });
  }
});

// Proxy stream route
app.get('/api/proxy', async (req, res) => {
  let videoUrl = req.query.url;
  if (!videoUrl) {
    const idx = req.originalUrl.indexOf('url=');
    if (idx !== -1) {
      try {
        videoUrl = decodeURIComponent(req.originalUrl.substring(idx + 4));
      } catch (e) {
        videoUrl = req.originalUrl.substring(idx + 4);
      }
    }
  }

  if (!videoUrl) {
    return res.status(400).send('URL query parameter is required');
  }

  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
  const referer = getSmartReferer(videoUrl, req.query.referer || req.headers['x-referer']);

  try {
    const forwardHeaders = {
      'User-Agent': userAgent,
      'Accept': '*/*',
      'Accept-Encoding': 'identity;q=1, *;q=0'
    };
    if (referer) forwardHeaders['Referer'] = referer;
    if (req.headers.range) {
      forwardHeaders['Range'] = req.headers.range;
    }

    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (clientIp) {
      forwardHeaders['X-Forwarded-For'] = clientIp;
      forwardHeaders['X-Real-IP'] = clientIp;
    }

    let activeUrl = videoUrl;
    let response = await fetch(activeUrl, {
      method: 'GET',
      headers: forwardHeaders,
      redirect: 'follow'
    });

    if (response.status === 403 && (videoUrl.includes('tapecontent.net') || videoUrl.includes('streamtape'))) {
      const resolved = await resolveStreamtapeDirectUrl(videoUrl, userAgent);
      if (resolved) {
        activeUrl = resolved;
        response = await fetch(activeUrl, {
          method: 'GET',
          headers: forwardHeaders,
          redirect: 'follow'
        });
      }
    }

    const responseHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges, Content-Type, Content-Disposition',
    };

    const contentType = response.headers.get('content-type');
    const contentLength = response.headers.get('content-length');
    const contentRange = response.headers.get('content-range');
    const acceptRanges = response.headers.get('accept-ranges');
    const contentDisposition = response.headers.get('content-disposition');

    if (contentType) responseHeaders['Content-Type'] = contentType;
    if (contentLength) responseHeaders['Content-Length'] = contentLength;
    if (contentRange) responseHeaders['Content-Range'] = contentRange;
    if (acceptRanges) responseHeaders['Accept-Ranges'] = acceptRanges;
    if (contentDisposition) responseHeaders['Content-Disposition'] = contentDisposition;

    if (!responseHeaders['Accept-Ranges'] && (response.status === 206 || contentRange)) {
      responseHeaders['Accept-Ranges'] = 'bytes';
    }

    res.writeHead(response.status, responseHeaders);

    const reader = response.body.getReader();
    let isClosed = false;

    req.on('close', () => {
      isClosed = true;
      reader.cancel().catch(() => {});
    });

    while (!isClosed) {
      const { done, value } = await reader.read();
      if (done) break;

      const canWrite = res.write(value);
      if (!canWrite && !isClosed) {
        await new Promise((resolve) => res.once('drain', resolve));
      }
    }
    res.end();
  } catch (error) {
    console.error('Proxy stream failed:', error.message);
    if (!res.headersSent) {
      res.status(500).send(error.message);
    }
  }
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`QuantumBuffer CORS Proxy Server running on http://localhost:${PORT}`);
  });
}

export default app;
