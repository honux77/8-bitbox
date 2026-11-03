import { useState, useEffect, useRef, useCallback } from 'react'

const SPEC_BANDS = 16
const SPEC_RANGE_DB = 36 // must match DYNAMIC_RANGE_DB in generate-spectrum.js
const SPEC_FALL_PER_SEC = 400

function parseSpec(buf) {
  if (buf.byteLength < 12) return null
  const view = new DataView(buf)
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))
  if (magic !== 'SPEC' || view.getUint8(4) !== 1) return null
  const bands = view.getUint8(5)
  const fps = view.getUint16(6, true)
  const frames = view.getUint32(8, true)
  if (!bands || !fps || !frames || buf.byteLength < 12 + bands * frames) return null
  return { bands, fps, frames, data: new Uint8Array(buf, 12, bands * frames) }
}

export function useM4APlayer() {
  const [isReady] = useState(true)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTrack, setCurrentTrack] = useState(null)
  const [trackList, setTrackList] = useState([])
  const [trackInfo, setTrackInfo] = useState(null)
  const [currentTrackIndex, setCurrentTrackIndex] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [repeatMode, setRepeatMode] = useState('all') // 'off' | 'all' | 'one'
  const [shuffle, setShuffle] = useState(false)
  const [volume, setVolumeState] = useState(0.8)

  const audioRef = useRef(null)
  const nextTrackRef = useRef(null)
  const repeatModeRef = useRef('all')
  const shuffleRef = useRef(false)
  const volumeRef = useRef(0.8)
  const selectedGameRef = useRef(null)
  const specRef = useRef(null)
  const levelsRef = useRef(new Float32Array(SPEC_BANDS))
  const lastReadRef = useRef(0)

  // Visualizer: precomputed spectrum (.spec, see scripts/generate-spectrum.js)
  // played back in sync with audio.currentTime. A live AnalyserNode would need
  // Web Audio, which stops background playback on mobile.
  const readSpectrum = useCallback(() => {
    const out = levelsRef.current
    const now = performance.now()
    const dt = Math.min(0.1, (now - lastReadRef.current) / 1000)
    lastReadRef.current = now

    const audio = audioRef.current
    const spec = specRef.current
    const active = audio && spec && spec.audio === audio &&
      !audio.paused && !audio.ended && !audio.seeking && audio.readyState >= 3
    const gain = volumeRef.current
    // Shift by the volume in dB so bars follow the volume slider
    const offset = gain > 0 ? (255 / SPEC_RANGE_DB) * 20 * Math.log10(gain) : -Infinity

    let pos = 0, i0 = 0, i1 = 0, frac = 0
    if (active) {
      pos = audio.currentTime * spec.fps
      i0 = Math.min(spec.frames - 1, Math.floor(pos))
      i1 = Math.min(spec.frames - 1, i0 + 1)
      frac = pos - Math.floor(pos)
    }
    const fall = SPEC_FALL_PER_SEC * dt
    for (let b = 0; b < out.length; b++) {
      let target = 0
      if (active && b < spec.bands && i0 >= 0) {
        const a = spec.data[i0 * spec.bands + b]
        const c = spec.data[i1 * spec.bands + b]
        target = Math.max(0, a + (c - a) * frac + offset)
      }
      // Instant attack, gravity-style decay
      out[b] = target >= out[b] ? target : Math.max(target, out[b] - fall)
    }
    return out
  }, [])

  const loadSpectrum = useCallback((audio, trackPath) => {
    specRef.current = null
    const url = `/music/${trackPath.replace(/\.[^./]+$/, '')}.spec`
    fetch(url)
      .then(res => (res.ok ? res.arrayBuffer() : null))
      .then(buf => {
        if (!buf || audioRef.current !== audio) return
        const spec = parseSpec(buf)
        if (spec) specRef.current = { ...spec, audio }
      })
      .catch(() => {})
  }, [])

  const formatDuration = useCallback((sec) => {
    const s = Math.floor(sec)
    return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`
  }, [])

  const loadGame = useCallback((game) => {
    selectedGameRef.current = game

    setTrackList([])
    setCurrentTrackIndex(0)
    setCurrentTrack(null)
    setTrackInfo(null)
    setElapsed(0)

    if (!game || !game.tracks || game.tracks.length === 0) return []

    const tracks = game.tracks.map((t) => ({
      ...t,
      path: t.audioFile || `${game.audioDir}/${t.filename}`,
      lengthFormatted: t.duration
        ? formatDuration(t.duration)
        : '--:--'
    }))

    setTrackList(tracks)

    // Preload duration for tracks missing it
    tracks.forEach((track, i) => {
      if (track.duration) return
      const probe = new Audio()
      probe.preload = 'metadata'
      probe.src = `/music/${track.path}`
      probe.onloadedmetadata = () => {
        const dur = probe.duration
        if (!isFinite(dur)) return
        const formatted = formatDuration(dur)
        setTrackList(prev => prev.map((t, j) =>
          j === i ? { ...t, length: Math.floor(dur), lengthFormatted: formatted } : t
        ))
        probe.src = ''
      }
    })

    return tracks
  }, [formatDuration])

  const play = useCallback((trackIndex, tracks = null) => {
    const list = tracks || trackList
    if (list.length === 0) return

    const idx = trackIndex !== undefined ? trackIndex : currentTrackIndex
    const track = list[idx]
    if (!track) return

    // Stop previous audio
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.removeAttribute('src')
      audioRef.current.load()
    }

    // Plain HTML5 Audio - no Web Audio API, so it plays in background
    const audio = new Audio(`/music/${track.path}`)
    audio.preload = 'auto'
    audio.volume = volumeRef.current

    audio.ontimeupdate = () => {
      setElapsed(audio.currentTime)
    }

    audio.onloadedmetadata = () => {
      const dur = Math.floor(audio.duration)
      if (!isFinite(dur)) return
      const formatted = `${Math.floor(dur / 60)}:${(dur % 60).toString().padStart(2, '0')}`
      // Update current track with real duration
      setCurrentTrack(prev => prev ? { ...prev, length: dur, lengthFormatted: formatted } : prev)
      setTrackInfo(prev => prev ? { ...prev, length: formatted } : prev)
      // Update track in list so the track list UI shows correct duration
      setTrackList(prev => prev.map((t, i) =>
        i === idx ? { ...t, length: dur, lengthFormatted: formatted } : t
      ))
    }

    audio.onended = () => {
      if (nextTrackRef.current) nextTrackRef.current()
    }

    audio.onplay = () => setIsPlaying(true)
    audio.onpause = () => {
      if (audio === audioRef.current) setIsPlaying(false)
    }

    audioRef.current = audio
    loadSpectrum(audio, track.path)

    const game = selectedGameRef.current
    setTrackInfo({
      title: track.name,
      titleJp: track.nameJp && track.nameJp !== track.name ? track.nameJp : null,
      game: game?.title || '',
      system: game?.system || '',
      author: game?.author || '',
      length: track.lengthFormatted
    })

    setCurrentTrack(track)
    setCurrentTrackIndex(idx)
    setIsPlaying(true)

    audio.play().catch(e => {
      console.error('Playback failed:', e)
      setIsPlaying(false)
    })
  }, [trackList, currentTrackIndex, loadSpectrum])

  const seek = useCallback((time) => {
    if (audioRef.current) {
      audioRef.current.currentTime = time
      setElapsed(Math.floor(time))
    }
  }, [])

  const pause = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause()
    }
    setIsPlaying(false)
  }, [])

  const stop = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.removeAttribute('src')
      audioRef.current.load()
      audioRef.current = null
    }
    setElapsed(0)
    setIsPlaying(false)
    setCurrentTrack(null)
    setTrackInfo(null)
  }, [])

  const togglePlayback = useCallback(() => {
    if (isPlaying) {
      pause()
    } else if (audioRef.current && currentTrack) {
      audioRef.current.play().catch(() => {})
      setIsPlaying(true)
    } else {
      play(0)
    }
  }, [isPlaying, currentTrack, pause, play])

  const toggleRepeatMode = useCallback(() => {
    setRepeatMode(prev => {
      const next = prev === 'off' ? 'all' : prev === 'all' ? 'one' : 'off'
      repeatModeRef.current = next
      return next
    })
  }, [])

  const toggleShuffle = useCallback(() => {
    setShuffle(prev => {
      shuffleRef.current = !prev
      return !prev
    })
  }, [])

  const nextTrack = useCallback(() => {
    if (repeatModeRef.current === 'one') {
      play(currentTrackIndex)
      return
    }
    if (shuffleRef.current) {
      let randomIdx
      do {
        randomIdx = Math.floor(Math.random() * trackList.length)
      } while (randomIdx === currentTrackIndex && trackList.length > 1)
      play(randomIdx)
      return
    }
    const nextIdx = (currentTrackIndex + 1) % trackList.length
    if (repeatModeRef.current === 'off' && nextIdx === 0) {
      stop()
      return
    }
    play(nextIdx)
  }, [currentTrackIndex, trackList.length, play, stop])

  const prevTrack = useCallback(() => {
    const prevIdx = currentTrackIndex === 0 ? trackList.length - 1 : currentTrackIndex - 1
    play(prevIdx)
  }, [currentTrackIndex, trackList.length, play])

  useEffect(() => {
    nextTrackRef.current = nextTrack
  }, [nextTrack])

  const setVolume = useCallback((v) => {
    const clamped = Math.max(0, Math.min(1, v))
    volumeRef.current = clamped
    setVolumeState(clamped)
    if (audioRef.current) {
      audioRef.current.volume = clamped
    }
  }, [])

  // No-op: AudioContext is no longer used, but keep interface for App.jsx
  const resumeAudio = useCallback(() => {}, [])

  // Media Session API for lock screen controls
  useEffect(() => {
    if (!('mediaSession' in navigator)) return

    try {
      if (trackInfo) {
        const game = selectedGameRef.current
        const artwork = []
        if (game?.coverImage) {
          artwork.push({ src: `/music/${game.coverImage}`, sizes: '256x256', type: 'image/png' })
        }
        artwork.push(
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }
        )

        navigator.mediaSession.metadata = new window.MediaMetadata({
          title: trackInfo.title,
          artist: trackInfo.author || 'Unknown Artist',
          album: trackInfo.game || '8-bitbox',
          artwork
        })
      }

      navigator.mediaSession.setActionHandler('play', () => togglePlayback())
      navigator.mediaSession.setActionHandler('pause', () => togglePlayback())
      navigator.mediaSession.setActionHandler('stop', () => stop())
      navigator.mediaSession.setActionHandler('previoustrack', () => prevTrack())
      navigator.mediaSession.setActionHandler('nexttrack', () => nextTrack())
    } catch (e) {
      console.error('Media Session API failed:', e)
    }

    return () => {
      try {
        if ('mediaSession' in navigator) {
          ;['play', 'pause', 'stop', 'previoustrack', 'nexttrack'].forEach(a =>
            navigator.mediaSession.setActionHandler(a, null))
        }
      } catch (e) { }
    }
  }, [trackInfo, togglePlayback, stop, nextTrack, prevTrack])

  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    try {
      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused'
    } catch (e) { }
  }, [isPlaying])

  return {
    isReady,
    isPlaying,
    currentTrack,
    currentTrackIndex,
    trackList,
    trackInfo,
    readSpectrum,
    elapsed,
    loadGame,
    play,
    pause,
    stop,
    togglePlayback,
    nextTrack,
    prevTrack,
    seek,
    repeatMode,
    toggleRepeatMode,
    shuffle,
    toggleShuffle,
    volume,
    setVolume,
    resumeAudio
  }
}
