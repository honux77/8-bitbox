import { useEffect, useRef, useState } from 'react'
import './Player.css'

// Format seconds to MM:SS
const formatTime = (seconds) => {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export function Player({
  isPlaying,
  trackInfo,
  trackList,
  currentTrackIndex,
  coverImage,
  gameAuthor,
  gameSystem,
  elapsed,
  duration,
  onTogglePlayback,
  onNext,
  onPrev,
  onStop,
  onSelectTrack,
  onSeek,
  frequencyData,
  repeatMode,
  onToggleRepeat,
  shuffle,
  onToggleShuffle,
  volume = 0.8,
  onVolumeChange
}) {
  const remaining = Math.max(0, duration - elapsed)
  const progress = duration > 0 ? (elapsed / duration) * 100 : 0
  const canvasRef = useRef(null)
  const overlayCanvasRef = useRef(null)
  const [isImageExpanded, setIsImageExpanded] = useState(false)
  const [expandedImageSize, setExpandedImageSize] = useState({ width: 0, height: 0 })
  const [toastMessage, setToastMessage] = useState(null)
  const [isMuted, setIsMuted] = useState(false)
  const [volumeBeforeMute, setVolumeBeforeMute] = useState(0.8)

  // Copy current URL to clipboard
  const handleShare = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setToastMessage('URL COPIED!')
      setTimeout(() => setToastMessage(null), 2000)
    } catch (err) {
      setToastMessage('COPY FAILED')
      setTimeout(() => setToastMessage(null), 2000)
    }
  }

  // Calculate image size to fit screen while maintaining aspect ratio
  const handleImageLoad = (e) => {
    const img = e.target
    const naturalWidth = img.naturalWidth
    const naturalHeight = img.naturalHeight
    const maxWidth = window.innerWidth * 0.9
    const maxHeight = window.innerHeight * 0.9
    const scale = Math.min(maxWidth / naturalWidth, maxHeight / naturalHeight)
    setExpandedImageSize({
      width: naturalWidth * scale,
      height: naturalHeight * scale
    })
  }

  // Draw frequency spectrum on canvas when frequencyData updates
  useEffect(() => {
    if (!frequencyData) return

    const drawSpectrum = (canvas) => {
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      const w = canvas.width
      const h = canvas.height
      ctx.clearRect(0, 0, w, h)
      const bars = frequencyData.length
      const barW = w / bars
      for (let i = 0; i < bars; i++) {
        const v = frequencyData[i] ?? 0
        const barH = (v / 255) * (h - 4)
        const x = i * barW
        const y = h - barH
        ctx.fillStyle = '#00e5ff'
        ctx.fillRect(x + 2, y, barW - 4, barH)
      }
    }

    drawSpectrum(canvasRef.current)
    drawSpectrum(overlayCanvasRef.current)
  }, [frequencyData])

  return (
    <div className="player-container">
      {/* Expanded Image Overlay */}
      {isImageExpanded && coverImage && (
        <div className="image-overlay" onClick={() => setIsImageExpanded(false)}>
          <div className="overlay-content">
            {trackInfo && (
              <div className="overlay-track-info">
                <div className="overlay-title">{trackInfo.title}</div>
                {trackInfo.titleJp && <div className="overlay-title-jp">{trackInfo.titleJp}</div>}
                {trackInfo.game && <div className="overlay-game">{trackInfo.game}</div>}
                {gameSystem && <div className="overlay-system">{gameSystem}</div>}
                {gameAuthor && <div className="overlay-author">{gameAuthor}</div>}
                <div className="overlay-length">{trackInfo.length}</div>
              </div>
            )}
            <div className="expanded-image-wrapper" style={expandedImageSize.width ? {
              width: expandedImageSize.width,
              height: expandedImageSize.height
            } : {}}>
              <img
                src={`/music/${coverImage}`}
                alt="Cover Expanded"
                onLoad={handleImageLoad}
              />
            </div>
            <div className="overlay-visualizer">
              <canvas ref={overlayCanvasRef} width={512} height={80} />
            </div>
          </div>
        </div>
      )}
      {/* Now Playing */}
      <div className="now-playing">
        <div className="now-playing-label">NOW PLAYING</div>
        <div className="now-playing-content">
          {coverImage && (
            <div className="cover-image" onClick={() => setIsImageExpanded(true)}>
              <img src={`/music/${coverImage}`} alt="Cover" />
            </div>
          )}
          {trackInfo ? (
            <div className="track-info">
              <div className="track-title">{trackInfo.title}</div>
              {trackInfo.titleJp && <div className="track-title-jp">{trackInfo.titleJp}</div>}
              {gameSystem && gameSystem !== 'Unknown' && <div className="track-system">{gameSystem}</div>}
              {gameAuthor && <div className="track-author">{gameAuthor}</div>}
              <div className="track-time">
                <span className="time-elapsed">{formatTime(Math.floor(elapsed))}</span>
                <span className="time-separator"> / </span>
                <span className="time-total">{trackInfo.length}</span>
              </div>
            </div>
          ) : (
            <div className="track-info">
              <div className="track-title empty">SELECT A TRACK</div>
            </div>
          )}
        </div>
      </div>

      {/* Progress Bar */}
      {trackInfo && (
        <div
          className="progress-bar"
          onClick={(e) => {
            if (!onSeek || !duration) return
            const rect = e.currentTarget.getBoundingClientRect()
            const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
            onSeek(ratio * duration)
          }}
        >
          <div className="progress-fill" style={{ width: `${progress}%` }} />
          <div className="progress-handle" style={{ left: `${progress}%` }} />
        </div>
      )}

      {/* Controls */}
      <div className="controls">
        <button
          className={`control-btn shuffle-btn ${shuffle ? 'active' : ''}`}
          onClick={onToggleShuffle}
          title="Shuffle"
        >
          🔀
        </button>
        <button className="control-btn" onClick={onPrev} title="Previous (P)">
          ⏮
        </button>
        <button className="control-btn play-btn" onClick={onTogglePlayback} title="Play/Pause (Space)">
          {isPlaying ? '⏸' : '▶'}
        </button>
        <button className="control-btn" onClick={onNext} title="Next (N)">
          ⏭
        </button>
        <button
          className={`control-btn repeat-btn ${repeatMode !== 'off' ? 'active' : ''}`}
          onClick={onToggleRepeat}
          title={`Repeat: ${repeatMode === 'one' ? 'One' : repeatMode === 'all' ? 'All' : 'Off'}`}
        >
          {repeatMode === 'one' ? '🔂' : repeatMode === 'all' ? '🔁' : '➡️'}
        </button>
        <button className="control-btn stop-btn" onClick={onStop} title="Stop (S)">
          ⏹
        </button>
        <button className="control-btn share-btn" onClick={handleShare} title="Share URL">
          🔗
        </button>
      </div>

      {/* Volume Control */}
      <div className="volume-control">
        <button
          className="volume-icon"
          onClick={() => {
            if (isMuted) {
              setIsMuted(false)
              onVolumeChange?.(volumeBeforeMute)
            } else {
              setVolumeBeforeMute(volume)
              setIsMuted(true)
              onVolumeChange?.(0)
            }
          }}
          title={isMuted ? 'Unmute' : 'Mute'}
        >
          {isMuted || volume === 0 ? '🔇' : volume < 0.5 ? '🔈' : '🔊'}
        </button>
        <div
          className="volume-bar"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
            onVolumeChange?.(ratio)
            setIsMuted(false)
          }}
        >
          <div className="volume-fill" style={{ width: `${(isMuted ? 0 : volume) * 100}%` }} />
          <div className="volume-handle" style={{ left: `${(isMuted ? 0 : volume) * 100}%` }} />
        </div>
        <span className="volume-percent">{Math.round((isMuted ? 0 : volume) * 100)}%</span>
      </div>

      {/* Toast Message */}
      {toastMessage && (
        <div className="toast-message">{toastMessage}</div>
      )}

      {/* Visualizer (Canvas-based frequency spectrum) */}
      <div className="visualizer">
        <canvas ref={canvasRef} width={320} height={110} style={{ width: '100%', height: '100%' }} />
      </div>

      {/* Track List */}
      <div className="track-list">
        <div className="track-list-header">TRACK LIST</div>
        <div className="track-list-scroll">
          {trackList.map((track, index) => (
            <div
              key={track.path}
              className={`track-item ${index === currentTrackIndex ? 'active' : ''}`}
              onClick={() => onSelectTrack(index)}
            >
              <span className="track-number">{String(index + 1).padStart(2, '0')}</span>
              <span className="track-name">{track.name}</span>
              <span className="track-duration">{track.lengthFormatted}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
