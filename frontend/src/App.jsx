import React, { useState, useEffect, useRef } from 'react';
import { initDB, saveVideo, getVideosList, getVideoBlob, deleteVideo, clearAllCache } from './utils/db';
import { bufferVideo, formatBytes, preprocessVideoUrl, classifyVideoUrl } from './utils/downloader';
import CustomPlayer from './components/CustomPlayer';

// Clean icons with controlled size classes
const LinkIcon = () => (
  <svg className="icon-md text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
  </svg>
);

const TrashIcon = () => (
  <svg className="icon-sm" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
  </svg>
);

const PlayIcon = () => (
  <svg className="icon-sm" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);

const CloudIcon = () => (
  <svg className="icon-sm" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 00-9.78 2.096A4.001 4.001 0 003 15z" />
  </svg>
);

const InfoIcon = () => (
  <svg className="icon-md text-neutral-400" style={{ color: 'hsl(var(--text-muted))' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);

const UploadIcon = () => (
  <svg className="icon-sm" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
  </svg>
);

const BookOpenIcon = () => (
  <svg className="icon-sm" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
  </svg>
);

export default function App() {
  const [videoUrl, setVideoUrl] = useState('');
  const [isBuffering, setIsBuffering] = useState(false);
  const [progress, setProgress] = useState(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [library, setLibrary] = useState([]);
  const [activeVideo, setActiveVideo] = useState(null);
  const [showGuideModal, setShowGuideModal] = useState(false);
  const [customReferer, setCustomReferer] = useState('');
  const [customOrigin, setCustomOrigin] = useState('');
  const [showAdvancedHeaders, setShowAdvancedHeaders] = useState(true);
  
  const abortControllerRef = useRef(null);
  const isPlayerPlayingRef = useRef(false);
  const activeVideoRef = useRef(null);
  const fileInputRef = useRef(null);

  // Sync activeVideo to ref for downloader access
  useEffect(() => {
    activeVideoRef.current = activeVideo;
  }, [activeVideo]);

  // Initialize DB and fetch library list
  useEffect(() => {
    const setup = async () => {
      try {
        await initDB();
        await fetchLibrary();
      } catch (err) {
        setErrorMessage('Failed to initialize database.');
      }
    };
    setup();
    
    return () => {
      // Clean up Blob URLs on unmount
      if (activeVideo && activeVideo.blobUrl && activeVideo.blobUrl.startsWith('blob:')) {
        URL.revokeObjectURL(activeVideo.blobUrl);
      }
    };
  }, []);

  const fetchLibrary = async () => {
    try {
      const list = await getVideosList();
      setLibrary(list);
    } catch (err) {
      console.error('Error fetching library:', err);
    }
  };

  const getTitleFromUrl = (url) => {
    try {
      const parsed = new URL(url);
      const pathname = parsed.pathname;
      const lastSegment = pathname.substring(pathname.lastIndexOf('/') + 1);
      if (lastSegment && lastSegment.includes('.') && !lastSegment.includes('=')) {
        return decodeURIComponent(lastSegment);
      }
      if (parsed.hostname.includes('sharepoint.com')) {
        const uniqueId = parsed.searchParams.get('UniqueId');
        return uniqueId ? `SharePoint Recording (${uniqueId.substring(0, 8)})` : 'SharePoint Video';
      }
      return parsed.hostname + ' Video';
    } catch (e) {
      return 'Direct Video File';
    }
  };

  // Auto-detect and sync Referer/Origin only if not manually customized by the user
  const handleUrlInputChange = (val) => {
    setVideoUrl(val);
    if (!val || !val.trim()) return;
    try {
      const parsed = new URL(val.trim());
      // Only auto-fill if the user has not entered a custom referer or origin
      if (!customReferer) {
        setCustomReferer(`${parsed.origin}/`);
      }
      if (!customOrigin) {
        setCustomOrigin(parsed.origin);
      }
    } catch (e) {}
  };

  // Sync headers updated from inside the CustomPlayer error overlay
  const handleUpdateHeadersFromPlayer = (newReferer, newOrigin) => {
    setCustomReferer(newReferer);
    setCustomOrigin(newOrigin);
    if (!activeVideo || !activeVideo.directUrl) return;

    const rawBaseUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5000';
    const backendBaseUrl = rawBaseUrl.replace(/\/+$/, '');
    let newProxyUrl = `${backendBaseUrl}/api/proxy?url=${encodeURIComponent(activeVideo.directUrl)}`;
    if (newReferer && newReferer.trim()) {
      newProxyUrl += `&referer=${encodeURIComponent(newReferer.trim())}`;
    }
    if (newOrigin && newOrigin.trim()) {
      newProxyUrl += `&origin=${encodeURIComponent(newOrigin.trim())}`;
    }

    const isUsingProxy = activeVideo.blobUrl && activeVideo.blobUrl.includes('/api/proxy');
    setActiveVideo(prev => ({
      ...prev,
      proxyUrl: newProxyUrl,
      blobUrl: isUsingProxy ? newProxyUrl : prev.blobUrl,
      referer: newReferer.trim(),
      origin: newOrigin.trim()
    }));
    setStatusMessage(`Applied updated headers: Referer=${newReferer || '(none)'}`);
  };

  // Handle local video file import (e.g. downloaded SLIIT SharePoint recording)
  const handleImportLocalFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      setStatusMessage(`Importing ${file.name} to local database...`);
      const id = 'local_' + Date.now();
      const title = file.name;
      const size = file.size;
      const contentType = file.type || 'video/mp4';

      await saveVideo(id, `local://${file.name}`, title, file, size, contentType);
      await fetchLibrary();

      // Immediately play the imported video
      const localBlobUrl = URL.createObjectURL(file);
      setActiveVideo({
        id,
        title,
        blobUrl: localBlobUrl,
        isStreamingOnly: false,
        size,
        contentType
      });

      setStatusMessage(`"${title}" imported successfully to local cache!`);
      setTimeout(() => setStatusMessage(''), 3000);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      console.error('Import error:', err);
      setErrorMessage(`Failed to import local video: ${err.message}`);
      setStatusMessage('');
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleStartBuffer = async (e) => {
    e.preventDefault();
    if (!videoUrl.trim()) return;

    const cleanUrl = preprocessVideoUrl(videoUrl);
    const classification = classifyVideoUrl(cleanUrl);

    // If an HLS stream is detected, buffer mode is not applicable (it is a segmented live stream).
    // Automatically transition to instant proxy stream mode!
    if (classification.isHls || cleanUrl.toLowerCase().includes('.m3u8')) {
      setStatusMessage('HLS stream detected! Initiating instant proxy stream playback...');
      handleDirectStream(null, true);
      return;
    }

    // Reset states
    setIsBuffering(true);
    setErrorMessage('');
    setProgress(null);
    setStatusMessage('Connecting to video source...');
    
    // Create new abort controller
    abortControllerRef.current = new AbortController();

    const title = getTitleFromUrl(cleanUrl);
    const id = 'vid_' + Date.now();
    const rawBaseUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5000';
    const backendBaseUrl = rawBaseUrl.replace(/\/+$/, '');
    let proxyUrl = `${backendBaseUrl}/api/proxy?url=${encodeURIComponent(cleanUrl)}`;
    if (customReferer && customReferer.trim()) {
      proxyUrl += `&referer=${encodeURIComponent(customReferer.trim())}`;
    }
    if (customOrigin && customOrigin.trim()) {
      proxyUrl += `&origin=${encodeURIComponent(customOrigin.trim())}`;
    }

    // Play direct or proxy stream immediately while caching
    setActiveVideo({
      id,
      title,
      blobUrl: cleanUrl,
      directUrl: cleanUrl,
      proxyUrl: proxyUrl,
      isStreamingOnly: false
    });

    try {
      setStatusMessage('Buffering stream to browser cache...');
      
      const result = await bufferVideo(cleanUrl, {
        referer: customReferer,
        origin: customOrigin,
        onProgress: (progressData) => {
          setProgress(progressData);
        },
        checkThrottle: () => {
          return (
            isPlayerPlayingRef.current &&
            activeVideoRef.current &&
            activeVideoRef.current.blobUrl &&
            activeVideoRef.current.blobUrl.includes('/api/proxy')
          );
        },
        signal: abortControllerRef.current.signal
      });

      setStatusMessage('Saving to local database...');
      await saveVideo(id, cleanUrl, title, result.blob, result.size, result.contentType);
      
      setStatusMessage('Saved successfully!');
      setVideoUrl('');
      setIsBuffering(false);
      setProgress(null);
      await fetchLibrary();

      // Hot-swap player source to local stream or Blob URL
      let localSourceUrl;
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        localSourceUrl = `/stream-video/${id}`;
      } else {
        const localBlob = result.blob;
        localSourceUrl = URL.createObjectURL(localBlob);
      }

      setActiveVideo(prev => {
        if (prev && prev.id === id) {
          return {
            ...prev,
            blobUrl: localSourceUrl
          };
        } else {
          if (localSourceUrl.startsWith('blob:')) {
            URL.revokeObjectURL(localSourceUrl);
          }
          return prev;
        }
      });

    } catch (err) {
      if (err.name === 'AbortError') {
        setStatusMessage('Buffering cancelled.');
        setTimeout(() => setStatusMessage(''), 2000);
      } else {
        console.error('Buffering error:', err);
        setErrorMessage(err.message || 'Failed to buffer video. Make sure the link is a valid direct MP4 URL.');
        if (classification.type === 'sharepoint') {
          setShowGuideModal(true);
        }
      }
      setIsBuffering(false);
      setProgress(null);
    }
  };

  const handleDirectStream = (e, useProxy = false) => {
    if (e) e.preventDefault();
    if (!videoUrl.trim()) return;

    const cleanUrl = preprocessVideoUrl(videoUrl);
    const classification = classifyVideoUrl(cleanUrl);
    const isHls = cleanUrl.toLowerCase().includes('.m3u8') || classification.isHls;
    setErrorMessage('');
    setStatusMessage(
      useProxy
        ? (isHls ? 'Connecting HLS stream via Reverse Proxy...' : 'Loading stream via Proxy...')
        : 'Loading direct browser stream (Your IP)...'
    );

    const title = getTitleFromUrl(cleanUrl);
    const id = 'stream_' + Date.now();
    const rawBaseUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5000';
    const backendBaseUrl = rawBaseUrl.replace(/\/+$/, '');
    let proxyUrl = `${backendBaseUrl}/api/proxy?url=${encodeURIComponent(cleanUrl)}`;
    if (customReferer && customReferer.trim()) {
      proxyUrl += `&referer=${encodeURIComponent(customReferer.trim())}`;
    }
    if (customOrigin && customOrigin.trim()) {
      proxyUrl += `&origin=${encodeURIComponent(customOrigin.trim())}`;
    }
    // If stream is HLS (.m3u8) or user entered custom headers, it must route through Reverse Proxy to spoof headers & avoid CORS 403
    const effectiveUseProxy = useProxy || isHls || !!(customReferer && customReferer.trim()) || !!(customOrigin && customOrigin.trim());
    const streamSrc = effectiveUseProxy ? proxyUrl : cleanUrl;

    setActiveVideo({
      id,
      title,
      blobUrl: streamSrc,
      directUrl: cleanUrl,
      proxyUrl: proxyUrl,
      isStreamingOnly: true,
      referer: (customReferer || '').trim(),
      origin: (customOrigin || '').trim(),
      streamMode: effectiveUseProxy ? (isHls ? 'HLS Reverse Proxy' : 'Cloudflare Proxy') : 'Direct Browser Stream'
    });

    setVideoUrl('');
    setStatusMessage(
      effectiveUseProxy
        ? (isHls ? 'Streaming protected HLS feed via Reverse Proxy.' : 'Streaming via Cloudflare Proxy.')
        : 'Streaming directly from source (Your IP).'
    );

    setTimeout(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }, 100);
  };

  const handleSwitchStreamSource = (targetMode) => {
    if (!activeVideo) return;
    const newSrc = targetMode === 'proxy' ? activeVideo.proxyUrl : activeVideo.directUrl;
    setActiveVideo(prev => ({
      ...prev,
      blobUrl: newSrc,
      streamMode: targetMode === 'proxy' ? 'Cloudflare Proxy' : 'Direct Browser Stream'
    }));
    setStatusMessage(`Switched to ${targetMode === 'proxy' ? 'Cloudflare Proxy' : 'Direct Browser Stream (Your IP)'}.`);
  };

  const handleCancelBuffer = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  };

  const handlePlay = async (video) => {
    try {
      if (activeVideo && activeVideo.blobUrl && activeVideo.blobUrl.startsWith('blob:')) {
        URL.revokeObjectURL(activeVideo.blobUrl);
      }

      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        setActiveVideo({
          ...video,
          blobUrl: `/stream-video/${video.id}`,
          isStreamingOnly: false
        });
        setStatusMessage('');
      } else {
        setStatusMessage(`Loading ${video.title} from cache...`);
        const blob = await getVideoBlob(video.id);
        
        if (!blob) {
          throw new Error('Video cache could not be found or was deleted.');
        }

        const blobUrl = URL.createObjectURL(blob);
        setActiveVideo({
          ...video,
          blobUrl,
          isStreamingOnly: false
        });
        setStatusMessage('');
      }
      
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setErrorMessage(err.message);
      setStatusMessage('');
    }
  };

  const handleClosePlayer = () => {
    if (activeVideo && activeVideo.blobUrl && activeVideo.blobUrl.startsWith('blob:')) {
      URL.revokeObjectURL(activeVideo.blobUrl);
    }
    setActiveVideo(null);
  };

  const handleDelete = async (id, title) => {
    if (confirm(`Remove "${title}" from your cached library?`)) {
      try {
        await deleteVideo(id);
        if (activeVideo && activeVideo.id === id) {
          handleClosePlayer();
        }
        await fetchLibrary();
      } catch (err) {
        setErrorMessage('Failed to delete video.');
      }
    }
  };

  const handleClearAll = async () => {
    const totalVideos = library.length;
    if (totalVideos === 0) return;
    
    if (confirm(`Are you sure you want to clear all ${totalVideos} buffered videos? This cannot be undone.`)) {
      try {
        handleClosePlayer();
        await clearAllCache();
        await fetchLibrary();
      } catch (err) {
        setErrorMessage('Failed to clear cache.');
      }
    }
  };

  const totalCachedSize = library.reduce((acc, curr) => acc + (curr.size || 0), 0);
  const activeClassification = videoUrl ? classifyVideoUrl(videoUrl) : null;

  return (
    <div className="app-container">
      {/* Hidden File Input for Local Video Import */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleImportLocalFile}
        accept="video/mp4,video/webm,video/mkv,video/x-matroska,video/quicktime"
        style={{ display: 'none' }}
      />

      {/* Top Header */}
      <header className="app-header">
        <div className="app-title-group">
          <div className="app-title-wrapper">
            <span className="live-pulse"></span>
            <h1 className="app-title">QuantumBuffer Player</h1>
          </div>
          <p className="app-subtitle">
            Optimized offline streaming player. Buffer MP4 links into browser cache to play without internet lags.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            onClick={() => setShowGuideModal(true)}
            className="btn-secondary"
            style={{ padding: '0.45rem 0.85rem', fontSize: '0.8rem' }}
            title="How to stream protected SharePoint, SLIIT lecture recordings, and Cloud Drive files"
          >
            <BookOpenIcon /> SharePoint & Cloud Guide
          </button>

          {library.length > 0 && (
            <div className="library-summary-badge">
              <span>Library: {library.length} videos</span>
              <span className="library-summary-divider">|</span>
              <span className="library-summary-size">{formatBytes(totalCachedSize)}</span>
            </div>
          )}
        </div>
      </header>

      {/* Main Grid Section */}
      <main className="app-layout">
        
        {/* Left Side: URL input & Video Player */}
        <section className="main-column">
          
          {/* Input Panel */}
          <div className="glass-panel">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '1rem' }}>
              <h2 className="panel-header" style={{ marginBottom: 0 }}>
                <LinkIcon /> Buffer / Stream Video
              </h2>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="btn-import-file"
                title="Import downloaded lecture video from your PC for zero-buffering offline playback"
              >
                <UploadIcon /> Import Local Video (.mp4 / .webm)
              </button>
            </div>
            
            <form onSubmit={handleStartBuffer} className="buffer-form">
              <div className="input-container">
                <input
                  type="url"
                  placeholder="Paste direct MP4, HLS (.m3u8), Streamtape, or Cloud video link..."
                  value={videoUrl}
                  onChange={(e) => handleUrlInputChange(e.target.value)}
                  disabled={isBuffering}
                  required
                  className="input-field"
                />
              </div>

              {/* Presets & Header Toggle Row */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem', margin: '0.4rem 0' }}>
                <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    onClick={() => {
                      setVideoUrl('https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8');
                      setCustomReferer('https://mux.com/');
                      setCustomOrigin('https://mux.com');
                    }}
                    className="btn-secondary"
                    style={{ padding: '0.2rem 0.5rem', fontSize: '0.72rem', borderRadius: '6px' }}
                    title="Load a sample HLS stream with referer headers"
                  >
                    Load HLS (.m3u8) Demo
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setVideoUrl('https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4');
                      setCustomReferer('');
                      setCustomOrigin('');
                    }}
                    className="btn-secondary"
                    style={{ padding: '0.2rem 0.5rem', fontSize: '0.72rem', borderRadius: '6px' }}
                    title="Load standard Big Buck Bunny MP4 video"
                  >
                    Load MP4 Demo
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => setShowAdvancedHeaders(!showAdvancedHeaders)}
                  className="btn-secondary"
                  style={{ padding: '0.2rem 0.55rem', fontSize: '0.72rem', borderRadius: '6px', color: (customReferer || customOrigin) ? '#22d3ee' : 'inherit' }}
                >
                  {showAdvancedHeaders ? '▲ Hide Headers' : '▼ Spoof Headers (Referer/Origin)'}
                </button>
              </div>

              {/* Prominent Referer & Origin Headers Section */}
              {showAdvancedHeaders && (
                <div style={{
                  background: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  borderRadius: '10px',
                  padding: '0.85rem',
                  marginTop: '0.5rem',
                  marginBottom: '0.6rem'
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                    <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'hsl(var(--cyan-400))', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                      <svg className="icon-sm" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                      </svg>
                      Hotlink Protection Headers (User-Configured)
                    </span>

                    <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        onClick={() => {
                          setCustomReferer('https://surrit.com/');
                          setCustomOrigin('https://surrit.com');
                        }}
                        className="btn-secondary"
                        style={{ padding: '0.2rem 0.45rem', fontSize: '0.68rem', borderRadius: '5px' }}
                        title="Set headers for surrit.com streams"
                      >
                        surrit.com
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setCustomReferer('https://mux.com/');
                          setCustomOrigin('https://mux.com');
                        }}
                        className="btn-secondary"
                        style={{ padding: '0.2rem 0.45rem', fontSize: '0.68rem', borderRadius: '5px' }}
                        title="Set headers for mux streams"
                      >
                        mux.com
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          try {
                            const p = new URL(videoUrl.trim());
                            setCustomReferer(`${p.origin}/`);
                            setCustomOrigin(p.origin);
                          } catch (e) {}
                        }}
                        disabled={!videoUrl}
                        className="btn-secondary"
                        style={{ padding: '0.2rem 0.45rem', fontSize: '0.68rem', borderRadius: '5px' }}
                        title="Set Referer and Origin to the video host origin"
                      >
                        Auto Host
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setCustomReferer('');
                          setCustomOrigin('');
                        }}
                        className="btn-secondary"
                        style={{ padding: '0.2rem 0.45rem', fontSize: '0.68rem', borderRadius: '5px' }}
                        title="Clear Referer and Origin (Sends no custom headers)"
                      >
                        Clear
                      </button>
                    </div>
                  </div>

                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                    gap: '0.6rem'
                  }}>
                    <div>
                      <label style={{ display: 'block', fontSize: '0.7rem', fontWeight: 600, color: 'hsl(var(--text-secondary))', marginBottom: '0.25rem' }}>
                        Referer Header:
                      </label>
                      <input
                        type="text"
                        placeholder="e.g. https://surrit.com/ or https://embed-host.com/"
                        value={customReferer}
                        onChange={(e) => setCustomReferer(e.target.value)}
                        className="input-field"
                        style={{ fontSize: '0.8rem', padding: '0.4rem 0.6rem' }}
                      />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: '0.7rem', fontWeight: 600, color: 'hsl(var(--text-secondary))', marginBottom: '0.25rem' }}>
                        Origin Header:
                      </label>
                      <input
                        type="text"
                        placeholder="e.g. https://surrit.com"
                        value={customOrigin}
                        onChange={(e) => setCustomOrigin(e.target.value)}
                        className="input-field"
                        style={{ fontSize: '0.8rem', padding: '0.4rem 0.6rem' }}
                      />
                    </div>
                  </div>
                  <div style={{ fontSize: '0.68rem', color: 'hsl(var(--text-muted))', marginTop: '0.35rem', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.35rem' }}>
                    <span>Tip: Upstream reverse proxy attaches these exact headers to bypass 403 Forbidden & CORS protection.</span>
                    <span style={{ color: customReferer || customOrigin ? '#22d3ee' : 'inherit' }}>
                      Active: {customReferer || '(none)'}
                    </span>
                  </div>
                </div>
              )}

              {/* Host Classification Badge */}
              {activeClassification && activeClassification.type !== 'invalid' && (
                <div className={`url-detection-badge badge-${activeClassification.type}`}>
                  <span style={{ fontWeight: 700 }}>Host Detected:</span>
                  <span>{activeClassification.label}</span>
                  <span style={{ opacity: 0.7 }}>— {activeClassification.hint}</span>
                  {activeClassification.type === 'sharepoint' && (
                    <button
                      type="button"
                      onClick={() => setShowGuideModal(true)}
                      style={{ background: 'none', border: 'none', color: '#22d3ee', textDecoration: 'underline', cursor: 'pointer', fontSize: '0.75rem', marginLeft: '0.25rem', padding: 0 }}
                    >
                      View Tips
                    </button>
                  )}
                </div>
              )}

              <div className="form-buttons-row" style={{ flexWrap: 'wrap', gap: '0.6rem', marginTop: '0.5rem' }}>
                {/* When protected stream or custom headers are active, Reverse Proxy is primary */}
                <button
                  type="button"
                  onClick={(e) => handleDirectStream(e, true)}
                  disabled={isBuffering || !videoUrl}
                  className={(customReferer || customOrigin || videoUrl.toLowerCase().includes('.m3u8')) ? 'btn-primary' : 'btn-secondary'}
                  style={{ flex: '1 1 190px' }}
                  title="Stream through Reverse Proxy to spoof Referer and Origin headers"
                >
                  <CloudIcon /> Stream via Proxy {customReferer ? '(Spoofed)' : ''}
                </button>
                <button
                  type="button"
                  onClick={(e) => handleDirectStream(e, false)}
                  disabled={isBuffering || !videoUrl}
                  className={!(customReferer || customOrigin || videoUrl.toLowerCase().includes('.m3u8')) ? 'btn-primary' : 'btn-secondary'}
                  style={{ flex: '1 1 180px' }}
                  title="Stream directly from your browser IP (Note: browser security prevents spoofing Referer/Origin directly)"
                >
                  <PlayIcon /> Stream (Your IP)
                </button>
                <button
                  type="submit"
                  disabled={isBuffering || !videoUrl}
                  className="btn-secondary"
                  style={{ flex: '1 1 180px', borderColor: 'hsl(var(--cyan-400) / 0.4)' }}
                  title="Download and cache video to IndexedDB for stutter-free offline playback"
                >
                  {isBuffering ? 'Buffering to Cache...' : 'Buffer for Offline'}
                </button>
              </div>
            </form>

            {/* Connection and general Status Info */}
            {statusMessage && !isBuffering && (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                fontFamily: 'monospace',
                fontSize: '0.75rem',
                color: 'hsl(var(--text-secondary))',
                marginTop: '0.75rem'
              }}>
                <span className="live-pulse"></span>
                {statusMessage}
              </div>
            )}

            {/* Error Message Panel */}
            {errorMessage && (
              <div className="error-alert-box">
                <svg className="icon-md" style={{ color: '#f87171', marginTop: '0.15rem' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <div className="error-alert-content" style={{ flex: 1 }}>
                  <span className="error-alert-title">Connection / Buffering Notice</span>
                  <span className="error-alert-desc">{errorMessage}</span>
                  <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
                    <button
                      onClick={() => setShowGuideModal(true)}
                      className="btn-primary"
                      style={{ padding: '0.25rem 0.75rem', fontSize: '0.75rem' }}
                    >
                      <BookOpenIcon /> View SharePoint & Cloud Guide
                    </button>
                    {videoUrl && (
                      <button
                        onClick={(e) => handleDirectStream(e, false)}
                        className="btn-secondary"
                        style={{ padding: '0.25rem 0.75rem', fontSize: '0.75rem' }}
                      >
                        <PlayIcon /> Try Direct Stream (Your IP)
                      </button>
                    )}
                    <button 
                      onClick={() => setErrorMessage('')}
                      className="error-dismiss-btn"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Info Hint for user */}
            <div className="info-hint-box">
              <InfoIcon />
              <p>
                <strong>Pro Tip:</strong> For private <strong>SLIIT SharePoint</strong> recordings, either extract the direct media stream link via DevTools or download the video and click <strong>Import Local Video</strong> to enjoy full speed control & offline buffering.
              </p>
            </div>
          </div>

          {/* Buffering Progress Card */}
          {isBuffering && progress && (
            <div className="buffering-progress-panel">
              <div className="buffering-panel-top">
                <div className="buffering-title-group">
                  <h3 className="buffering-title">
                    <span className="live-pulse"></span>
                    Buffering Stream...
                  </h3>
                  <span className="buffering-stats">
                    Speed: {progress.speedFormatted} | ETA: {progress.etaFormatted}
                  </span>
                </div>
                
                <button
                  onClick={handleCancelBuffer}
                  className="btn-danger"
                >
                  Cancel
                </button>
              </div>

              {/* Progress details */}
              <div className="progress-bar-container">
                <div className="progress-bar-labels">
                  <span>Progress: {progress.percentage}%</span>
                  <span>{progress.loadedFormatted} / {progress.totalFormatted}</span>
                </div>
                
                <div className="progress-bar-track">
                  <div 
                    className="progress-bar-fill"
                    style={{ width: `${progress.percentage}%` }}
                  ></div>
                </div>
              </div>
            </div>
          )}

          {/* Video Player Display Container */}
          {activeVideo ? (
            <div style={{ width: '100%' }}>
              <CustomPlayer
                src={activeVideo.blobUrl}
                title={activeVideo.title}
                onClose={handleClosePlayer}
                onPlayStateChange={(playing) => {
                  isPlayerPlayingRef.current = playing;
                }}
                isStreamingOnly={activeVideo.isStreamingOnly}
                directUrl={activeVideo.directUrl}
                proxyUrl={activeVideo.proxyUrl}
                streamMode={activeVideo.streamMode}
                onSwitchSource={handleSwitchStreamSource}
                onOpenGuide={() => setShowGuideModal(true)}
                customReferer={activeVideo.referer || customReferer}
                customOrigin={activeVideo.origin || customOrigin}
                onUpdateHeaders={handleUpdateHeadersFromPlayer}
              />
            </div>
          ) : (
            <div className="player-placeholder">
              <div className="placeholder-icon-wrapper">
                <svg className="icon-xl" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </div>
              <h3 className="placeholder-title">No Video Active</h3>
              <p className="placeholder-desc">
                Choose a video from your library on the right to start watching offline, or paste a URL / import a file to stream or buffer it.
              </p>
            </div>
          )}
        </section>

        {/* Right Side: Local Library List */}
        <section className="side-column">
          <div className="glass-panel library-panel">
            
            <div className="library-panel-header">
              <div className="library-header-text">
                <h2 className="library-title">Local Cache Library</h2>
                <span className="library-subtitle">Stored securely in your browser</span>
              </div>
              
              {library.length > 0 && (
                <button
                  onClick={handleClearAll}
                  className="btn-danger"
                  style={{ padding: '0.4rem 0.75rem', fontSize: '0.75rem' }}
                >
                  Clear All
                </button>
              )}
            </div>

            {/* Video List (Scrollable) */}
            <div className="library-list">
              {library.length === 0 ? (
                <div className="empty-library">
                  <svg className="icon-xl empty-library-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                  </svg>
                  <p className="empty-library-title">Library is empty</p>
                  <p className="empty-library-desc">
                    Buffer a direct MP4 link or import a local video file to start building your library.
                  </p>
                </div>
              ) : (
                library.map((video) => {
                  const isActive = activeVideo && activeVideo.id === video.id;
                  
                  return (
                    <div 
                      key={video.id}
                      className={`video-card ${isActive ? 'active-card' : ''}`}
                      onClick={() => handlePlay(video)}
                    >
                      {/* Video Title */}
                      <div className="card-top">
                        <span className="card-tag">MP4 Video</span>
                        <h4 className="card-title" title={video.title}>
                          {video.title}
                        </h4>
                      </div>

                      {/* Video Details */}
                      <div className="card-metadata">
                        <span className="metadata-item">
                          {formatBytes(video.size)}
                        </span>
                        <span className="metadata-item">
                          {new Date(video.addedAt).toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit'
                          })}
                        </span>
                      </div>

                      {/* Play & Delete buttons */}
                      <div className="card-actions" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => handlePlay(video)}
                          className={`btn-secondary card-play-btn ${isActive ? 'active-play' : ''}`}
                        >
                          <PlayIcon /> {isActive ? 'Playing' : 'Play Offline'}
                        </button>
                        
                        <button
                          onClick={() => handleDelete(video.id, video.title)}
                          className="btn-danger"
                          style={{ padding: '0.625rem' }}
                          title="Delete Video"
                        >
                          <TrashIcon />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

          </div>
        </section>

      </main>

      {/* SharePoint & Cloud Guide Modal */}
      {showGuideModal && (
        <div className="modal-overlay" onClick={() => setShowGuideModal(false)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">
                <BookOpenIcon /> SharePoint & Cloud Streaming Guide
              </h3>
              <button 
                onClick={() => setShowGuideModal(false)}
                className="player-close-btn"
                title="Close Guide"
              >
                <svg className="icon-md fill-current" viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
              </button>
            </div>

            <div className="modal-body">
              <div style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: '0.75rem', padding: '0.85rem 1rem', fontSize: '0.85rem', color: '#fca5a5' }}>
                <strong>Why did your SharePoint link return HTTP 403?</strong>
                <p style={{ marginTop: '0.25rem', color: 'hsl(var(--text-secondary))' }}>
                  Institutional Microsoft 365 / SLIIT SharePoint videos are protected behind your student login session. External servers and proxies cannot access them without your credentials.
                </p>
              </div>

              <div className="guide-step-card">
                <div className="guide-step-header">
                  <span className="step-num">1</span>
                  <span className="step-title">Method A: Download & Import (Recommended & 100% Offline)</span>
                </div>
                <p className="step-desc">
                  Download the lecture recording directly from your SLIIT / SharePoint portal, then click <strong>"Import Local Video"</strong> in QuantumBuffer.
                </p>
                <p className="step-desc" style={{ color: '#4ade80' }}>
                  ✓ Instant zero-buffering playback • Saved in browser IndexedDB • Full scrubbing & speed controls.
                </p>
              </div>

              <div className="guide-step-card">
                <div className="guide-step-header">
                  <span className="step-num">2</span>
                  <span className="step-title">Method B: Extract Direct Media Stream from Browser DevTools</span>
                </div>
                <p className="step-desc">
                  If you want to stream directly without downloading the entire file:
                </p>
                <ol style={{ paddingLeft: '1.25rem', fontSize: '0.85rem', color: 'hsl(var(--text-secondary))', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                  <li>Open the SharePoint / MS Stream recording in your browser where you are logged in.</li>
                  <li>Press <strong>F12</strong> (or right-click → <em>Inspect</em>) and click the <strong>Network</strong> tab.</li>
                  <li>In the filter box, type <code style={{ color: '#22d3ee' }}>media</code> or <code style={{ color: '#22d3ee' }}>.mp4</code>.</li>
                  <li>Start playing the video on SharePoint. Right-click the video network request → <strong>Copy URL</strong>.</li>
                  <li>Paste that direct media stream link into QuantumBuffer!</li>
                </ol>
              </div>

              <div className="guide-step-card">
                <div className="guide-step-header">
                  <span className="step-num">3</span>
                  <span className="step-title">Google Drive & Dropbox Links</span>
                </div>
                <p className="step-desc">
                  For Google Drive files, make sure the link sharing setting is set to <strong>"Anyone with the link can view"</strong>. QuantumBuffer will automatically convert the preview link into a direct stream URL.
                </p>
              </div>
            </div>

            <div className="modal-footer">
              <button
                onClick={() => {
                  setShowGuideModal(false);
                  fileInputRef.current?.click();
                }}
                className="btn-primary"
                style={{ padding: '0.5rem 1.25rem' }}
              >
                <UploadIcon /> Import Local Video Now
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="app-footer">
        QuantumBuffer Player | Local Offline Video Buffering Tool.
      </footer>
    </div>
  );
}
