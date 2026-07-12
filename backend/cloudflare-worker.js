export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // 1. Handle CORS preflight request (required for browsers)
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Range, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // 2. Base health check route
    if (url.pathname === "/") {
      return new Response(JSON.stringify({ status: "ok", message: "Cloudflare CORS Proxy is running" }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // 3. Extract the target video URL query parameter
    const videoUrl = url.searchParams.get("url");
    if (!videoUrl) {
      return new Response("Missing url parameter", { status: 400 });
    }

    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

    try {
      // Endpoint A: Fetch Metadata (/api/info)
      if (url.pathname === "/api/info") {
        // Try HEAD request first for speed
        let response = await fetch(videoUrl, {
          method: "HEAD",
          headers: { "User-Agent": userAgent }
        });

        // Fallback to range request GET if HEAD is blocked
        if (!response.ok) {
          response = await fetch(videoUrl, {
            method: "GET",
            headers: {
              "User-Agent": userAgent,
              "Range": "bytes=0-0"
            }
          });
        }

        const contentLength = response.headers.get("content-length");
        const contentType = response.headers.get("content-type");
        const contentRange = response.headers.get("content-range");
        const acceptRanges = response.headers.get("accept-ranges");

        let totalLength = contentLength;
        if (contentRange) {
          const parts = contentRange.split("/");
          if (parts.length > 1) {
            totalLength = parts[1];
          }
        }

        return new Response(JSON.stringify({
          success: true,
          contentLength: totalLength ? parseInt(totalLength, 10) : null,
          contentType: contentType || "video/mp4",
          acceptRanges: acceptRanges === "bytes" || !!contentRange
        }), {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        });
      }

      // Endpoint B: Proxy Stream (/api/proxy)
      const clientHeaders = new Headers();
      clientHeaders.set("User-Agent", userAgent);
      
      const range = request.headers.get("range");
      if (range) {
        clientHeaders.set("Range", range);
      }

      // Fetch from actual video host
      const videoResponse = await fetch(videoUrl, {
        method: "GET",
        headers: clientHeaders
      });

      // Prepare response headers for browser CORS and streaming
      const responseHeaders = new Headers();
      responseHeaders.set("Access-Control-Allow-Origin", "*");
      responseHeaders.set("Access-Control-Allow-Headers", "*");
      responseHeaders.set("Access-Control-Expose-Headers", "*");

      const transferHeaders = ["content-type", "content-length", "content-range", "accept-ranges"];
      for (const h of transferHeaders) {
        const val = videoResponse.headers.get(h);
        if (val) {
          responseHeaders.set(h, val);
        }
      }

      // Stream the response directly (memory-efficient)
      return new Response(videoResponse.body, {
        status: videoResponse.status,
        statusText: videoResponse.statusText,
        headers: responseHeaders
      });

    } catch (error) {
      return new Response(error.message, {
        status: 500,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }
  }
}
