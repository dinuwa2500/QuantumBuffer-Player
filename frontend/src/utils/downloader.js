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
export async function bufferVideo(videoUrl, { onProgress, signal }) {
  const backendBaseUrl = 'http://localhost:5000';
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
    info = { contentLength: null, contentType: 'video/mp4' };
  }

  const totalBytes = info.contentLength;
  const contentType = info.contentType || 'video/mp4';

  // 2. Fetch the stream through our proxy
  const proxyUrl = `${backendBaseUrl}/api/proxy?url=${encodedUrl}`;
  const response = await fetch(proxyUrl, { signal });
  
  if (!response.ok) {
    throw new Error(`Proxy request failed: ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error('Response body is empty or not readable.');
  }

  const reader = response.body.getReader();
  const chunks = [];
  let loadedBytes = 0;
  const startTime = performance.now();
  
  // Speed calculation variables (sliding window for smoother speed reporting)
  let lastTime = startTime;
  let lastLoaded = 0;
  let smoothedSpeed = 0; // bytes/sec

  while (true) {
    const { done, value } = await reader.read();
    
    if (done) {
      break;
    }

    chunks.push(value);
    loadedBytes += value.length;

    // Calculate speed and progress
    const currentTime = performance.now();
    const elapsedTime = (currentTime - startTime) / 1000; // total elapsed in seconds
    const intervalTime = (currentTime - lastTime) / 1000; // interval in seconds

    if (intervalTime >= 0.5) { // Update speed calculation every 500ms
      const intervalLoaded = loadedBytes - lastLoaded;
      const instantSpeed = intervalLoaded / intervalTime; // bytes per second
      
      // Apply exponential smoothing (0.7 old speed, 0.3 new speed)
      smoothedSpeed = smoothedSpeed === 0 ? instantSpeed : (smoothedSpeed * 0.7) + (instantSpeed * 0.3);
      
      lastTime = currentTime;
      lastLoaded = loadedBytes;
    }

    // Backup speed calculation in case progress is very fast or slow
    const averageSpeed = loadedBytes / (elapsedTime || 0.1); // bytes per second
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

  // 3. Compile chunks into a single Blob
  const videoBlob = new Blob(chunks, { type: contentType });
  return {
    blob: videoBlob,
    size: loadedBytes,
    contentType
  };
}
