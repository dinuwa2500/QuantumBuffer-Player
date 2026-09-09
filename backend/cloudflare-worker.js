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

    return null;
  } catch (err) {
    console.warn('Streamtape auto-resolution error:', err);
    return null;
  }
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

    // 3. Extract target video URL query parameter robustly
    let videoUrl = url.searchParams.get("url");
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

    // Smart Referer determination
    let referer = url.searchParams.get("referer") || request.headers.get("x-referer");
    if (!referer) {
      if (targetHost.includes("tapecontent.net") || targetHost.includes("streamtape")) {
        referer = "https://streamtape.com/";
      } else if (targetHost.includes("dood") || targetHost.includes("ds2play")) {
        referer = "https://doodstream.com/";
      } else if (targetOrigin) {
        referer = `${targetOrigin}/`;
      }
    }

    const defaultUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

    const forwardHeaders = new Headers();
    forwardHeaders.set("User-Agent", defaultUserAgent);
    forwardHeaders.set("Accept", "*/*");
    forwardHeaders.set("Accept-Language", "en-US,en;q=0.9");
    forwardHeaders.set("Accept-Encoding", "identity;q=1, *;q=0");
    if (referer) forwardHeaders.set("Referer", referer);
    if (targetOrigin) forwardHeaders.set("Origin", targetOrigin);

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
