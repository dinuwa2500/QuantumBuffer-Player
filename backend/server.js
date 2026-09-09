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

// Normalize consecutive slashes (e.g. //api/proxy -> /api/proxy)
app.use((req, res, next) => {
  if (req.url.startsWith('//')) {
    req.url = req.url.replace(/^\/+/, '/');
  }
  next();
});

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

  // URL auto-normalization (Google Drive, Dropbox, SharePoint, etc.)
  function normalizeVideoUrl(rawUrl) {
    try {
      const u = new URL(rawUrl);
      if (u.hostname.includes('drive.google.com')) {
        const m = u.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]+)/i);
        if (m) return `https://drive.google.com/uc?export=download&id=${m[1]}`;
      }
      if (u.hostname.includes('dropbox.com') && u.searchParams.get('dl') === '0') {
        u.searchParams.set('dl', '1');
        return u.toString();
      }
      if (u.hostname.includes('sharepoint.com') && (u.pathname.includes('/:v:/') || u.pathname.includes('/:u:/'))) {
        if (!u.searchParams.has('download')) {
          u.searchParams.set('download', '1');
          return u.toString();
        }
      }
      return rawUrl;
    } catch (e) {
      return rawUrl;
    }
  }

  videoUrl = normalizeVideoUrl(videoUrl);

  let targetHost = '';
  try {
    targetHost = new URL(videoUrl).hostname.toLowerCase();
  } catch (e) {}

  function getHostErrorHint(status, host) {
    const isSharePoint = host.includes('sharepoint.com') || host.includes('1drv.ms') || host.includes('onedrive.live.com');
    const isStreamtape = host.includes('tapecontent.net') || host.includes('streamtape.com');
    const isGDrive = host.includes('drive.google.com');

    if (isSharePoint) {
      if (status === 403 || status === 401) {
        return `Microsoft SharePoint / OneDrive access restricted (HTTP ${status}). This file requires SLIIT / Microsoft 365 login credentials or a public guest link.`;
      }
      return `Microsoft SharePoint returned HTTP ${status}. Verify link accessibility.`;
    }

    if (isStreamtape && status === 403) {
      return "Streamtape links are locked to your browser's IP address. Click 'Stream (Your IP)' to watch directly.";
    }

    if (isGDrive && (status === 403 || status === 401)) {
      return "Google Drive access denied. Ensure the file sharing is set to 'Anyone with the link can view'.";
    }

    if (status === 403) {
      return 'Remote server returned HTTP 403 Forbidden. Access is restricted or token has expired.';
    }
    if (status === 404) {
      return 'Remote video host returned HTTP 404. File not found at the specified URL.';
    }
    return `Remote video host returned HTTP ${status}.`;
  }

  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
  
  const customReferer = req.query.referer !== undefined ? req.query.referer : req.headers['x-referer'];
  const customOrigin = req.query.origin !== undefined ? req.query.origin : req.headers['x-origin'];

  let referer = '';
  if (customReferer !== undefined && customReferer !== null) {
    const trimmed = customReferer.trim().toLowerCase();
    if (trimmed !== 'none' && trimmed !== 'null' && trimmed !== 'blank' && trimmed !== '') {
      referer = customReferer.trim();
    }
  } else {
    referer = getSmartReferer(videoUrl);
  }

  let targetOrigin = '';
  if (customOrigin !== undefined && customOrigin !== null) {
    const trimmed = customOrigin.trim().toLowerCase();
    if (trimmed !== 'none' && trimmed !== 'null' && trimmed !== 'blank' && trimmed !== '') {
      targetOrigin = customOrigin.trim();
    }
  } else {
    try {
      targetOrigin = new URL(videoUrl).origin;
    } catch (e) {}
  }

  const headers = {
    'User-Agent': userAgent,
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Ch-Ua': '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site'
  };
  if (referer) headers['Referer'] = referer;
  if (targetOrigin) headers['Origin'] = targetOrigin;

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
      const errorHint = getHostErrorHint(status, targetHost);
      return res.json({
        success: false,
        error: errorHint,
        host: targetHost,
        status,
        contentType
      });
    }

    // Handle HLS M3U8 playlist detection
    if (isM3u8Resource(activeUrl, contentType)) {
      return res.json({
        success: true,
        contentLength: null,
        contentType: 'application/vnd.apple.mpegurl',
        acceptRanges: false,
        isHls: true,
        resolvedUrl: activeUrl !== videoUrl ? activeUrl : undefined,
        status
      });
    }

    const isNonMedia = contentType.includes('text/html') || contentType.includes('application/json');
    if (isNonMedia) {
      let nonMediaHint = `Remote server returned non-video content (${contentType || 'HTML/JSON'}).`;
      if (targetHost.includes('sharepoint.com') || targetHost.includes('1drv.ms')) {
        nonMediaHint = 'SharePoint returned a web login page (HTML) instead of raw video stream. The video requires your institutional login or a direct media stream URL.';
      } else {
        nonMediaHint += ' The link might be an HTML webpage or login screen rather than a direct video stream.';
      }

      return res.json({
        success: false,
        error: nonMediaHint,
        host: targetHost,
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

// Helper to check if URL or Content-Type corresponds to an HLS M3U8 playlist
function isM3u8Resource(url, contentType) {
  try {
    const cleanUrl = url.split('?')[0].toLowerCase();
    if (cleanUrl.endsWith('.m3u8')) return true;
  } catch (e) {}

  if (contentType) {
    const ct = contentType.toLowerCase();
    if (
      ct.includes('application/vnd.apple.mpegurl') ||
      ct.includes('application/x-mpegurl') ||
      ct.includes('audio/x-mpegurl') ||
      ct.includes('vnd.apple.mpegurl')
    ) {
      return true;
    }
  }
  return false;
}

// Helper to determine media MIME type for binary chunks
function getMediaContentType(url, upstreamContentType) {
  try {
    const cleanUrl = url.split('?')[0].toLowerCase();
    if (cleanUrl.endsWith('.ts')) return 'video/MP2T';
    if (cleanUrl.endsWith('.m4s') || cleanUrl.endsWith('.mp4')) return 'video/mp4';
    if (cleanUrl.endsWith('.aac')) return 'audio/aac';
    if (cleanUrl.endsWith('.vtt')) return 'text/vtt';
    if (cleanUrl.endsWith('.key')) return 'application/octet-stream';
  } catch (e) {}
  return upstreamContentType || 'application/octet-stream';
}

// Helper to resolve any relative URL against a base manifest URL
function resolveTargetUrl(relativeOrAbsolute, baseUrl) {
  try {
    return new URL(relativeOrAbsolute, baseUrl).toString();
  } catch (e) {
    return relativeOrAbsolute;
  }
}

// Helper to construct a proxied URL
function buildProxiedUrl(targetUrl, proxyEndpoint, options = {}) {
  const params = new URLSearchParams();
  params.set('url', targetUrl);
  if (options.referer) params.set('referer', options.referer);
  if (options.origin) params.set('origin', options.origin);
  return `${proxyEndpoint}?${params.toString()}`;
}

// Rewrites an M3U8 playlist so all segment & sub-playlist URLs route through this proxy
function rewriteM3u8Playlist(playlistText, manifestUrl, proxyEndpoint, options = {}) {
  const lines = playlistText.split(/\r?\n/);
  const rewrittenLines = [];
  const uriAttrRegex = /URI=(["'])(.*?)\1/g;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      rewrittenLines.push(line);
      continue;
    }

    if (line.startsWith('#')) {
      if (
        line.startsWith('#EXT-X-KEY') ||
        line.startsWith('#EXT-X-MAP') ||
        line.startsWith('#EXT-X-MEDIA') ||
        line.startsWith('#EXT-X-I-FRAME-STREAM-INF')
      ) {
        const rewrittenTag = line.replace(uriAttrRegex, (_match, quote, uri) => {
          const resolved = resolveTargetUrl(uri, manifestUrl);
          const proxied = buildProxiedUrl(resolved, proxyEndpoint, options);
          return `URI=${quote}${proxied}${quote}`;
        });
        rewrittenLines.push(rewrittenTag);
      } else {
        rewrittenLines.push(line);
      }
      continue;
    }

    // Media segment URL or Sub-playlist URL
    const resolvedMediaUrl = resolveTargetUrl(line, manifestUrl);
    const proxiedMediaUrl = buildProxiedUrl(resolvedMediaUrl, proxyEndpoint, options);
    rewrittenLines.push(proxiedMediaUrl);
  }

  return rewrittenLines.join('\n');
}

// Proxy stream route with HLS M3U8 rewriting & hotlink bypass
app.get('/api/proxy', async (req, res) => {
  let videoUrl = req.query.url;

  // Support base64 encoded URL
  if (!videoUrl && req.query.b64url) {
    try {
      videoUrl = Buffer.from(req.query.b64url, 'base64').toString('utf-8');
    } catch (e) {}
  }

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

  // Extract optional referer / origin overrides (plain or base64)
  let customReferer = req.query.referer !== undefined ? req.query.referer : req.headers['x-referer'];
  if (!customReferer && req.query.b64ref) {
    try {
      customReferer = Buffer.from(req.query.b64ref, 'base64').toString('utf-8');
    } catch (e) {}
  }

  let customOrigin = req.query.origin !== undefined ? req.query.origin : req.headers['x-origin'];
  if (!customOrigin && req.query.b64origin) {
    try {
      customOrigin = Buffer.from(req.query.b64origin, 'base64').toString('utf-8');
    } catch (e) {}
  }

  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

  // Determine upstream Referer header:
  // - If user explicitly passed 'none', 'null', 'blank', or empty string: send NO Referer
  // - If user entered a specific string: send that exact Referer
  // - If omitted: fallback to getSmartReferer
  let referer = '';
  if (customReferer !== undefined && customReferer !== null) {
    const trimmedRef = customReferer.trim().toLowerCase();
    if (trimmedRef === 'none' || trimmedRef === 'null' || trimmedRef === 'blank' || trimmedRef === '') {
      referer = ''; // User explicitly wants no referer header
    } else {
      referer = customReferer.trim();
    }
  } else {
    referer = getSmartReferer(videoUrl);
  }

  // Determine upstream Origin header:
  // - If user explicitly passed 'none', 'null', 'blank', or empty string: send NO Origin
  // - If user entered a specific string: send that exact Origin
  // - If omitted: fallback to target URL's origin
  let targetOrigin = '';
  if (customOrigin !== undefined && customOrigin !== null) {
    const trimmedOrig = customOrigin.trim().toLowerCase();
    if (trimmedOrig === 'none' || trimmedOrig === 'null' || trimmedOrig === 'blank' || trimmedOrig === '') {
      targetOrigin = ''; // User explicitly wants no origin header
    } else {
      targetOrigin = customOrigin.trim();
    }
  } else {
    try {
      targetOrigin = new URL(videoUrl).origin;
    } catch (e) {
      targetOrigin = '';
    }
  }

  try {
    const forwardHeaders = {
      'User-Agent': userAgent,
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Ch-Ua': '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site'
    };
    if (referer) forwardHeaders['Referer'] = referer;
    if (targetOrigin) forwardHeaders['Origin'] = targetOrigin;
    if (req.headers.range) {
      forwardHeaders['Range'] = req.headers.range;
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

    const contentType = response.headers.get('content-type') || '';
    const isPlaylist = isM3u8Resource(activeUrl, contentType);

    const responseHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range, Content-Type, Authorization, X-Requested-With, Origin, Accept, X-Referer, X-Origin',
      'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges, Content-Type, Content-Disposition',
    };

    // =========================================================================
    // BRANCH A: M3U8 Playlist (Parse & Rewrite all nested segment / sub-manifest URLs)
    // =========================================================================
    if (isPlaylist) {
      const playlistText = await response.text();
      const trimmed = playlistText.trim();
      const isHtml = trimmed.startsWith('<!DOCTYPE') ||
                     trimmed.startsWith('<html') ||
                     trimmed.includes('Attention Required! | Cloudflare') ||
                     trimmed.includes('cf-wrapper');

      if (isHtml || (!trimmed.startsWith('#EXTM3U') && !trimmed.includes('#EXT'))) {
        let errorMsg = `Remote host (${new URL(activeUrl).hostname}) returned non-playlist HTML.`;
        if (trimmed.includes('Cloudflare') || trimmed.includes('Attention Required')) {
          errorMsg = `Remote host (${new URL(activeUrl).hostname}) blocked the proxy server with Cloudflare protection. Click 'Play Direct Stream (Your IP)' below to stream directly.`;
        }
        res.writeHead(403, { ...responseHeaders, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: errorMsg, isCloudflareBlock: true }));
      }

      const proxyEndpoint = '/api/proxy';

      const rewritten = rewriteM3u8Playlist(playlistText, activeUrl, proxyEndpoint, {
        referer,
        origin: targetOrigin
      });

      responseHeaders['Content-Type'] = 'application/vnd.apple.mpegurl; charset=utf-8';
      responseHeaders['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      responseHeaders['Pragma'] = 'no-cache';
      responseHeaders['Expires'] = '0';

      res.writeHead(200, responseHeaders);
      return res.end(rewritten);
    }

    // =========================================================================
    // BRANCH B: Binary Media Chunks (.ts, .m4s, .mp4, .aac, keys)
    // =========================================================================
    const finalContentType = getMediaContentType(activeUrl, contentType);
    const contentLength = response.headers.get('content-length');
    const contentRange = response.headers.get('content-range');
    const acceptRanges = response.headers.get('accept-ranges');
    const contentDisposition = response.headers.get('content-disposition');

    if (finalContentType) responseHeaders['Content-Type'] = finalContentType;
    if (contentLength) responseHeaders['Content-Length'] = contentLength;
    if (contentRange) responseHeaders['Content-Range'] = contentRange;
    if (acceptRanges) responseHeaders['Accept-Ranges'] = acceptRanges;
    if (contentDisposition) responseHeaders['Content-Disposition'] = contentDisposition;

    // Binary media chunks are immutable and can be safely cached for 1 hour
    const cleanActiveUrl = activeUrl.split('?')[0].toLowerCase();
    if (
      cleanActiveUrl.endsWith('.ts') ||
      cleanActiveUrl.endsWith('.m4s') ||
      cleanActiveUrl.endsWith('.aac') ||
      cleanActiveUrl.endsWith('.key')
    ) {
      responseHeaders['Cache-Control'] = 'public, max-age=3600, immutable';
    }

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
