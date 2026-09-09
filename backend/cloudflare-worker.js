// Helper to resolve a fresh stream URL directly from Streamtape for the worker's IP
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
    const res = await fetch(embedUrl, {
      headers: {
        'User-Agent': userAgent,
        'Referer': 'https://streamtape.com/',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    if (!res.ok) return null;
    const html = await res.text();

    // Look for link pattern: document.getElementById('...link').innerHTML = ...
    // E.g.: document.getElementById('robotlink').innerHTML = '//' + ('tapecontent.net/get_video?...')
    const matchLink = html.match(/document\.getElementById\(['"][a-zA-Z0-9_-]*link['"]\)\.innerHTML\s*=\s*(.+?);/i);
    if (matchLink) {
      const expr = matchLink[1];
      // Extract string parts inside quotes
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

    // Secondary fallback regex for token pattern
    const tokenMatch = html.match(/['"](\/\/[^'"]*tapecontent\.net\/get_video\?[^'"]+)['"]/i);
    if (tokenMatch) {
      let directUrl = tokenMatch[1].trim();
      if (directUrl.startsWith('//')) directUrl = 'https:' + directUrl;
      return directUrl;
    }

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

// Rewrites an M3U8 playlist so all segment & sub-playlist URLs route through this worker proxy
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Standard CORS headers helper
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Range, Authorization, X-Requested-With, Accept, Origin, User-Agent, X-Referer",
      "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges, Content-Type, Content-Disposition",
      "Access-Control-Max-Age": "86400",
    };

    // 1. Handle CORS preflight request
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // 2. Base health check route
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(JSON.stringify({
        status: "ok",
        message: "QuantumBuffer Cloudflare CORS Proxy is running"
      }), {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        },
      });
    }

    // 3. Extract target video URL query parameter robustly (plain or base64)
    let videoUrl = url.searchParams.get("url");
    if (!videoUrl && url.searchParams.get("b64url")) {
      try {
        videoUrl = atob(url.searchParams.get("b64url"));
      } catch (e) {}
    }
    if (!videoUrl) {
      const idx = request.url.indexOf("url=");
      if (idx !== -1) {
        try {
          videoUrl = decodeURIComponent(request.url.substring(idx + 4));
        } catch (e) {
          videoUrl = request.url.substring(idx + 4);
        }
      }
    }

    if (!videoUrl) {
      return new Response(JSON.stringify({ success: false, error: "Missing 'url' query parameter." }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // URL auto-normalization (Google Drive, Dropbox, SharePoint, etc.)
    function normalizeVideoUrl(rawUrl) {
      try {
        const u = new URL(rawUrl);
        // Google Drive /file/d/ID/view -> direct export
        if (u.hostname.includes('drive.google.com')) {
          const m = u.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]+)/i);
          if (m) {
            return `https://drive.google.com/uc?export=download&id=${m[1]}`;
          }
        }
        // Dropbox dl=0 -> dl=1
        if (u.hostname.includes('dropbox.com')) {
          if (u.searchParams.get('dl') === '0') {
            u.searchParams.set('dl', '1');
            return u.toString();
          }
        }
        // SharePoint sharing /:v:/g/ without download=1
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

    // Parse target origin and hostname for smart headers
    let targetOrigin = "";
    let targetHost = "";
    try {
      const parsedTarget = new URL(videoUrl);
      targetOrigin = parsedTarget.origin;
      targetHost = parsedTarget.hostname.toLowerCase();
    } catch (e) {
      return new Response(JSON.stringify({ success: false, error: "Invalid video URL provided." }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // Helper to generate precise, host-aware error messages
    function getHostErrorHint(status, statusText, headers, host) {
      const isSharePoint = host.includes("sharepoint.com") || host.includes("1drv.ms") || host.includes("onedrive.live.com");
      const isStreamtape = host.includes("tapecontent.net") || host.includes("streamtape.com");
      const isGDrive = host.includes("drive.google.com");
      const isDood = host.includes("dood") || host.includes("ds2play");

      if (isSharePoint) {
        if (status === 403 || status === 401) {
          return `Microsoft SharePoint / OneDrive access restricted (HTTP ${status}). This file requires SLIIT / Microsoft 365 login credentials or a public guest link. Check our SharePoint Guide for how to capture the direct stream.`;
        }
        return `Microsoft SharePoint returned HTTP ${status}. Verify the link is accessible.`;
      }

      if (isStreamtape) {
        if (status === 403) {
          return "Streamtape links are locked to your browser's IP address. Click 'Stream (Your IP)' to watch directly.";
        }
      }

      if (isGDrive) {
        if (status === 403 || status === 401) {
          return "Google Drive access denied. Ensure the file sharing is set to 'Anyone with the link' or file download quota hasn't been exceeded.";
        }
      }

      if (isDood && status === 403) {
        return "Doodstream link access expired or blocked. Please obtain a fresh direct stream URL.";
      }

      if (status === 403) {
        return `Remote server returned HTTP 403 Forbidden. Access to this resource is restricted or token has expired.`;
      }
      if (status === 404) {
        return `Remote video host returned HTTP 404. File not found at the specified URL.`;
      }
      return `Remote video host returned HTTP ${status} (${statusText || 'Error'}).`;
    }

    // Smart Referer & Origin determination (supports plain or base64 overrides)
    let referer = url.searchParams.get("referer") || request.headers.get("x-referer");
    if (!referer && url.searchParams.get("b64ref")) {
      try {
        referer = atob(url.searchParams.get("b64ref"));
      } catch (e) {}
    }
    if (!referer) {
      if (targetHost.includes("tapecontent.net") || targetHost.includes("streamtape")) {
        referer = "https://streamtape.com/";
      } else if (targetHost.includes("dood") || targetHost.includes("ds2play")) {
        referer = "https://doodstream.com/";
      } else if (targetOrigin) {
        referer = `${targetOrigin}/`;
      }
    }

    let customOrigin = url.searchParams.get("origin") || request.headers.get("x-origin");
    if (!customOrigin && url.searchParams.get("b64origin")) {
      try {
        customOrigin = atob(url.searchParams.get("b64origin"));
      } catch (e) {}
    }
    const finalOrigin = customOrigin || targetOrigin;

    const defaultUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

    const forwardHeaders = new Headers();
    forwardHeaders.set("User-Agent", defaultUserAgent);
    forwardHeaders.set("Accept", "*/*");
    forwardHeaders.set("Accept-Language", "en-US,en;q=0.9");
    forwardHeaders.set("Accept-Encoding", "identity;q=1, *;q=0");
    if (referer) forwardHeaders.set("Referer", referer);
    if (finalOrigin) forwardHeaders.set("Origin", finalOrigin);

    // Forward client IP headers so upstream proxies behind CDNs receive client identity
    const clientIp = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip");
    if (clientIp) {
      forwardHeaders.set("X-Forwarded-For", clientIp);
      forwardHeaders.set("X-Real-IP", clientIp);
      forwardHeaders.set("CF-Connecting-IP", clientIp);
      forwardHeaders.set("True-Client-IP", clientIp);
      forwardHeaders.set("Client-IP", clientIp);
    }

    try {
      // -------------------------------------------------------------
      // Endpoint A: Fetch Metadata (/api/info)
      // -------------------------------------------------------------
      if (url.pathname === "/api/info" || url.pathname.startsWith("/api/info")) {
        let activeFetchUrl = videoUrl;
        let response = await fetch(activeFetchUrl, {
          method: "GET",
          headers: {
            ...Object.fromEntries(forwardHeaders),
            "Range": "bytes=0-0"
          },
          redirect: "follow"
        });

        // If 403 Forbidden on Streamtape / Tapecontent, attempt auto-resolving a fresh server-signed ticket
        if (response.status === 403 && (targetHost.includes("tapecontent.net") || targetHost.includes("streamtape"))) {
          const resolvedUrl = await resolveStreamtapeDirectUrl(videoUrl, defaultUserAgent);
          if (resolvedUrl) {
            activeFetchUrl = resolvedUrl;
            response = await fetch(activeFetchUrl, {
              method: "GET",
              headers: {
                ...Object.fromEntries(forwardHeaders),
                "Range": "bytes=0-0"
              },
              redirect: "follow"
            });
          }
        }

        // If Range request failed, fallback to HEAD
        if (!response.ok && response.status !== 206) {
          response = await fetch(activeFetchUrl, {
            method: "HEAD",
            headers: forwardHeaders,
            redirect: "follow"
          });
        }

        const status = response.status;
        const contentType = (response.headers.get("content-type") || "").toLowerCase();
        const contentLength = response.headers.get("content-length");
        const contentRange = response.headers.get("content-range");
        const acceptRanges = response.headers.get("accept-ranges");

        // Check if remote host returned an error status (4xx/5xx)
        if (status >= 400) {
          const errorHint = getHostErrorHint(status, response.statusText, response.headers, targetHost);
          return new Response(JSON.stringify({
            success: false,
            error: errorHint,
            status: status,
            host: targetHost,
            contentType: contentType
          }), {
            status: 200,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        // Check if remote resource is an HLS M3U8 playlist
        if (isM3u8Resource(activeFetchUrl, contentType)) {
          return new Response(JSON.stringify({
            success: true,
            contentLength: null,
            contentType: "application/vnd.apple.mpegurl",
            acceptRanges: false,
            isHls: true,
            resolvedUrl: activeFetchUrl !== videoUrl ? activeFetchUrl : undefined,
            status: status
          }), {
            headers: {
              "Content-Type": "application/json",
              ...corsHeaders
            }
          });
        }

        // Check if response is non-media HTML or JSON error page
        const isNonMedia = contentType.includes("text/html") || contentType.includes("application/json");
        if (isNonMedia) {
          let nonMediaHint = `Remote server returned non-video content (${contentType || 'HTML/JSON'}).`;
          if (targetHost.includes("sharepoint.com") || targetHost.includes("1drv.ms")) {
            nonMediaHint = "SharePoint returned a web login page (HTML) instead of raw video stream. The video requires your institutional login or a direct media stream URL.";
          } else {
            nonMediaHint += " The URL might be a webpage, login screen, captcha, or expired token response rather than a direct MP4 stream.";
          }

          return new Response(JSON.stringify({
            success: false,
            error: nonMediaHint,
            status: 415,
            host: targetHost,
            contentType: contentType
          }), {
            status: 200,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        let totalLength = null;
        if (contentRange) {
          const parts = contentRange.split("/");
          if (parts.length > 1 && parts[1] !== "*") {
            totalLength = parseInt(parts[1], 10);
          }
        }
        if (!totalLength && contentLength && status !== 206) {
          totalLength = parseInt(contentLength, 10);
        }

        return new Response(JSON.stringify({
          success: true,
          contentLength: totalLength || null,
          contentType: contentType || "video/mp4",
          acceptRanges: acceptRanges === "bytes" || !!contentRange || status === 206,
          resolvedUrl: activeFetchUrl !== videoUrl ? activeFetchUrl : undefined,
          status: status
        }), {
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders
          }
        });
      }

      // -------------------------------------------------------------
      // Endpoint B: Proxy Stream (/api/proxy)
      // -------------------------------------------------------------
      const clientRange = request.headers.get("range");
      if (clientRange) {
        forwardHeaders.set("Range", clientRange);
      }

      let activeStreamUrl = videoUrl;
      let videoResponse = await fetch(activeStreamUrl, {
        method: request.method === "HEAD" ? "HEAD" : "GET",
        headers: forwardHeaders,
        redirect: "follow"
      });

      // Auto-resolve Streamtape link if 403 Forbidden received due to IP-lock
      if (videoResponse.status === 403 && (targetHost.includes("tapecontent.net") || targetHost.includes("streamtape"))) {
        const resolvedUrl = await resolveStreamtapeDirectUrl(videoUrl, defaultUserAgent);
        if (resolvedUrl) {
          activeStreamUrl = resolvedUrl;
          videoResponse = await fetch(activeStreamUrl, {
            method: request.method === "HEAD" ? "HEAD" : "GET",
            headers: forwardHeaders,
            redirect: "follow"
          });
        }
      }

      const contentType = (videoResponse.headers.get("content-type") || "").toLowerCase();
      const isPlaylist = isM3u8Resource(activeStreamUrl, contentType);

      // =============================================================
      // BRANCH A: M3U8 Playlist (Rewrite all nested segments)
      // =============================================================
      if (isPlaylist) {
        const playlistText = await videoResponse.text();
        const trimmed = playlistText.trim();
        const isHtml = trimmed.startsWith("<!DOCTYPE") ||
                       trimmed.startsWith("<html") ||
                       trimmed.includes("Attention Required! | Cloudflare") ||
                       trimmed.includes("cf-wrapper");

        if (isHtml || (!trimmed.startsWith("#EXTM3U") && !trimmed.includes("#EXT"))) {
          let errorMsg = `Remote host (${new URL(activeStreamUrl).hostname}) returned non-playlist HTML response.`;
          if (trimmed.includes("Cloudflare") || trimmed.includes("Attention Required")) {
            errorMsg = `Remote host (${new URL(activeStreamUrl).hostname}) blocked the proxy server with Cloudflare protection. Click 'Play Direct Stream (Your IP)' below to stream directly without proxy.`;
          }
          return new Response(JSON.stringify({ success: false, error: errorMsg, isCloudflareBlock: true }), {
            status: 403,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        const rewritten = rewriteM3u8Playlist(playlistText, activeStreamUrl, url.pathname, {
          referer,
          origin: finalOrigin
        });

        const playlistHeaders = new Headers();
        for (const [key, val] of Object.entries(corsHeaders)) {
          playlistHeaders.set(key, val);
        }
        playlistHeaders.set("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
        playlistHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");
        playlistHeaders.set("Pragma", "no-cache");
        playlistHeaders.set("Expires", "0");

        return new Response(rewritten, {
          status: 200,
          headers: playlistHeaders
        });
      }

      // =============================================================
      // BRANCH B: Binary Media Chunks (.ts, .m4s, .mp4, .aac, .key)
      // =============================================================
      // Prepare response headers for browser CORS and streaming
      const responseHeaders = new Headers();
      for (const [key, val] of Object.entries(corsHeaders)) {
        responseHeaders.set(key, val);
      }

      const transferHeaders = [
        "content-type",
        "content-length",
        "content-range",
        "accept-ranges",
        "content-disposition",
        "last-modified",
        "etag"
      ];

      for (const h of transferHeaders) {
        const val = videoResponse.headers.get(h);
        if (val) {
          responseHeaders.set(h, val);
        }
      }

      const finalContentType = getMediaContentType(activeStreamUrl, contentType);
      responseHeaders.set("Content-Type", finalContentType);

      // Binary media chunks are immutable; cache them aggressively
      const cleanActiveUrl = activeStreamUrl.split('?')[0].toLowerCase();
      if (
        cleanActiveUrl.endsWith('.ts') ||
        cleanActiveUrl.endsWith('.m4s') ||
        cleanActiveUrl.endsWith('.aac') ||
        cleanActiveUrl.endsWith('.key')
      ) {
        responseHeaders.set("Cache-Control", "public, max-age=3600, immutable");
      }

      // Ensure Accept-Ranges is exposed
      if (!responseHeaders.has("accept-ranges") && (videoResponse.status === 206 || responseHeaders.has("content-range"))) {
        responseHeaders.set("accept-ranges", "bytes");
      }

      // Stream the response directly
      return new Response(videoResponse.body, {
        status: videoResponse.status,
        statusText: videoResponse.statusText,
        headers: responseHeaders
      });

    } catch (error) {
      return new Response(JSON.stringify({
        success: false,
        error: `Proxy connection error: ${error.message}`
      }), {
        status: 502,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        }
      });
    }
  }
};
