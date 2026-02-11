import { useState, useEffect, useRef, useCallback } from 'react'

export function useSPCPlayer({ waitFor } = {}) {
  const [isReady, setIsReady] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTrack, setCurrentTrack] = useState(null)
  const [trackList, setTrackList] = useState([])
  const [trackInfo, setTrackInfo] = useState(null)
  const [currentTrackIndex, setCurrentTrackIndex] = useState(0)
  const [frequencyData, setFrequencyData] = useState(new Array(16).fill(0))
  const [elapsed, setElapsed] = useState(0)

  const uiStartRef = useRef(null)
  const contextRef = useRef(null)
  const nodeRef = useRef(null)
  const analyserRef = useRef(null)
  const gainNodeRef = useRef(null)
  const nextTrackRef = useRef(null)
  const wakeLockRef = useRef(null)
  const spcDataRef = useRef([]) // Array of { filename, data: Uint8Array, name, duration, fade }
  const playStartRef = useRef(null)
  const fadeTimerRef = useRef(null)
  const endTimerRef = useRef(null)
  const isPlayingRef = useRef(false)

  // SPC engine functions captured from the module (isolated from VGM's Module)
  const spcEngineRef = useRef(null)

  const initPlayer = useCallback(() => {
    try {
      setIsReady(true)
    } catch (e) {
      console.error('Failed to init SPC player:', e)
    }
  }, [])

  // Load spc_snes.js engine script
  // Wait for VGM player to fully initialize first to avoid Module conflicts
  useEffect(() => {
    if (!waitFor) return

    const loadScript = (src) => {
      return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${src}"]`)) {
          resolve()
          return
        }
        const script = document.createElement('script')
        script.src = src
        script.onload = resolve
        script.onerror = reject
        document.head.appendChild(script)
      })
    }

    // Ensure minizip is available (VGM player may have loaded it already)
    const ensureMinizip = window.Minizip
      ? Promise.resolve()
      : loadScript('https://niekvlessert.github.io/vgmplay-js-2/minizip-asm.min.js')

    ensureMinizip.then(() => {
      // Save VGM player's Module and related globals before loading SPC engine
      const savedModule = window.Module
      const savedAllocate = window.allocate
      const savedALLOC_STACK = window.ALLOC_STACK

      // Clear Module so spc_snes.js creates its own fresh instance
      window.Module = undefined

      // Set memoryInitializerPrefixURL so it finds spc_snes.js.mem
      window.Module = { memoryInitializerPrefixURL: '/spc-engine/' }

      return loadScript('/spc-engine/spc_snes.js').then(() => {
        // Poll until SPC module is ready
        const check = setInterval(() => {
          try {
            if (typeof window._my_init === 'function' &&
                typeof window._my_decode === 'function' &&
                window.HEAP16) {
              clearInterval(check)

              // Capture SPC engine functions
              spcEngineRef.current = {
                allocate: window.allocate,
                ALLOC_STACK: window.ALLOC_STACK,
                _my_init: window._my_init,
                _my_decode: window._my_decode,
                HEAP16: window.HEAP16,
                Module: window.Module
              }

              // Restore VGM player's Module
              if (savedModule) {
                window.Module = savedModule
              }
              // Restore allocate/ALLOC_STACK for VGM if they existed
              if (savedAllocate) {
                window.allocate = savedAllocate
                window.ALLOC_STACK = savedALLOC_STACK
              }

              initPlayer()
            }
          } catch (e) {
            console.error('SPC engine check failed:', e)
          }
        }, 200)
        setTimeout(() => clearInterval(check), 15000)
      })
    }).catch(err => {
      console.error('SPC script loading failed:', err)
    })
  }, [initPlayer, waitFor])

  // UI elapsed timer
  useEffect(() => {
    if (isPlaying && currentTrack) {
      uiStartRef.current = Date.now()
      const dur = currentTrack?.length || 0
      const id = setInterval(() => {
        const t = ((Date.now() - uiStartRef.current) / 1000) | 0
        setElapsed(Math.min(dur, t))
      }, 250)
      return () => clearInterval(id)
    } else {
      setElapsed(0)
      uiStartRef.current = null
    }
  }, [isPlaying, currentTrack])

  // Parse ID666 tag from SPC buffer
  const parseSPCID666 = useCallback((buffer) => {
    try {
      const readString = (offset, len) => {
        const bytes = buffer.slice(offset, offset + len)
        let end = bytes.indexOf(0)
        if (end < 0) end = len
        const decoder = new TextDecoder('ascii')
        return decoder.decode(bytes.slice(0, end)).trim()
      }

      const title = readString(0x2E, 32)
      const game = readString(0x4E, 32)
      const artist = readString(0xB1, 32)
      const durationStr = readString(0xA9, 3)
      const duration = parseInt(durationStr, 10) || 0
      const fadeStr = readString(0xAC, 5)
      const fade = parseInt(fadeStr, 10) || 0

      return { title, game, artist, duration, fade }
    } catch (e) {
      return null
    }
  }, [])

  const loadZip = useCallback(async (url) => {
    if (!isReady) return []

    // Clear previous state
    setTrackList([])
    setCurrentTrackIndex(0)
    setCurrentTrack(null)
    setTrackInfo(null)
    spcDataRef.current = []

    try {
      const response = await fetch(url)
      const arrayBuffer = await response.arrayBuffer()
      const byteArray = new Uint8Array(arrayBuffer)

      const mz = new window.Minizip(byteArray)
      const fileList = mz.list()
      const tracks = []

      for (const file of fileList) {
        const originalPath = file.filepath
        const lowerPath = originalPath.toLowerCase()

        if (lowerPath.endsWith('.spc')) {
          const fileArray = mz.extract(originalPath)
          const spcInfo = parseSPCID666(fileArray)

          const duration = spcInfo?.duration || 180
          const fade = spcInfo?.fade || 10000
          const lengthSeconds = duration + Math.ceil(fade / 1000)

          const track = {
            path: originalPath,
            name: spcInfo?.title || originalPath.replace(/\.spc$/i, '').replace(/^\d+\s*/, ''),
            length: lengthSeconds,
            lengthFormatted: `${Math.floor(lengthSeconds / 60)}:${(lengthSeconds % 60).toString().padStart(2, '0')}`,
            duration: duration,
            fade: fade,
            title: `${spcInfo?.title || ''}|||${spcInfo?.game || ''}|||${spcInfo?.artist || ''}`
          }

          tracks.push(track)

          // Store the raw SPC data for playback
          spcDataRef.current.push({
            filename: originalPath,
            data: new Uint8Array(fileArray),
            ...track
          })
        }
      }

      setTrackList(tracks)
      if (tracks.length > 0) {
        setCurrentTrackIndex(0)
      }
      return tracks
    } catch (e) {
      console.error('Failed to load SPC zip:', e)
      return []
    }
  }, [isReady, parseSPCID666])

  const stop = useCallback(() => {
    // Clear fade/end timers
    if (fadeTimerRef.current) {
      clearInterval(fadeTimerRef.current)
      fadeTimerRef.current = null
    }
    if (endTimerRef.current) {
      clearTimeout(endTimerRef.current)
      endTimerRef.current = null
    }

    // Disconnect audio nodes
    if (nodeRef.current) {
      try {
        nodeRef.current.onaudioprocess = null
        nodeRef.current.disconnect()
      } catch (e) { }
    }
    if (gainNodeRef.current) {
      try { gainNodeRef.current.disconnect() } catch (e) { }
    }
    if (analyserRef.current) {
      try { analyserRef.current.disconnect() } catch (e) { }
    }
    if (contextRef.current && contextRef.current.state === 'running') {
      try { contextRef.current.suspend() } catch (e) { }
    }

    isPlayingRef.current = false
    playStartRef.current = null
    setElapsed(0)
    setIsPlaying(false)
    setCurrentTrack(null)
    setTrackInfo(null)
  }, [])

  const play = useCallback((trackIndex, tracks = null) => {
    const list = tracks || trackList
    if (!isReady || list.length === 0) return

    const idx = trackIndex !== undefined ? trackIndex : currentTrackIndex
    const track = list[idx]
    if (!track) return

    // Find the corresponding SPC data
    const spcEntry = spcDataRef.current[idx]
    if (!spcEntry) return

    // Stop current playback
    if (isPlayingRef.current) {
      stop()
    }

    // Create or reuse AudioContext
    if (!contextRef.current || contextRef.current.state === 'closed') {
      window.AudioContext = window.AudioContext || window.webkitAudioContext
      contextRef.current = new AudioContext()
    }

    if (contextRef.current.state === 'suspended') {
      contextRef.current.resume().catch(e => console.error('Audio resume failed', e))
    }

    // Create fresh audio nodes
    if (nodeRef.current) {
      try { nodeRef.current.disconnect() } catch (e) { }
    }
    if (gainNodeRef.current) {
      try { gainNodeRef.current.disconnect() } catch (e) { }
    }
    if (analyserRef.current) {
      try { analyserRef.current.disconnect() } catch (e) { }
    }

    const frameSize = 16384
    nodeRef.current = contextRef.current.createScriptProcessor(frameSize, 0, 2)

    const gainNode = contextRef.current.createGain()
    gainNode.gain.value = 1.0
    gainNodeRef.current = gainNode

    const analyser = contextRef.current.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.8
    analyserRef.current = analyser

    // Get SPC engine functions from captured ref
    const engine = spcEngineRef.current
    if (!engine) return

    // Load SPC into WASM memory
    const spcPtr = engine.allocate(spcEntry.data, 'i8', engine.ALLOC_STACK)
    engine._my_init(spcPtr, spcEntry.data.length)

    // Setup resampling parameters (SPC outputs at 32kHz)
    const inRate = 32000
    const outRate = contextRef.current.sampleRate
    const ratio = inRate / outRate
    const finalOffset = frameSize * ratio
    const lastSample = 1 + Math.floor(finalOffset)

    // Allocate decode buffer in WASM heap
    const bufSize = 4 * (lastSample - 1)
    const buf = engine.allocate(new Uint8Array(bufSize + 4), 'i8', engine.ALLOC_STACK)

    // HEAP16 from captured engine (may get updated if WASM memory grows)
    const getHEAP16 = () => engine.Module.HEAP16 || engine.HEAP16

    // Linear interpolation sample function
    const sampleAt = (chan, x) => {
      const heap16 = getHEAP16()
      const offset = ratio * x
      const bufferOffset = Math.floor(offset)
      const high = offset - bufferOffset
      const low = 1 - high
      const base = chan + buf / 2 + bufferOffset * 2
      const lowVal = heap16[base] * low
      const highVal = heap16[base + 1] * high
      return lowVal + highVal
    }

    // onaudioprocess callback
    nodeRef.current.onaudioprocess = (e) => {
      if (!isPlayingRef.current) return

      engine._my_decode(buf, lastSample * 2)

      const output = e.outputBuffer
      for (let chan = 0; chan < output.numberOfChannels; chan++) {
        const outData = output.getChannelData(chan)
        for (let k = 0; k < outData.length; k++) {
          outData[k] = sampleAt(chan, k) / 32000
        }
      }
    }

    // Connect: ScriptProcessor → GainNode → Analyser → Destination
    nodeRef.current.connect(gainNode)
    gainNode.connect(analyser)
    analyser.connect(contextRef.current.destination)

    // Set track info
    const titleParts = (track.title || '').split('|||')
    setTrackInfo({
      title: titleParts[0] || track.name,
      game: titleParts[1] || '',
      system: 'Super Nintendo',
      author: titleParts[2] || '',
      length: track.lengthFormatted
    })

    setCurrentTrack(track)
    setCurrentTrackIndex(idx)
    isPlayingRef.current = true
    playStartRef.current = Date.now()
    setIsPlaying(true)

    // Duration-based ending with fade
    const duration = track.duration || 180
    const fade = track.fade || 10000
    const fadeDurationMs = fade
    const fadeStartMs = duration * 1000

    // Fade out timer
    if (fadeDurationMs > 0) {
      fadeTimerRef.current = setTimeout(() => {
        if (!isPlayingRef.current || !gainNodeRef.current) return
        const fadeSteps = 20
        const fadeInterval = fadeDurationMs / fadeSteps
        let step = 0
        fadeTimerRef.current = setInterval(() => {
          step++
          if (gainNodeRef.current) {
            gainNodeRef.current.gain.value = Math.max(0, 1 - (step / fadeSteps))
          }
          if (step >= fadeSteps) {
            clearInterval(fadeTimerRef.current)
            fadeTimerRef.current = null
          }
        }, fadeInterval)
      }, fadeStartMs)
    }

    // Auto-advance timer
    endTimerRef.current = setTimeout(() => {
      if (isPlayingRef.current && nextTrackRef.current) {
        nextTrackRef.current()
      }
    }, fadeStartMs + fadeDurationMs + 500)
  }, [isReady, trackList, currentTrackIndex, stop])

  const pause = useCallback(() => {
    if (nodeRef.current) {
      try { nodeRef.current.disconnect() } catch (e) { }
    }
    isPlayingRef.current = false
    setIsPlaying(false)
  }, [])

  const togglePlayback = useCallback(() => {
    if (isPlaying) {
      pause()
    } else if (currentTrack) {
      play(currentTrackIndex)
    } else {
      play(0)
    }
  }, [isPlaying, currentTrack, currentTrackIndex, pause, play])

  const nextTrack = useCallback(() => {
    nextTrackRef.current = nextTrack
    const nextIdx = (currentTrackIndex + 1) % trackList.length
    stop()
    setTimeout(() => play(nextIdx), 100)
  }, [currentTrackIndex, trackList.length, stop, play])

  const prevTrack = useCallback(() => {
    const prevIdx = currentTrackIndex === 0 ? trackList.length - 1 : currentTrackIndex - 1
    stop()
    setTimeout(() => play(prevIdx), 100)
  }, [currentTrackIndex, trackList.length, stop, play])

  // Keep latest nextTrack in ref
  useEffect(() => {
    nextTrackRef.current = nextTrack
  }, [nextTrack])

  // Screen Wake Lock
  useEffect(() => {
    const requestWakeLock = async () => {
      if (!('wakeLock' in navigator)) return
      if (!isPlaying || document.visibilityState !== 'visible' || wakeLockRef.current) return
      try {
        wakeLockRef.current = await navigator.wakeLock.request('screen')
        wakeLockRef.current.addEventListener('release', () => {
          wakeLockRef.current = null
        })
      } catch (err) {
        console.error(`Wake Lock failed: ${err.message}`)
      }
    }

    const releaseWakeLock = async () => {
      if (wakeLockRef.current) {
        try {
          await wakeLockRef.current.release()
          wakeLockRef.current = null
        } catch (err) { }
      }
    }

    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'hidden') {
        if (nodeRef.current) {
          try { nodeRef.current.disconnect() } catch (e) { }
        }
        isPlayingRef.current = false
        setIsPlaying(false)
      } else if (document.visibilityState === 'visible') {
        await requestWakeLock()
        if (contextRef.current && contextRef.current.state === 'suspended') {
          try { await contextRef.current.resume() } catch (err) { }
        }
      }
    }

    if (isPlaying) {
      requestWakeLock()
      document.addEventListener('visibilitychange', handleVisibilityChange)
    } else {
      releaseWakeLock()
    }

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      releaseWakeLock()
    }
  }, [isPlaying])

  // Frequency data loop
  useEffect(() => {
    if (!analyserRef.current || !isReady) return
    let rafId = null
    const freqUint8 = new Uint8Array(analyserRef.current.frequencyBinCount)

    const tick = () => {
      try {
        analyserRef.current.getByteFrequencyData(freqUint8)
        const bins = 16
        const binSize = Math.max(1, Math.floor(freqUint8.length / bins))
        const next = []
        for (let i = 0; i < bins; i++) {
          let sum = 0
          const start = i * binSize
          for (let j = 0; j < binSize; j++) {
            const idx = start + j
            if (idx < freqUint8.length) sum += freqUint8[idx]
          }
          next[i] = Math.round(sum / binSize)
        }
        setFrequencyData(next)
      } catch (_) { }
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => { if (rafId) cancelAnimationFrame(rafId) }
  }, [isReady])

  // Media Session API
  useEffect(() => {
    if (!('mediaSession' in navigator)) return

    try {
      if (trackInfo) {
        navigator.mediaSession.metadata = new window.MediaMetadata({
          title: trackInfo.title,
          artist: trackInfo.author || 'Unknown Artist',
          album: trackInfo.game || '9-Player SPC Archive',
          artwork: [
            { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }
          ]
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
          navigator.mediaSession.setActionHandler('play', null)
          navigator.mediaSession.setActionHandler('pause', null)
          navigator.mediaSession.setActionHandler('stop', null)
          navigator.mediaSession.setActionHandler('previoustrack', null)
          navigator.mediaSession.setActionHandler('nexttrack', null)
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
    loadZip,
    play,
    pause,
    stop,
    togglePlayback,
    nextTrack,
    prevTrack
  }
}
