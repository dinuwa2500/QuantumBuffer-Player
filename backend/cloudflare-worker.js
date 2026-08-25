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

    // 1. Handle CORS preflight request (required for browsers)
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

    // 3. Extract the target video URL query parameter robustly
    let videoUrl = url.searchParams.get("url");
    if (!videoUrl) {
      // Fallback: extract everything after ?url= or &url=
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
    if (referer) {
      forwardHeaders.set("Referer", referer);
    }
    if (targetOrigin) {
      forwardHeaders.set("Origin", targetOrigin);
    }

    try {
      // -------------------------------------------------------------
      // Endpoint A: Fetch Metadata (/api/info)
      // -------------------------------------------------------------
      if (url.pathname === "/api/info" || url.pathname.startsWith("/api/info")) {
        // First try Range GET (bytes=0-0) which is widely supported by CDNs and storage clusters
        let response = await fetch(videoUrl, {
          method: "GET",
          headers: {
            ...Object.fromEntries(forwardHeaders),
            "Range": "bytes=0-0"
          },
          redirect: "follow"
        });

        // If Range request failed (e.g. 405 Method Not Allowed or 501), fallback to HEAD
        if (!response.ok && response.status !== 206) {
          response = await fetch(videoUrl, {
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
          let errorHint = `Remote video host returned HTTP ${status} (${response.statusText || 'Error'}).`;
          if (status === 403) {
            errorHint += " Access forbidden: The link may be expired, IP-locked, or hotlink-protected.";
          } else if (status === 404) {
            errorHint += " Video file not found at the specified URL.";
          }
          return new Response(JSON.stringify({
            success: false,
            error: errorHint,
            status: status,
            contentType: contentType
          }), {
            status: 200,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        // Check if response is non-media HTML or JSON error page
        const isNonMedia = contentType.includes("text/html") || contentType.includes("application/json");
        if (isNonMedia) {
          return new Response(JSON.stringify({
            success: false,
            error: `Remote server returned non-video content (${contentType || 'HTML/JSON'}). The URL might be a webpage, captcha, or expired token response rather than a direct MP4 stream.`,
            status: 415,
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

      const videoResponse = await fetch(videoUrl, {
        method: request.method === "HEAD" ? "HEAD" : "GET",
        headers: forwardHeaders,
        redirect: "follow"
      });

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

      // Ensure Accept-Ranges is exposed if target supports Range
      if (!responseHeaders.has("accept-ranges") && (videoResponse.status === 206 || responseHeaders.has("content-range"))) {
        responseHeaders.set("accept-ranges", "bytes");
      }

      // Stream the response directly (memory-efficient)
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
