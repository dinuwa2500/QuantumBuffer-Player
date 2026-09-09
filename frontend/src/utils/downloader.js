/**
 * Formats a size in bytes to a human-readable string (e.g. 1.25 MB).
 */
export function formatBytes(bytes, decimals = 2) {
  if (!bytes || bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

/**
 * Formats seconds to a human-readable ETA (e.g. 2m 14s).
 */
export function formatETA(seconds) {
  if (!seconds || seconds === Infinity || isNaN(seconds)) return '--';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}

/**
 * Automatically transforms popular cloud sharing URLs into direct streamable/downloadable endpoints.
 */
export function preprocessVideoUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
  const trimmed = rawUrl.trim();

  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();

    // 1. Google Drive view URLs
    // E.g.: https://drive.google.com/file/d/1A2B3C4D5E/view?usp=sharing
    if (host.includes('drive.google.com')) {
      const match = parsed.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]+)/i);
      if (match) {
        return `https://drive.google.com/uc?export=download&id=${match[1]}`;
      }
    }

    // 2. Dropbox share URLs
    // E.g.: https://www.dropbox.com/s/xyz123/video.mp4?dl=0
    if (host.includes('dropbox.com')) {
      if (parsed.searchParams.get('dl') === '0') {
        parsed.searchParams.set('dl', '1');
        return parsed.toString();
      }
    }

    // 3. SharePoint & OneDrive preview URLs
    // E.g.: https://tenant.sharepoint.com/:v:/g/personal/...
    if (host.includes('sharepoint.com') || host.includes('1drv.ms') || host.includes('onedrive.live.com')) {
      if (parsed.pathname.includes('/:v:/') || parsed.pathname.includes('/:u:/')) {
        if (!parsed.searchParams.has('download')) {
          parsed.searchParams.set('download', '1');
          return parsed.toString();
        }
      }
    }

    return trimmed;
  } catch (e) {
    return trimmed;
  }
}

/**
 * Classifies a video URL to determine host characteristics and troubleshooting tips.
 */
export function classifyVideoUrl(url) {
  if (!url) return { type: 'unknown', host: '', isProtected: false };
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();

    const cleanPath = parsed.pathname.toLowerCase();
    if (cleanPath.endsWith('.m3u8') || parsed.search.toLowerCase().includes('.m3u8')) {
      return {
        type: 'hls',
        host,
        label: 'Protected HLS Stream (.m3u8)',
        isHls: true,
        isProtected: true,
        hint: 'Adaptive HTTP Live Streaming feed. Use "Play via Proxy" for hotlink bypass.'
      };
    }

    if (host.includes('sharepoint.com') || host.includes('1drv.ms') || host.includes('onedrive.live.com')) {
      return {
        type: 'sharepoint',
        host,
        label: 'Microsoft SharePoint / OneDrive',
        isProtected: true,
        hint: 'Requires SLIIT / Microsoft 365 login or direct media stream capture.'
      };
    }
    if (host.includes('drive.google.com')) {
      return {
        type: 'gdrive',
        host,
        label: 'Google Drive',
        isProtected: true,
        hint: 'Ensure link sharing is set to "Anyone with the link".'
      };
    }
    if (host.includes('tapecontent.net') || host.includes('streamtape.com')) {
      return {
        type: 'streamtape',
        host,
        label: 'Streamtape',
        isProtected: false,
        hint: 'Links are bound to client IP. Use Direct Stream (Your IP).'
      };
    }
    if (host.includes('dood') || host.includes('ds2play')) {
      return {
        type: 'dood',
        host,
        label: 'Doodstream',
        isProtected: false,
        hint: 'Uses short-lived session tokens.'
      };
    }

    return {
      type: 'direct',
      host,
      label: host || 'Direct Video Link',
      isProtected: false,
      hint: 'Direct HTTP/HTTPS video stream.'
    };
  } catch (e) {
    return { type: 'invalid', host: '', isProtected: false };
  }
}

/**
 * Buffers a video from a URL through proxy or direct browser connection.
 * 
 * @param {string} videoUrl Original MP4 url
 * @param {Object} options Options containing callbacks and abort signal
 * @param {Function} options.onProgress Callback for progress: (data) => {}
 * @param {Function} options.checkThrottle Callback to check if download should throttle for player
 * @param {AbortSignal} options.signal AbortController signal for cancellation
 */
export async function bufferVideo(videoUrl, { onProgress, checkThrottle, signal }) {
  const cleanUrl = preprocessVideoUrl(videoUrl);
  const backendBaseUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5000';
  const encodedUrl = encodeURIComponent(cleanUrl);
  const proxyUrl = `${backendBaseUrl}/api/proxy?url=${encodedUrl}`;

  const hostClassification = classifyVideoUrl(cleanUrl);

  if (hostClassification.isHls) {
    throw new Error(
      'HLS (.m3u8) feeds are dynamic multi-segment streams and cannot be cached into a single offline file. Click "Stream (Cloudflare Proxy)" or "Direct Stream" to play immediately!'
    );
  }

  let info = null;
  let useDirectDownload = false;

  // 1. First attempt to probe metadata via Proxy
  try {
    const infoRes = await fetch(`${backendBaseUrl}/api/info?url=${encodedUrl}`, { signal });
    if (infoRes.ok) {
      info = await infoRes.json();
    }
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    console.warn('Proxy metadata probe failed:', err);
  }

  // 2. If proxy was blocked or returned error, try direct browser probe
  if (!info || info.success === false) {
    try {
      const directRes = await fetch(cleanUrl, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        signal
      });

      if (directRes.ok || directRes.status === 206) {
        useDirectDownload = true;
        const contentRange = directRes.headers.get('content-range');
        const contentLength = directRes.headers.get('content-length');
        const contentType = directRes.headers.get('content-type') || 'video/mp4';
        let total = null;
        if (contentRange) {
          const parts = contentRange.split('/');
          if (parts.length > 1 && parts[1] !== '*') {
            total = parseInt(parts[1], 10);
          }
        }
        info = {
          success: true,
          contentLength: total || (contentLength ? parseInt(contentLength, 10) : null),
          contentType: contentType,
          acceptRanges: true
        };
      }
    } catch (directErr) {
      if (directErr.name === 'AbortError') throw directErr;
      
      // Construct accurate context-aware error message
      if (info && info.error) {
        throw new Error(info.error);
      }

      if (hostClassification.type === 'sharepoint') {
        throw new Error('Microsoft SharePoint / OneDrive access restricted (HTTP 403). This recording requires SLIIT / Microsoft SSO authentication. Please check our SharePoint Guide for how to capture the direct stream.');
      } else if (hostClassification.type === 'streamtape') {
        throw new Error('Streamtape links are locked to your browser\'s IP address. Please click "Stream (Your IP)" to watch directly.');
      } else if (hostClassification.type === 'gdrive') {
        throw new Error('Google Drive access was blocked. Verify the file sharing is set to "Anyone with the link can view".');
      } else {
        throw new Error('Failed to connect to video server. The remote host may require login authentication or has blocked cross-origin requests.');
      }
    }
  }

  if (!info || info.success === false) {
    throw new Error(info?.error || 'Video host rejected the request.');
  }

  const downloadEndpoint = useDirectDownload ? cleanUrl : proxyUrl;
  const totalBytes = info.contentLength;
  const contentType = info.contentType || 'video/mp4';
  const acceptRanges = info.acceptRanges;

  // Fallback to single stream if byte ranges or length are not supported
  if (!totalBytes || !acceptRanges) {
    return downloadSingleStream(downloadEndpoint, totalBytes, contentType, onProgress, signal);
  }

  // Segmented Parallel Chunk Downloader
  const CHUNK_SIZE = 3 * 1024 * 1024; // 3MB chunks
  const CONCURRENCY = 4; // 4 parallel connections
  
  const totalChunks = Math.ceil(totalBytes / CHUNK_SIZE);
  const chunks = new Array(totalChunks);
  let loadedBytes = 0;
  
  const startTime = performance.now();
  let lastTime = startTime;
  let lastLoaded = 0;
  let smoothedSpeed = 0;

  let nextChunkIndex = 0;
  let activeDownloads = 0;
  let hasFailed = false;

  return new Promise((resolve, reject) => {
    const checkProgress = () => {
      const currentTime = performance.now();
      const elapsedTime = (currentTime - startTime) / 1000;
      const intervalTime = (currentTime - lastTime) / 1000;

      if (intervalTime >= 0.5) {
        const intervalLoaded = loadedBytes - lastLoaded;
        const instantSpeed = intervalLoaded / intervalTime;
        smoothedSpeed = smoothedSpeed === 0 ? instantSpeed : (smoothedSpeed * 0.7) + (instantSpeed * 0.3);
        lastTime = currentTime;
        lastLoaded = loadedBytes;
      }

      const averageSpeed = loadedBytes / (elapsedTime || 0.1);
      const activeSpeed = smoothedSpeed || averageSpeed;
      const percentage = (loadedBytes / totalBytes) * 100;
      const remainingBytes = totalBytes - loadedBytes;
      const eta = activeSpeed > 0 ? remainingBytes / activeSpeed : 0;

      if (onProgress) {
        onProgress({
          percentage: parseFloat(percentage.toFixed(1)),
          loadedBytes,
          totalBytes,
          loadedFormatted: formatBytes(loadedBytes),
          totalFormatted: formatBytes(totalBytes),
          speedFormatted: `${formatBytes(activeSpeed)}/s`,
          etaFormatted: formatETA(eta),
          etaSeconds: eta
        });
      }
    };

    const downloadLoop = async () => {
      while (nextChunkIndex < totalChunks && !hasFailed && !signal?.aborted) {
        const isThrottled = checkThrottle ? checkThrottle() : false;
        const maxConcurrency = isThrottled ? 2 : CONCURRENCY;

        if (activeDownloads >= maxConcurrency) {
          await new Promise(r => setTimeout(r, 100));
          continue;
        }

        if (isThrottled && activeDownloads > 0) {
          await new Promise(r => setTimeout(r, 100));
          continue;
        }

        const index = nextChunkIndex++;
        activeDownloads++;

        (async () => {
          const start = index * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE - 1, totalBytes - 1);

          try {
            const segmentData = await downloadChunkWithRetry(downloadEndpoint, start, end, (bytesRead) => {
              loadedBytes += bytesRead;
              checkProgress();
            }, signal);

            chunks[index] = segmentData;
            activeDownloads--;

            // Check if download is complete
            if (nextChunkIndex >= totalChunks && activeDownloads === 0 && !hasFailed) {
              const videoBlob = new Blob(chunks, { type: contentType });
              resolve({
                blob: videoBlob,
                size: loadedBytes,
                contentType
              });
            }
          } catch (err) {
            hasFailed = true;
            activeDownloads--;
            reject(err);
          }
        })();
      }
    };

    downloadLoop();

    if (signal) {
      signal.addEventListener('abort', () => {
        hasFailed = true;
        reject(new DOMException('Aborted', 'AbortError'));
      });
    }
  });
}

/**
 * Downloads a single chunk with retry logic
 */
async function downloadChunkWithRetry(url, start, end, onProgress, signal, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Range: `bytes=${start}-${end}` },
        signal
      });

      if (!response.ok && response.status !== 206) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const reader = response.body.getReader();
      const chunks = [];
      let bytesDownloaded = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        bytesDownloaded += value.length;
        onProgress(value.length);
      }

      const segment = new Uint8Array(bytesDownloaded);
      let offset = 0;
      for (const chunk of chunks) {
        segment.set(chunk, offset);
        offset += chunk.length;
      }
      return segment;
    } catch (err) {
      if (err.name === 'AbortError' || signal?.aborted) {
        throw err;
      }
      if (attempt === retries) {
        throw new Error(`Failed to download range ${start}-${end} after ${retries} attempts: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, attempt * 500));
    }
  }
}

/**
 * Fallback to single continuous stream download
 */
async function downloadSingleStream(url, totalBytes, contentType, onProgress, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok && response.status !== 206) {
    throw new Error(`Request failed with HTTP ${response.status} (${response.statusText})`);
  }
  if (!response.body) {
    throw new Error('Response body is empty or not readable.');
  }

  const reader = response.body.getReader();
  const chunks = [];
  let loadedBytes = 0;
  const startTime = performance.now();
  let lastTime = startTime;
  let lastLoaded = 0;
  let smoothedSpeed = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    chunks.push(value);
    loadedBytes += value.length;

    const currentTime = performance.now();
    const elapsedTime = (currentTime - startTime) / 1000;
    const intervalTime = (currentTime - lastTime) / 1000;

    if (intervalTime >= 0.5) {
      const intervalLoaded = loadedBytes - lastLoaded;
      const instantSpeed = intervalLoaded / intervalTime;
      smoothedSpeed = smoothedSpeed === 0 ? instantSpeed : (smoothedSpeed * 0.7) + (instantSpeed * 0.3);
      lastTime = currentTime;
      lastLoaded = loadedBytes;
    }

    const averageSpeed = loadedBytes / (elapsedTime || 0.1);
    const activeSpeed = smoothedSpeed || averageSpeed;
    const percentage = totalBytes ? (loadedBytes / totalBytes) * 100 : 0;
    const remainingBytes = totalBytes ? totalBytes - loadedBytes : 0;
    const eta = activeSpeed > 0 ? remainingBytes / activeSpeed : 0;

    if (onProgress) {
      onProgress({
        percentage: parseFloat(percentage.toFixed(1)),
        loadedBytes,
        totalBytes,
        loadedFormatted: formatBytes(loadedBytes),
        totalFormatted: totalBytes ? formatBytes(totalBytes) : 'Unknown',
        speedFormatted: `${formatBytes(activeSpeed)}/s`,
        etaFormatted: totalBytes ? formatETA(eta) : 'Estimating...',
        etaSeconds: eta
      });
    }
  }

  const videoBlob = new Blob(chunks, { type: contentType });
  return {
    blob: videoBlob,
    size: loadedBytes,
    contentType
  };
}
