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
      return new Response('Video not found', { status: 404 });
    }

    const contentType = metadata ? metadata.contentType : (blob.type || 'video/mp4');
    const totalSize = blob.size;
    const rangeHeader = request.headers.get('range');

    if (!rangeHeader) {
      return new Response(blob, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Length': totalSize,
          'Accept-Ranges': 'bytes'
        }
      });
    }

    const parts = rangeHeader.replace(/bytes=/, "").split("-");
    const startStr = parts[0];
    const endStr = parts[1];

    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : totalSize - 1;

    if (start >= totalSize || end >= totalSize) {
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
        'Content-Length': chunk.size,
        'Content-Type': contentType
      }
    });

  } catch (err) {
    console.error('Service Worker stream error:', err);
    return new Response('Internal error: ' + err.message, { status: 500 });
  }
}
