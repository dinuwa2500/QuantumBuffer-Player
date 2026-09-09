import React, { useRef, useState, useEffect } from 'react';

// Clean SVG Icons for controls
const PlayIcon = () => (
  <svg className="icon-md fill-current" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
);
const PauseIcon = () => (
  <svg className="icon-md fill-current" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
);
const VolumeHighIcon = () => (
  <svg className="icon-md fill-current" viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
);
const VolumeMuteIcon = () => (
  <svg className="icon-md fill-current" viewBox="0 0 24 24"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.21.05-.42.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>
);
const FullscreenIcon = () => (
  <svg className="icon-md fill-current" viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>
);
const ExitFullscreenIcon = () => (
  <svg className="icon-md fill-current" viewBox="0 0 24 24"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>
);
const PipIcon = () => (
  <svg className="icon-md fill-current" viewBox="0 0 24 24"><path d="M19 11h-8v6h8v-6zm4 8V4.98C23 3.88 22.1 3 21 3H3c-1.1 0-2 .88-2 1.98V19c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2zm-2 .02H3V4.97h18v14.05z"/></svg>
);
const CloseIcon = () => (
  <svg className="icon-md fill-current" viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
);
const RefreshIcon = () => (
  <svg className="icon-sm" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
  </svg>
);
const SwitchIcon = () => (
  <svg className="icon-sm" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
  </svg>
);

export default function CustomPlayer({
  src,
  title,
  onClose,
  onPlayStateChange,
  isStreamingOnly,
  directUrl,
  proxyUrl,
  streamMode,
  onSwitchSource,
  onOpenGuide
}) {
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const [playerError, setPlayerError] = useState(null);

  // Sync play state to parent
  useEffect(() => {
    if (onPlayStateChange) {
      onPlayStateChange(isPlaying);
    }
  }, [isPlaying, onPlayStateChange]);
  
  const controlsTimeoutRef = useRef(null);
  const prevSrcRef = useRef(src);
  const timeToRestoreRef = useRef(null);
  const wasPlayingRef = useRef(false);
  const hlsRef = useRef(null);

  // Helper to obtain Hls class from global window or module
  const getHlsClass = () => {
    if (typeof window !== 'undefined' && window.Hls) {
      return window.Hls;
    }
    return null;
  };

  // Helper to check if a URL represents an HLS manifest
  const isHlsUrl = (urlStr) => {
    if (!urlStr) return false;
    const lower = urlStr.toLowerCase();
    return (
      lower.includes('.m3u8') ||
      lower.includes('application%2fvnd.apple.mpegurl') ||
      lower.includes('vnd.apple.mpegurl')
    );
  };

  // Main stream loader effect (HLS vs native MP4)
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;

    setPlayerError(null);
    const isHls = isHlsUrl(src) || isHlsUrl(directUrl);
    const HlsClass = getHlsClass();

    // Destroy existing Hls instance if any
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    if (isHls && HlsClass && HlsClass.isSupported()) {
      // Clear native src to prevent browser media element conflicts
      video.removeAttribute('src');

      const hls = new HlsClass({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 90,
        fragLoadingTimeOut: 20000,
        manifestLoadingTimeOut: 20000,
      });
      hlsRef.current = hls;

      hls.loadSource(src);
      hls.attachMedia(video);

      hls.on(HlsClass.Events.MANIFEST_PARSED, () => {
        setPlayerError(null);
        if (wasPlayingRef.current) {
          video.play().catch(() => {});
        }
      });

      hls.on(HlsClass.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          switch (data.type) {
            case HlsClass.ErrorTypes.NETWORK_ERROR:
              console.warn('HLS fatal network error, attempting reload...');
              hls.startLoad();
              break;
            case HlsClass.ErrorTypes.MEDIA_ERROR:
              console.warn('HLS fatal media error, recovering...');
              hls.recoverMediaError();
              break;
            default:
              console.error('Fatal unrecoverable HLS error:', data.details);
              setPlayerError(`HLS playback error: ${data.details || 'Stream unreachable'}`);
              hls.destroy();
              break;
          }
        }
      });
    } else if (isHls && video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari / iOS WebKit native HLS support
      video.src = src;
    } else {
      // Standard MP4 or Blob
      video.src = src;
    }

    if (prevSrcRef.current !== src) {
      if (prevSrcRef.current) {
        timeToRestoreRef.current = video.currentTime;
        wasPlayingRef.current = !video.paused;
      }
      prevSrcRef.current = src;
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [src, directUrl]);

  // Format time (seconds to MM:SS or HH:MM:SS)
  const formatTime = (timeInSeconds) => {
    if (isNaN(timeInSeconds)) return '0:00';
    const hours = Math.floor(timeInSeconds / 3600);
    const minutes = Math.floor((timeInSeconds % 3600) / 60);
    const seconds = Math.floor(timeInSeconds % 60);

    const pad = (num) => String(num).padStart(2, '0');

    if (hours > 0) {
      return `${hours}:${pad(minutes)}:${pad(seconds)}`;
    }
    return `${minutes}:${pad(seconds)}`;
  };

  // Helper to diagnose target URL host
  const getHostFromUrl = (urlStr) => {
    if (!urlStr) return '';
    try {
      // If it's a proxy url, extract the inner url
      if (urlStr.includes('url=')) {
        const match = urlStr.match(/url=([^&]+)/);
        if (match) {
          const inner = decodeURIComponent(match[1]);
          return new URL(inner).hostname.toLowerCase();
        }
      }
      return new URL(urlStr).hostname.toLowerCase();
    } catch (e) {
      return '';
    }
  };

  // Toggle Play / Pause
  const togglePlay = () => {
    if (!videoRef.current) return;
    if (playerError) {
      handleRetry();
      return;
    }
    if (isPlaying) {
      videoRef.current.pause();
    } else {
      videoRef.current.play().catch(err => {
        console.warn('Playback failed:', err);
        if (err.name === 'NotSupportedError' || err.name === 'DOMException') {
          const host = getHostFromUrl(directUrl || src);
          if (host.includes('sharepoint.com') || host.includes('1drv.ms')) {
            setPlayerError('Microsoft SharePoint / OneDrive access restricted. This file requires your SLIIT / Microsoft 365 login or direct media stream capture.');
          } else if (host.includes('tapecontent.net') || host.includes('streamtape.com')) {
            setPlayerError('Streamtape links are bound to your browser\'s IP address. Click "Play Direct Stream (Your IP)" below.');
          } else {
            setPlayerError('Media resource could not be played. The remote host may require login authentication or has blocked cross-origin requests.');
          }
        }
      });
    }
  };

  // Handle Video Error Event
  const handleVideoError = (e) => {
    const mediaError = videoRef.current ? videoRef.current.error : null;
    const host = getHostFromUrl(directUrl || src);
    let message = 'Unable to play video resource.';

    if (mediaError) {
      switch (mediaError.code) {
        case 1:
          message = 'Video playback was aborted.';
          break;
        case 2:
          message = 'Network error: The video download was interrupted or blocked by the server.';
          break;
        case 3:
          message = 'Decode error: The video file is corrupted or formatted with an unsupported codec.';
          break;
        case 4:
          if (host.includes('sharepoint.com') || host.includes('1drv.ms') || host.includes('onedrive.live.com')) {
            message = 'Microsoft SharePoint / OneDrive access restricted (HTTP 403 / Login required). Institutional recordings require SLIIT / Microsoft SSO authorization or a direct media stream URL.';
          } else if (host.includes('drive.google.com')) {
            message = 'Google Drive access denied. Ensure link sharing is set to "Anyone with the link can view".';
          } else if (host.includes('tapecontent.net') || host.includes('streamtape.com')) {
            message = 'Streamtape links are locked to your browser\'s IP address. Click "Play Direct Stream (Your IP)" below to watch.';
          } else if (src && src.includes('/api/proxy')) {
            message = 'Remote video server rejected the proxy request or returned an HTML error/login page instead of video data.';
          } else {
            message = 'Media format not supported or remote server returned an error (e.g. HTTP 403 / expired token).';
          }
          break;
        default:
          message = mediaError.message || 'Media source error occurred.';
      }
    }
    console.error('HTML5 Video Error:', mediaError, message);
    setPlayerError(message);
    setIsPlaying(false);
  };

  const handleRetry = () => {
    setPlayerError(null);
    const isHls = isHlsUrl(src) || isHlsUrl(directUrl);
    if (isHls && hlsRef.current) {
      hlsRef.current.loadSource(src);
      hlsRef.current.startLoad();
      if (videoRef.current) {
        videoRef.current.play().catch(() => {});
      }
    } else if (videoRef.current) {
      videoRef.current.load();
      videoRef.current.play().catch(err => {
        console.warn('Retry play failed:', err);
      });
    }
  };

  // Handle Video Events
  const handlePlay = () => {
    setIsPlaying(true);
    setPlayerError(null);
  };
  const handlePause = () => setIsPlaying(false);
  const handleTimeUpdate = () => {
    if (videoRef.current) {
      setCurrentTime(videoRef.current.currentTime);
    }
  };
  const handleLoadedMetadata = () => {
    if (videoRef.current) {
      setDuration(videoRef.current.duration);
      setPlayerError(null);
      if (timeToRestoreRef.current !== null) {
        videoRef.current.currentTime = timeToRestoreRef.current;
        timeToRestoreRef.current = null;
        if (wasPlayingRef.current) {
          videoRef.current.play().catch(err => console.log('Resume failed:', err));
          wasPlayingRef.current = false;
        }
      }
    }
  };

  // Seek Progress
  const handleSeek = (e) => {
    if (!videoRef.current || duration === 0) return;
    const seekTime = (parseFloat(e.target.value) / 100) * duration;
    videoRef.current.currentTime = seekTime;
    setCurrentTime(seekTime);
  };

  // Handle Volume Change
  const handleVolumeChange = (e) => {
    const newVolume = parseFloat(e.target.value);
    setVolume(newVolume);
    setIsMuted(newVolume === 0);
    if (videoRef.current) {
      videoRef.current.volume = newVolume;
      videoRef.current.muted = newVolume === 0;
    }
  };

  // Toggle Mute
  const toggleMute = () => {
    if (!videoRef.current) return;
    const newMuted = !isMuted;
    setIsMuted(newMuted);
    videoRef.current.muted = newMuted;
    if (!newMuted && volume === 0) {
      setVolume(0.5);
      videoRef.current.volume = 0.5;
    }
  };

  // Change Playback Speed
  const handleSpeedChange = (rate) => {
    setPlaybackRate(rate);
    if (videoRef.current) {
      videoRef.current.playbackRate = rate;
    }
    setShowSpeedMenu(false);
  };

  // Toggle Fullscreen
  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch((err) => {
        console.error('Error attempting to enable fullscreen:', err.message);
      });
      setIsFullscreen(true);
    } else {
      document.exitFullscreen();
      setIsFullscreen(false);
    }
  };

  // Listen to Fullscreen Change Events
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);

  // Picture in Picture
  const togglePip = async () => {
    if (!videoRef.current) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await videoRef.current.requestPictureInPicture();
      }
    } catch (err) {
      console.error('PiP failed:', err.message);
    }
  };

  // Auto Hide Controls on inactivity
  const resetControlsTimeout = () => {
    setShowControls(true);
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    
    if (isPlaying) {
      controlsTimeoutRef.current = setTimeout(() => {
        setShowControls(false);
        setShowSpeedMenu(false);
      }, 3000); // Hide controls after 3s of mouse inactivity
    }
  };

  useEffect(() => {
    resetControlsTimeout();
    return () => {
      if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    };
  }, [isPlaying]);

  // Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') {
        return;
      }

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          togglePlay();
          resetControlsTimeout();
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (videoRef.current) videoRef.current.currentTime += 5;
          resetControlsTimeout();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          if (videoRef.current) videoRef.current.currentTime -= 5;
          resetControlsTimeout();
          break;
        case 'ArrowUp':
          e.preventDefault();
          setVolume(prev => {
            const next = Math.min(prev + 0.1, 1);
            if (videoRef.current) {
              videoRef.current.volume = next;
              videoRef.current.muted = false;
            }
            setIsMuted(false);
            return next;
          });
          resetControlsTimeout();
          break;
        case 'ArrowDown':
          e.preventDefault();
          setVolume(prev => {
            const next = Math.max(prev - 0.1, 0);
            if (videoRef.current) {
              videoRef.current.volume = next;
              videoRef.current.muted = next === 0;
            }
            setIsMuted(next === 0);
            return next;
          });
          resetControlsTimeout();
          break;
        case 'KeyF':
          e.preventDefault();
          toggleFullscreen();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isPlaying, volume, isMuted, duration, playerError]);

  // Sync volume on video src change
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume;
      videoRef.current.muted = isMuted;
      videoRef.current.playbackRate = playbackRate;
    }
  }, [src]);

  const percentage = duration ? (currentTime / duration) * 100 : 0;
  const isProxyActive = src && src.includes('/api/proxy');

  return (
    <div 
      ref={containerRef}
      className="custom-player-container"
      onMouseMove={resetControlsTimeout}
      onMouseLeave={() => isPlaying && setShowControls(false)}
    >
      {/* Video Element */}
      <video
        ref={videoRef}
        className="video-element"
        onClick={togglePlay}
        onPlay={handlePlay}
        onPause={handlePause}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onError={handleVideoError}
        playsInline
      />

      {/* Top Header Overlay (Title & Close) */}
      <div className={`player-overlay-top ${showControls || playerError ? 'visible' : ''}`}>
        <div className="player-title-info">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <span className={`player-mode-tag ${(isHlsUrl(src) || isHlsUrl(directUrl)) ? 'mode-hls' : (isStreamingOnly ? (isProxyActive ? 'mode-proxy' : 'mode-direct') : 'mode-offline')}`}>
              {(isHlsUrl(src) || isHlsUrl(directUrl))
                ? (isProxyActive ? 'HLS Proxied Stream' : 'HLS Direct Stream')
                : (isStreamingOnly ? (isProxyActive ? 'Cloudflare Proxy' : 'Direct Browser Stream') : 'Offline Cached')}
            </span>

            {isStreamingOnly && onSwitchSource && directUrl && proxyUrl && (
              <button
                onClick={() => onSwitchSource(isProxyActive ? 'direct' : 'proxy')}
                className="btn-secondary"
                style={{ padding: '0.2rem 0.6rem', fontSize: '0.7rem', height: 'auto' }}
                title={isProxyActive ? 'Switch to Direct Browser stream (uses your IP)' : 'Switch to Cloudflare proxy'}
              >
                <SwitchIcon /> Switch to {isProxyActive ? 'Direct Stream' : 'Proxy Stream'}
              </button>
            )}
          </div>
          <h2 className="player-video-title">{title}</h2>
        </div>
        <button 
          onClick={onClose}
          className="player-close-btn"
          title="Close Player"
        >
          <CloseIcon />
        </button>
      </div>

      {/* Player Error Overlay */}
      {playerError && (
        <div className="player-error-overlay" style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(10, 10, 16, 0.9)',
          backdropFilter: 'blur(8px)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2rem',
          textAlign: 'center',
          zIndex: 40
        }}>
          <div style={{
            width: '3.5rem',
            height: '3.5rem',
            borderRadius: '50%',
            background: 'rgba(239, 68, 68, 0.15)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: '1rem'
          }}>
            <svg className="icon-lg" style={{ color: '#ef4444' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <h3 style={{ fontSize: '1.25rem', fontWeight: 600, color: '#f87171', marginBottom: '0.5rem' }}>
            Playback Error
          </h3>
          <p style={{ maxWidth: '460px', fontSize: '0.875rem', color: 'hsl(var(--text-secondary))', lineHeight: '1.5', marginBottom: '1.5rem' }}>
            {playerError}
          </p>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'center' }}>
            {/* Contextual actions based on detected host */}
            {(getHostFromUrl(directUrl || src).includes('sharepoint.com') || getHostFromUrl(directUrl || src).includes('1drv.ms')) && (
              <>
                {onOpenGuide && (
                  <button
                    onClick={onOpenGuide}
                    className="btn-primary"
                    style={{ padding: '0.5rem 1.25rem' }}
                  >
                    <svg className="icon-sm" fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ marginRight: '0.35rem' }}>
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    How to Stream SharePoint
                  </button>
                )}
                {directUrl && (
                  <a
                    href={directUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="btn-secondary"
                    style={{ padding: '0.5rem 1.25rem', textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
                  >
                    Open Link in New Tab
                  </a>
                )}
              </>
            )}

            {isProxyActive && directUrl && onSwitchSource && !getHostFromUrl(directUrl).includes('sharepoint.com') && (
              <button
                onClick={() => onSwitchSource('direct')}
                className="btn-primary"
                style={{ padding: '0.5rem 1.25rem' }}
              >
                <PlayIcon /> Play Direct Stream (Your IP)
              </button>
            )}

            {!isProxyActive && proxyUrl && onSwitchSource && !getHostFromUrl(directUrl).includes('sharepoint.com') && (
              <button
                onClick={() => onSwitchSource('proxy')}
                className="btn-primary"
                style={{ padding: '0.5rem 1.25rem' }}
              >
                <PlayIcon /> Try Cloudflare Proxy Stream
              </button>
            )}

            <button onClick={handleRetry} className="btn-secondary" style={{ padding: '0.5rem 1.25rem' }}>
              <RefreshIcon /> Retry
            </button>
            <button onClick={onClose} className="btn-danger" style={{ padding: '0.5rem 1.25rem' }}>
              Close Player
            </button>
          </div>
        </div>
      )}

      {/* Center Big Play Button on Pause */}
      {!isPlaying && !playerError && (
        <div className="center-play-button-overlay">
          <button 
            onClick={togglePlay}
            className="center-play-btn"
            title="Play Video"
          >
            <svg className="icon-lg fill-current" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z"/>
            </svg>
          </button>
        </div>
      )}

      {/* Bottom Controls Overlay */}
      <div className={`player-overlay-bottom ${showControls && !playerError ? 'visible' : ''}`}>
        {/* Progress Bar Container */}
        <div className="seekbar-container">
          <input
            type="range"
            min="0"
            max="100"
            value={percentage}
            onChange={handleSeek}
            className="seekbar-input"
            style={{
              background: `linear-gradient(to right, #22d3ee ${percentage}%, rgba(255, 255, 255, 0.15) ${percentage}%)`
            }}
          />
        </div>

        {/* Row: Play/Pause, Volume, Time, Speed, Fullscreen */}
        <div className="controls-row">
          
          {/* Left Controls */}
          <div className="controls-left-group">
            {/* Play/Pause */}
            <button 
              onClick={togglePlay} 
              className="control-btn"
              title={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? <PauseIcon /> : <PlayIcon />}
            </button>

            {/* Volume Control */}
            <div className="volume-control-group">
              <button 
                onClick={toggleMute} 
                className="control-btn"
                title={isMuted ? 'Unmute' : 'Mute'}
              >
                {isMuted ? <VolumeMuteIcon /> : <VolumeHighIcon />}
              </button>
              
              <div className="volume-slider-wrapper">
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={isMuted ? 0 : volume}
                  onChange={handleVolumeChange}
                  className="volume-input"
                  style={{
                    background: `linear-gradient(to right, #22d3ee ${(isMuted ? 0 : volume) * 100}%, rgba(255, 255, 255, 0.15) ${(isMuted ? 0 : volume) * 100}%)`
                  }}
                />
              </div>
            </div>

            {/* Time display */}
            <div className="time-display">
              <span>{formatTime(currentTime)}</span>
              <span className="time-divider">/</span>
              <span>{formatTime(duration)}</span>
            </div>
          </div>

          {/* Right Controls */}
          <div className="controls-right-group">
            
            {/* Playback Rate / Speed Selector */}
            <div className="speed-menu-wrapper">
              <button 
                onClick={() => setShowSpeedMenu(!showSpeedMenu)}
                className="speed-badge-btn"
                title="Playback Speed"
              >
                {playbackRate}x
              </button>
              
              {showSpeedMenu && (
                <div className="speed-dropdown">
                  {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((rate) => (
                    <button
                      key={rate}
                      onClick={() => handleSpeedChange(rate)}
                      className={`speed-option-btn ${rate === playbackRate ? 'active-speed' : ''}`}
                    >
                      {rate}x
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Picture in Picture */}
            <button 
              onClick={togglePip} 
              title="Picture in Picture"
              className="control-btn"
            >
              <PipIcon />
            </button>

            {/* Full Screen */}
            <button 
              onClick={toggleFullscreen} 
              title="Toggle Fullscreen"
              className="control-btn"
            >
              {isFullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
            </button>
          </div>

        </div>
      </div>
    </div>
  );
}
