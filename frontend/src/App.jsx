import React, { useState, useEffect, useRef } from 'react';
import { initDB, saveVideo, getVideosList, getVideoBlob, deleteVideo, clearAllCache } from './utils/db';
import { bufferVideo, formatBytes } from './utils/downloader';
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

const InfoIcon = () => (
  <svg className="icon-md text-neutral-400" style={{ color: 'hsl(var(--text-muted))' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
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
  
  const abortControllerRef = useRef(null);
  const isPlayerPlayingRef = useRef(false);
  const activeVideoRef = useRef(null);

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
      if (lastSegment && lastSegment.includes('.')) {
        return decodeURIComponent(lastSegment);
      }
      return parsed.hostname + ' Video';
    } catch (e) {
      return 'Direct Video File';
    }
  };

  const handleStartBuffer = async (e) => {
    e.preventDefault();
    if (!videoUrl.trim()) return;

    // Reset states
    setIsBuffering(true);
    setErrorMessage('');
    setProgress(null);
    setStatusMessage('Connecting to video source...');
    
    // Create new abort controller
    abortControllerRef.current = new AbortController();

    const title = getTitleFromUrl(videoUrl);
    const id = 'vid_' + Date.now();
    const backendBaseUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5000';
    const proxyUrl = `${backendBaseUrl}/api/proxy?url=${encodeURIComponent(videoUrl)}`;

    // Play proxy stream immediately
    setActiveVideo({
      id,
      title,
      blobUrl: proxyUrl
    });

    try {
      setStatusMessage('Buffering stream to browser cache...');
      
      const result = await bufferVideo(videoUrl, {
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
      await saveVideo(id, videoUrl, title, result.blob, result.size, result.contentType);
      
      setStatusMessage('Saved successfully!');
      setVideoUrl('');
      setIsBuffering(false);
      setProgress(null);
      await fetchLibrary();

      // Hot-swap player source to local Blob
      const localBlob = result.blob;
      const localBlobUrl = URL.createObjectURL(localBlob);

      setActiveVideo(prev => {
        if (prev && prev.id === id) {
          return {
            ...prev,
            blobUrl: localBlobUrl
          };
        } else {
          URL.revokeObjectURL(localBlobUrl);
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
      }
      setIsBuffering(false);
      setProgress(null);
      // Close player if it is currently playing the buffering video
      setActiveVideo(prev => {
        if (prev && prev.id === id) {
          return null;
        }
        return prev;
      });
    }
  };

  const handleCancelBuffer = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  };

  const handlePlay = async (video) => {
    try {
      // Revoke old URL if it exists and is a local blob URL
      if (activeVideo && activeVideo.blobUrl && activeVideo.blobUrl.startsWith('blob:')) {
        URL.revokeObjectURL(activeVideo.blobUrl);
      }

      setStatusMessage(`Loading ${video.title} from cache...`);
      const blob = await getVideoBlob(video.id);
      
      if (!blob) {
        throw new Error('Video cache could not be found or was deleted.');
      }

      const blobUrl = URL.createObjectURL(blob);
      setActiveVideo({
        ...video,
        blobUrl
      });
      setStatusMessage('');
      
      // Scroll smoothly to player
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

  return (
    <div className="app-container">
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

        {library.length > 0 && (
          <div className="library-summary-badge">
            <span>Library: {library.length} videos</span>
            <span className="library-summary-divider">|</span>
            <span className="library-summary-size">{formatBytes(totalCachedSize)}</span>
          </div>
        )}
      </header>

      {/* Main Grid Section */}
      <main className="app-layout">
        
        {/* Left Side: URL input & Video Player */}
        <section className="main-column">
          
          {/* Input Panel */}
          <div className="glass-panel">
            <h2 className="panel-header">
              <LinkIcon /> Buffer New Video
            </h2>
            
            <form onSubmit={handleStartBuffer} className="buffer-form">
              <div className="input-container">
                <input
                  type="url"
                  placeholder="Paste direct MP4 video link here (e.g. https://example.com/video.mp4)"
                  value={videoUrl}
                  onChange={(e) => setVideoUrl(e.target.value)}
                  disabled={isBuffering}
                  required
                  className="input-field"
                />
                <button
                  type="submit"
                  disabled={isBuffering || !videoUrl}
                  className="btn-primary"
                >
                  {isBuffering ? 'Buffering...' : 'Start Buffer'}
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
                <div className="error-alert-content">
                  <span className="error-alert-title">Error</span>
                  <span className="error-alert-desc">{errorMessage}</span>
                  <button 
                    onClick={() => setErrorMessage('')}
                    className="error-dismiss-btn"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}

            {/* Info Hint for user */}
            <div className="info-hint-box">
              <InfoIcon />
              <p>
                <strong>Slow internet support:</strong> The video is downloaded via a local CORS proxy directly to your browser's IndexedDB. 
                Once buffering starts, your network will download the video at 2mbps. You can track progress below. Once it reaches 100%, you can watch it without any stutter.
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
                Choose a video from your library list on the right to start watching offline, or paste a URL above to cache it.
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
                    Buffer a direct MP4 link to start building your library.
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

      {/* Footer */}
      <footer className="app-footer">
        QuantumBuffer Player | Local Offline Video Buffering Tool. No server-side file downloads.
      </footer>
    </div>
  );
}
