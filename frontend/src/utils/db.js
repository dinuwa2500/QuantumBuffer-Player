const DB_NAME = 'VideoCacheDB';
const DB_VERSION = 1;
const STORE_METADATA = 'metadata';
const STORE_BLOBS = 'blobs';

export function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = (event) => {
      console.error('Database failed to open:', event.target.error);
      reject(event.target.error);
    };

    request.onsuccess = (event) => {
      resolve(event.target.result);
    };

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      
      // Create metadata store (key is url or custom id)
      if (!db.objectStoreNames.contains(STORE_METADATA)) {
        db.createObjectStore(STORE_METADATA, { keyPath: 'id' });
      }
      
      // Create blobs store (key is same id)
      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        db.createObjectStore(STORE_BLOBS, { keyPath: 'id' });
      }
    };
  });
}

export async function saveVideo(id, url, title, blob, size, contentType) {
  const db = await initDB();
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_METADATA, STORE_BLOBS], 'readwrite');
    
    transaction.onerror = (event) => {
      reject(event.target.error);
    };
    
    transaction.oncomplete = () => {
      resolve();
    };
    
    const metadataStore = transaction.objectStore(STORE_METADATA);
    const blobsStore = transaction.objectStore(STORE_BLOBS);
    
    const addedAt = Date.now();
    
    metadataStore.put({
      id,
      url,
      title,
      size,
      contentType,
      addedAt
    });
    
    blobsStore.put({
      id,
      blob
    });
  });
}

export async function getVideosList() {
  const db = await initDB();
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_METADATA], 'readonly');
    const store = transaction.objectStore(STORE_METADATA);
    const request = store.getAll();
    
    request.onsuccess = () => {
      // Sort by addedAt descending (newest first)
      const list = request.result || [];
      list.sort((a, b) => b.addedAt - a.addedAt);
      resolve(list);
    };
    
    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

export async function getVideoBlob(id) {
  const db = await initDB();
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_BLOBS], 'readonly');
    const store = transaction.objectStore(STORE_BLOBS);
    const request = store.get(id);
    
    request.onsuccess = () => {
      resolve(request.result ? request.result.blob : null);
    };
    
    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

export async function deleteVideo(id) {
  const db = await initDB();
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_METADATA, STORE_BLOBS], 'readwrite');
    
    transaction.onerror = (event) => {
      reject(event.target.error);
    };
    
    transaction.oncomplete = () => {
      resolve();
    };
    
    transaction.objectStore(STORE_METADATA).delete(id);
    transaction.objectStore(STORE_BLOBS).delete(id);
  });
}

export async function clearAllCache() {
  const db = await initDB();
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_METADATA, STORE_BLOBS], 'readwrite');
    
    transaction.onerror = (event) => {
      reject(event.target.error);
    };
    
    transaction.oncomplete = () => {
      resolve();
    };
    
    transaction.objectStore(STORE_METADATA).clear();
    transaction.objectStore(STORE_BLOBS).clear();
  });
}
