import express from 'express';
import cors from 'cors';
import axios from 'axios';

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS for all routes
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Range', 'Authorization'],
  exposedHeaders: ['Content-Range', 'Content-Length', 'Accept-Ranges']
}));

// Root route / health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'CORS Proxy Server is running' });
});

// Route to get metadata for a video URL (Content-Length, Content-Type)
app.get('/api/info', async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) {
    return res.status(400).json({ error: 'URL query parameter is required' });
  }

  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

  try {
    // Attempt HEAD request first to fetch headers quickly
    const headResponse = await axios.head(videoUrl, {
      headers: { 'User-Agent': userAgent },
      timeout: 10000,
      validateStatus: () => true // Don't throw error on non-2xx status
    });

    if (headResponse.status >= 200 && headResponse.status < 300) {
      const contentLength = headResponse.headers['content-length'];
      const contentType = headResponse.headers['content-type'];
      return res.json({
        success: true,
        contentLength: contentLength ? parseInt(contentLength, 10) : null,
        contentType: contentType || 'video/mp4',
        acceptRanges: headResponse.headers['accept-ranges'] === 'bytes'
      });
    }

    // Fallback: If HEAD is blocked or fails, use a GET request with range bytes=0-0
    const getResponse = await axios.get(videoUrl, {
      headers: {
        'User-Agent': userAgent,
        'Range': 'bytes=0-0'
      },
      timeout: 10000
    });

    const contentRange = getResponse.headers['content-range'];
    let totalLength = null;
    if (contentRange) {
      const parts = contentRange.split('/');
      if (parts.length > 1) {
        totalLength = parseInt(parts[1], 10);
      }
    }

    res.json({
      success: true,
      contentLength: totalLength || (getResponse.headers['content-length'] ? parseInt(getResponse.headers['content-length'], 10) : null),
      contentType: getResponse.headers['content-type'] || 'video/mp4',
      acceptRanges: true
    });
  } catch (error) {
    console.error('Info extraction failed:', error.message);
    res.status(500).json({ error: `Could not retrieve video details: ${error.message}` });
  }
});

// Proxy stream route
app.get('/api/proxy', async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) {
    return res.status(400).send('URL query parameter is required');
  }

  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

  try {
    const headers = { 'User-Agent': userAgent };
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    const response = await fetch(videoUrl, {
      method: 'GET',
      headers: headers
    });

    if (!response.ok) {
      return res.status(response.status).send(`Failed to fetch video: ${response.statusText}`);
    }

    // Copy relevant headers back to the browser
    const responseHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Expose-Headers': '*',
    };

    const contentType = response.headers.get('content-type');
    const contentLength = response.headers.get('content-length');
    const contentRange = response.headers.get('content-range');
    const acceptRanges = response.headers.get('accept-ranges');

    if (contentType) responseHeaders['Content-Type'] = contentType;
    if (contentLength) responseHeaders['Content-Length'] = contentLength;
    if (contentRange) responseHeaders['Content-Range'] = contentRange;
    if (acceptRanges) responseHeaders['Accept-Ranges'] = acceptRanges;

    res.writeHead(response.status, responseHeaders);

    // Pipe the web stream to the Node.js response
    const reader = response.body.getReader();
    let isClosed = false;

    req.on('close', () => {
      isClosed = true;
      reader.cancel().catch(() => {});
    });

    // Read and write chunks
    while (!isClosed) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (error) {
    console.error('Proxy stream failed:', error.message);
    res.status(500).send(error.message);
  }
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`CORS Proxy Server running on http://localhost:${PORT}`);
  });
}

export default app;

