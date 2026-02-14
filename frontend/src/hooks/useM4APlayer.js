import { useState, useEffect, useRef, useCallback } from 'react'

export function useM4APlayer() {
  const [isReady] = useState(true)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTrack, setCurrentTrack] = useState(null)
  const [trackList, setTrackList] = useState([])
  const [trackInfo, setTrackInfo] = useState(null)
  const [currentTrackIndex, setCurrentTrackIndex] = useState(0)
  const [frequencyData, setFrequencyData] = useState(new Array(16).fill(0))
  const [elapsed, setElapsed] = useState(0)

  const audioRef = useRef(null)
  const rafRef = useRef(null)
  const nextTrackRef = useRef(null)
  const selectedGameRef = useRef(null)
  const binsRef = useRef(new Array(16).fill(0))

  // Synthetic frequency visualization (no Web Audio API dependency)
  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      // Decay to zero
      binsRef.current = new Array(16).fill(0)
      setFrequencyData(new Array(16).fill(0))
      return
    }

    const tick = () => {
      const bins = binsRef.current
      const next = []
      for (let i = 0; i < 16; i++) {
        // Generate target value with musical-looking distribution
        // (lower frequencies stronger, higher ones weaker)
        const base = Math.max(0, 180 - i * 8)
        const target = base + Math.random() * 80 - 40
        // Smooth towards target (fast attack, slow decay)
        if (target > bins[i]) {
          next[i] = Math.min(255, bins[i] + (target - bins[i]) * 0.4)
        } else {
          next[i] = Math.max(0, bins[i] - (bins[i] - target) * 0.15)
        }
      }
      binsRef.current = next
      setFrequencyData(next.map(v => Math.round(v)))
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [isPlaying])

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

    audio.ontimeupdate = () => {
      setElapsed(Math.floor(audio.currentTime))
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

    const game = selectedGameRef.current
    setTrackInfo({
      title: track.nameJp || track.name,
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
  }, [trackList, currentTrackIndex])

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

  const nextTrack = useCallback(() => {
    const nextIdx = (currentTrackIndex + 1) % trackList.length
    play(nextIdx)
  }, [currentTrackIndex, trackList.length, play])

  const prevTrack = useCallback(() => {
    const prevIdx = currentTrackIndex === 0 ? trackList.length - 1 : currentTrackIndex - 1
    play(prevIdx)
  }, [currentTrackIndex, trackList.length, play])

  useEffect(() => {
    nextTrackRef.current = nextTrack
  }, [nextTrack])

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
          album: trackInfo.game || '9-Player Music Archive',
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
    frequencyData,
    elapsed,
    loadGame,
    play,
    pause,
    stop,
    togglePlayback,
    nextTrack,
    prevTrack,
    resumeAudio
  }
}
