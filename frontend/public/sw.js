const DB_NAME = 'VideoCacheDB';
const STORE_BLOBS = 'blobs';
const STORE_METADATA = 'metadata';

// Activate immediately without waiting
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function getVideoBlob(id) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onerror = (e) => reject(e.target.error);
    request.onsuccess = (e) => {
      const db = e.target.result;
      try {
        const transaction = db.transaction([STORE_BLOBS], 'readonly');
        const store = transaction.objectStore(STORE_BLOBS);
        const getReq = store.get(id);
        getReq.onsuccess = () => resolve(getReq.result ? getReq.result.blob : null);
        getReq.onerror = (e) => reject(e.target.error);
      } catch (err) {
        reject(err);
      }
    };
  });
}

function getVideoMetadata(id) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onerror = (e) => reject(e.target.error);
    request.onsuccess = (e) => {
      const db = e.target.result;
      try {
        const transaction = db.transaction([STORE_METADATA], 'readonly');
        const store = transaction.objectStore(STORE_METADATA);
        const getReq = store.get(id);
        getReq.onsuccess = () => resolve(getReq.result || null);
        getReq.onerror = (e) => reject(e.target.error);
      } catch (err) {
        reject(err);
      }
    };
  });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/stream-video/')) {
    const videoId = url.pathname.substring('/stream-video/'.length);
    event.respondWith(handleVideoStreamRequest(videoId, event.request));
  }
});

async function handleVideoStreamRequest(id, request) {
  try {
    const [blob, metadata] = await Promise.all([
      getVideoBlob(id),
      getVideoMetadata(id)
    ]);

    if (!blob) {
      return new Response('Video not found in local cache', { status: 404 });
    }

    const contentType = metadata ? metadata.contentType : (blob.type || 'video/mp4');
    const totalSize = blob.size;
    const rangeHeader = request.headers.get('range');

    if (!rangeHeader) {
      return new Response(blob, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Length': totalSize.toString(),
          'Accept-Ranges': 'bytes'
        }
      });
    }

    let start = 0;
    let end = totalSize - 1;

    const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
    if (match) {
      if (match[1] === "" && match[2] !== "") {
        // Suffix range (e.g. bytes=-500)
        const suffixLength = parseInt(match[2], 10);
        start = Math.max(0, totalSize - suffixLength);
        end = totalSize - 1;
      } else {
        if (match[1] !== "") {
          start = parseInt(match[1], 10);
        }
        if (match[2] !== "") {
          end = Math.min(parseInt(match[2], 10), totalSize - 1);
        }
      }
    }

    if (isNaN(start) || isNaN(end) || start > end || start >= totalSize) {
      return new Response('Range Not Satisfiable', {
        status: 416,
        headers: {
          'Content-Range': `bytes */${totalSize}`
        }
      });
    }

    const chunk = blob.slice(start, end + 1);

    return new Response(chunk, {
      status: 206,
      headers: {
        'Content-Range': `bytes ${start}-${end}/${totalSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunk.size.toString(),
        'Content-Type': contentType
      }
    });

  } catch (err) {
    console.error('Service Worker stream error:', err);
    return new Response('Internal error: ' + err.message, { status: 500 });
  }
}
