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
 * Buffers a video from a URL through the local proxy.
 * 
 * @param {string} videoUrl Original MP4 url
 * @param {Object} options Options containing callbacks and abort signal
 * @param {Function} options.onProgress Callback for progress: (data) => {}
 * @param {AbortSignal} options.signal AbortController signal for cancellation
 */
export async function bufferVideo(videoUrl, { onProgress, checkThrottle, signal }) {
  const backendBaseUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5000';
  const encodedUrl = encodeURIComponent(videoUrl);
  
  // 1. Fetch metadata first to get Content-Length and Content-Type
  let info;
  try {
    const infoRes = await fetch(`${backendBaseUrl}/api/info?url=${encodedUrl}`, { signal });
    if (!infoRes.ok) {
      throw new Error(`Failed to fetch video info: ${infoRes.statusText}`);
    }
    info = await infoRes.json();
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    console.warn('Could not retrieve metadata, falling back to streaming defaults.', err);
    info = { contentLength: null, contentType: 'video/mp4', acceptRanges: false };
  }

  const totalBytes = info.contentLength;
  const contentType = info.contentType || 'video/mp4';
  const acceptRanges = info.acceptRanges;
  const proxyUrl = `${backendBaseUrl}/api/proxy?url=${encodedUrl}`;

  // Fallback to single stream if metadata/ranges are not supported
  if (!totalBytes || !acceptRanges) {
    return downloadSingleStream(proxyUrl, totalBytes, contentType, onProgress, signal);
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
          // Wait a small bit and check again
          await new Promise(r => setTimeout(r, 100));
          continue;
        }

        // If throttled, add a delay between chunk requests to give the player priority
        if (isThrottled && activeDownloads > 0) {
          await new Promise(r => setTimeout(r, 100));
          continue;
        }

        const index = nextChunkIndex++;
        activeDownloads++;

        // Run download in an IIFE to allow other parallel loops
        (async () => {
          const start = index * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE - 1, totalBytes - 1);

          try {
            const segmentData = await downloadChunkWithRetry(proxyUrl, start, end, (bytesRead) => {
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

    // Kick off the loop
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

      if (!response.ok) {
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
 * Graceful fallback to single continuous stream download
 */
async function downloadSingleStream(url, totalBytes, contentType, onProgress, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.statusText}`);
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
