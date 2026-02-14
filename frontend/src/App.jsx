import { useState, useEffect, useRef, useCallback } from 'react'
import { useM4APlayer } from './hooks/useM4APlayer'
import { Player } from './components/Player'
import './App.css'

// URL utilities - supports both query params (for OG tags) and hash (legacy)
const parseUrlParams = () => {
  // First check query params (preferred for sharing)
  const params = new URLSearchParams(window.location.search)
  const gameId = params.get('game')
  const trackName = params.get('track')
  if (gameId) {
    return { gameId, trackName }
  }

  // Fallback to hash for backward compatibility
  const hash = window.location.hash.slice(1)
  if (!hash) return null
  const slashIndex = hash.indexOf('/')
  if (slashIndex === -1) {
    return { gameId: decodeURIComponent(hash), trackName: null }
  }
  return {
    gameId: decodeURIComponent(hash.slice(0, slashIndex)),
    trackName: decodeURIComponent(hash.slice(slashIndex + 1))
  }
}

const setUrlParams = (gameId, trackName) => {
  if (!gameId) {
    history.replaceState(null, '', window.location.pathname)
    return
  }
  // Use query params for better OG tag support
  const params = new URLSearchParams()
  params.set('game', gameId)
  if (trackName) {
    params.set('track', trackName)
  }
  history.replaceState(null, '', `?${params.toString()}`)
}

// localStorage keys
const FAVORITES_KEY = '9player-favorites'
const FILTER_KEY = '9player-filter'

const loadFavorites = () => {
  try {
    const saved = localStorage.getItem(FAVORITES_KEY)
    return saved ? JSON.parse(saved) : []
  } catch {
    return []
  }
}

const saveFavorites = (favorites) => {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites))
  } catch {
    // ignore storage errors
  }
}

const loadFilter = () => {
  try {
    return localStorage.getItem(FILTER_KEY) === 'favorites'
  } catch {
    return false
  }
}

const saveFilter = (showFavoritesOnly) => {
  try {
    localStorage.setItem(FILTER_KEY, showFavoritesOnly ? 'favorites' : 'all')
  } catch {
    // ignore storage errors
  }
}

function App() {
  const [screen, setScreen] = useState('loading') // loading, start, select, player
  const [games, setGames] = useState([])
  const [selectedGame, setSelectedGame] = useState(null)
  const [error, setError] = useState(null)
  const [installPrompt, setInstallPrompt] = useState(null)
  const [favorites, setFavorites] = useState(loadFavorites)
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(loadFilter)
  const [searchQuery, setSearchQuery] = useState('')
  const [showHelp, setShowHelp] = useState(false)
  const initialHashHandled = useRef(false)

  const player = useM4APlayer()

  // Toggle favorite status
  const toggleFavorite = useCallback((e, gameId) => {
    e.stopPropagation() // Prevent triggering game selection
    setFavorites(prev => {
      const newFavorites = prev.includes(gameId)
        ? prev.filter(id => id !== gameId)
        : [...prev, gameId]
      saveFavorites(newFavorites)
      return newFavorites
    })
  }, [])

  // Save filter state when it changes
  useEffect(() => {
    saveFilter(showFavoritesOnly)
  }, [showFavoritesOnly])

  // Filter and sort games
  const filteredGames = games.filter(g => {
    if (showFavoritesOnly && !favorites.includes(g.id)) return false
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      return (g.title?.toLowerCase().includes(q) || g.titleJp?.toLowerCase().includes(q) || g.system?.toLowerCase().includes(q))
    }
    return true
  })

  // In ALL mode, keep original order so cards don't jump when toggling favorites.
  // In FAVORITES mode, no sort needed since all items are already favorites.
  const sortedGames = filteredGames

  // PWA install prompt
  useEffect(() => {
    const handler = (e) => {
      e.preventDefault()
      setInstallPrompt(e)
    }
    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  // Handle initial hash navigation (play from URL hash)
  const handleHashNavigation = useCallback(async (gamesData, hashInfo) => {
    if (!hashInfo || !hashInfo.gameId) return false

    const game = gamesData.find(g => g.id === hashInfo.gameId)
    if (!game) return false

    setSelectedGame(game)
    setScreen('player')

    const tracks = player.loadGame(game)

    if (tracks && tracks.length > 0) {
      let trackIndex = 0
      if (hashInfo.trackName) {
        const foundIndex = tracks.findIndex(t => t.name === hashInfo.trackName)
        if (foundIndex !== -1) trackIndex = foundIndex
      }
      setTimeout(() => player.play(trackIndex, tracks), 100)
    }
    return true
  }, [player])

  // Load manifest
  useEffect(() => {
    fetch('/music/manifest.json')
      .then(res => res.json())
      .then(data => {
        setGames(data.games)
        // Don't handle hash here - wait for player to be ready
        if (!parseUrlParams()) {
          setTimeout(() => setScreen('select'), 500)
        }
      })
      .catch(err => {
        console.error('Failed to load manifest:', err)
        setError('Failed to load music library')
        setScreen('select')
      })
  }, [])

  // Handle hash navigation when games are loaded (player is always ready)
  useEffect(() => {
    if (games.length === 0 || initialHashHandled.current) return

    const hashInfo = parseUrlParams()
    if (!hashInfo || !hashInfo.gameId) {
      initialHashHandled.current = true
      return
    }

    initialHashHandled.current = true
    handleHashNavigation(games, hashInfo)
  }, [games, handleHashNavigation])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (screen !== 'player') return

      switch (e.code) {
        case 'Space':
          e.preventDefault()
          player.togglePlayback()
          break
        case 'KeyN':
          player.nextTrack()
          break
        case 'KeyP':
          player.prevTrack()
          break
        case 'KeyS':
          player.stop()
          break
        case 'Escape':
          player.stop()
          setScreen('select')
          setSelectedGame(null)
          setUrlParams(null, null)
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [screen, player])

  const handleStart = () => {
    setScreen('select')
  }

  const handleGameSelect = (game) => {
    player.stop()

    // Unlock AudioContext synchronously while still in user-gesture context.
    player.resumeAudio()

    setSelectedGame(game)
    setScreen('player')

    const tracks = player.loadGame(game)

    if (tracks && tracks.length > 0) {
      setTimeout(() => {
        player.play(0, tracks)
        setUrlParams(game.id, tracks[0].name)
      }, 100)
    }
  }

  // Wrapper for track selection that updates hash
  const handleSelectTrack = useCallback((trackIndex) => {
    player.play(trackIndex)
    if (selectedGame && player.trackList[trackIndex]) {
      setUrlParams(selectedGame.id, player.trackList[trackIndex].name)
    }
  }, [player, selectedGame])

  const handleBack = () => {
    player.stop()
    setScreen('select')
    setSelectedGame(null)
    setUrlParams(null, null) // Clear hash
  }

  // Update hash when track changes (next/prev)
  useEffect(() => {
    if (selectedGame && player.trackList.length > 0 && player.currentTrackIndex >= 0) {
      const currentTrack = player.trackList[player.currentTrackIndex]
      if (currentTrack) {
        setUrlParams(selectedGame.id, currentTrack.name)
      }
    }
  }, [player.currentTrackIndex, player.trackList, selectedGame])

  const handleInstall = async () => {
    if (!installPrompt) return
    installPrompt.prompt()
    const { outcome } = await installPrompt.userChoice
    if (outcome === 'accepted') {
      setInstallPrompt(null)
    }
  }

  return (
    <div className="app">
      <header className="header">
        <img
          src="https://api.visitorbadge.io/api/visitors?path=https%3A%2F%2F9-player.pages.dev&label=VISITORS&labelColor=%231a1a2e&countColor=%2300e5ff"
          alt="visitor count"
          className="visitor-counter"
        />
        <div className="title-row">
          <h1 className="title">8-BITBOX</h1>
          <div className="header-buttons">
            {installPrompt && (
              <button className="install-button" onClick={handleInstall}>
                INSTALL
              </button>
            )}
            <button className="help-button" onClick={() => setShowHelp(true)}>
              ?
            </button>
          </div>
        </div>
        <p className="subtitle">Honux's Video Game Music Archive <span className="version">v{__APP_VERSION__}</span></p>
      </header>

      <main className="main-content">
        {screen === 'loading' && (
          <div className="loading">
            <p className="loading-text">LOADING...</p>
            <div className="loading-bar">
              <div className="loading-progress"></div>
            </div>
          </div>
        )}

        {screen === 'start' && (
          <div className="start-section">
            <div style={{ marginBottom: '60px' }}>
              <p className="section-title">PRESS START</p>
              <div className="section-divider"></div>
            </div>
            <button className="start-button" onClick={handleStart}>
              <span className="blink">START</span>
            </button>
            <p style={{
              marginTop: '40px',
              fontSize: '8px',
              color: 'var(--text-secondary)',
              lineHeight: '2'
            }}>
              SPACE: PLAY/PAUSE | N: NEXT | P: PREV | ESC: BACK
            </p>
            {error && (
              <p style={{
                marginTop: '20px',
                fontSize: '8px',
                color: 'var(--accent-magenta)',
              }}>
                {error}
              </p>
            )}
          </div>
        )}

        {screen === 'select' && (
          <>
            <p className="section-title">SELECT YOUR MUSIC</p>
            <div className="section-divider"></div>

            <div className="filter-section">
              <div className="search-box">
                <input
                  type="text"
                  className="search-input"
                  placeholder="SEARCH..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                {searchQuery && (
                  <button className="search-clear" onClick={() => setSearchQuery('')}>×</button>
                )}
              </div>
              <div className="filter-row">
                <div className="filter-toggle">
                  <button
                    className={`filter-btn ${!showFavoritesOnly ? 'active' : ''}`}
                    onClick={() => setShowFavoritesOnly(false)}
                  >
                    ALL
                  </button>
                  <button
                    className={`filter-btn ${showFavoritesOnly ? 'active' : ''}`}
                    onClick={() => setShowFavoritesOnly(true)}
                  >
                    ★ FAVORITES
                  </button>
                </div>
                <span className="filter-count">{sortedGames.length} TITLES</span>
              </div>
            </div>

            {games.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">📁</div>
                <p className="empty-text">NO MUSIC FOUND<br />ADD ZIP FILES TO DIST FOLDER</p>
              </div>
            ) : sortedGames.length === 0 ? (
              <div className="empty-state">
                {showFavoritesOnly && !searchQuery ? (
                  <>
                    <div className="empty-icon">★</div>
                    <p className="empty-text">NO FAVORITES YET<br />CLICK ★ ON ALBUMS TO ADD</p>
                  </>
                ) : (
                  <>
                    <div className="empty-icon">🔍</div>
                    <p className="empty-text">NO RESULTS FOUND</p>
                  </>
                )}
              </div>
            ) : (
              <div className="game-grid">
                {sortedGames.map((game) => (
                  <div
                    key={game.id}
                    className={`game-card ${favorites.includes(game.id) ? 'favorite' : ''}`}
                    onClick={() => handleGameSelect(game)}
                  >
                    <button
                      className={`favorite-btn ${favorites.includes(game.id) ? 'active' : ''}`}
                      onClick={(e) => toggleFavorite(e, game.id)}
                      title={favorites.includes(game.id) ? 'Remove from favorites' : 'Add to favorites'}
                    >
                      ★
                    </button>
                    <div className="game-image">
                      {game.coverImage ? (
                        <img
                          src={`/music/${game.coverImage}`}
                          alt={game.title}
                          onError={(e) => {
                            e.target.style.display = 'none'
                            e.target.parentElement.innerHTML = '<span class="game-placeholder">🎮</span>'
                          }}
                        />
                      ) : (
                        <span className="game-placeholder">🎮</span>
                      )}
                    </div>
                    <div className="game-info">
                      <h3 className="game-title">
                        {game.title}
                        {game.titleJp && game.titleJp !== game.title && (
                          <><br /><small style={{ opacity: 0.7 }}>{game.titleJp}</small></>
                        )}
                      </h3>
                      <span className="game-system">{game.system}</span>
                      <p className="game-tracks">{game.trackCount} TRACKS</p>
                      {game.author && (
                        <p className="game-author">{game.author}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {screen === 'player' && (
          <>
            <div style={{ marginBottom: '20px' }}>
              <button
                className="back-button"
                onClick={handleBack}
              >
                ← BACK
              </button>
              <span className="current-game-title">
                {selectedGame?.title}
              </span>
            </div>

            <Player
              isPlaying={player.isPlaying}
              trackInfo={player.trackInfo}
              trackList={player.trackList}
              currentTrackIndex={player.currentTrackIndex}
              coverImage={selectedGame?.coverImage}
              gameAuthor={selectedGame?.author}
              gameSystem={selectedGame?.system}
              elapsed={player.elapsed}
              duration={player.currentTrack?.length || 0}
              onTogglePlayback={player.togglePlayback}
              onNext={player.nextTrack}
              onPrev={player.prevTrack}
              onStop={player.stop}
              onSelectTrack={handleSelectTrack}
              onSeek={player.seek}
              repeatMode={player.repeatMode}
              onToggleRepeat={player.toggleRepeatMode}
              shuffle={player.shuffle}
              onToggleShuffle={player.toggleShuffle}
              volume={player.volume}
              onVolumeChange={player.setVolume}
              frequencyData={player.frequencyData}
            />
          </>
        )}
      </main>

      {/* Help Modal */}
      {showHelp && (
        <div className="help-overlay" onClick={() => setShowHelp(false)}>
          <div className="help-modal" onClick={e => e.stopPropagation()}>
            <button className="help-close" onClick={() => setShowHelp(false)}>X</button>
            <h2 className="help-title">HELP</h2>

            <div className="help-section">
              <h3>KEYBOARD SHORTCUTS</h3>
              <div className="help-shortcuts">
                <div className="help-key"><span>SPACE</span> Play / Pause</div>
                <div className="help-key"><span>N</span> Next Track</div>
                <div className="help-key"><span>P</span> Previous Track</div>
                <div className="help-key"><span>S</span> Stop</div>
                <div className="help-key"><span>ESC</span> Back to List</div>
              </div>
            </div>

            <div className="help-section">
              <h3>FEATURES</h3>
              <ul className="help-features">
                <li>Click album cover to expand</li>
                <li>Click star to add favorites</li>
                <li>Share button copies track URL</li>
                <li>URL sharing shows preview</li>
              </ul>
            </div>

            <div className="help-section">
              <h3>ABOUT</h3>
              <p className="help-about">
                8-bitbox plays retro video game music in your browser.
                Background playback supported on mobile.
              </p>
            </div>
          </div>
        </div>
      )}

      <footer className="footer">
        <p className="footer-text">
          BUILT WITH REACT | BACKGROUND PLAYBACK ENABLED
        </p>
      </footer>
    </div>
  )
}

export default App
