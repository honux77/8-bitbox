import fs from 'fs'
import os from 'os'
import path from 'path'
import JSZip from 'jszip'
import sharp from 'sharp'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DIST_DIR = path.join(__dirname, '../music-source/vgz')
const SPC_DIR = path.join(__dirname, '../music-source/spc')
const OUTPUT_DIR = path.join(__dirname, '../public/music')
const COVERS_DIR = path.join(OUTPUT_DIR, 'covers')
const OG_COVERS_DIR = path.join(OUTPUT_DIR, 'og-covers')
const MANIFEST_PATH = path.join(OUTPUT_DIR, 'manifest.json')
const AUDIO_BITRATE = '192k'
const TOOL_PATHS = {}

// OG image dimensions (Facebook/Twitter recommended)
const OG_WIDTH = 1200
const OG_HEIGHT = 630
const OG_BG_COLOR = '#0f0f23'

// Load Press Start 2P font for SVG text rendering
const FONT_PATH = path.join(__dirname, 'fonts/PressStart2P-Regular.ttf')
const fontBase64 = fs.readFileSync(FONT_PATH).toString('base64')

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function wrapText(text, maxChars) {
  const words = text.split(' ')
  const lines = []
  let line = ''
  for (const word of words) {
    if (line && line.length + 1 + word.length > maxChars) {
      lines.push(line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) lines.push(line)
  return lines
}

function sanitizeForPath(input) {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s\-().]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (data) => { stdout += data.toString() })
    child.stderr.on('data', (data) => { stderr += data.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        reject(new Error(`${cmd} failed (${code}): ${stderr || stdout}`))
      }
    })
  })
}

function resolveCommand(command, extraCandidates = []) {
  const candidates = [command, ...extraCandidates]

  const pathDirs = (process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)

  for (const candidate of candidates) {
    if (!candidate) continue
    if (candidate.includes('/') && fs.existsSync(candidate)) {
      return candidate
    }
    for (const dir of pathDirs) {
      const fullPath = path.join(dir, candidate)
      if (fs.existsSync(fullPath)) {
        return fullPath
      }
    }
  }

  return null
}

async function ensureCommand(command, args = ['-h']) {
  if (TOOL_PATHS[command]) return TOOL_PATHS[command]

  const resolved = resolveCommand(command, [
    `/opt/homebrew/bin/${command}`,
    `/usr/local/bin/${command}`
  ])
  if (!resolved) {
    throw new Error(`Required command not found: ${command}`)
  }

  TOOL_PATHS[command] = resolved
  return resolved
}

async function convertVgmBufferToM4A(buffer, extension, outputFilePath) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-vgm-'))
  const inputPath = path.join(tempDir, `track.${extension}`)
  const wavPath = path.join(tempDir, 'track.wav')
  try {
    fs.writeFileSync(inputPath, buffer)
    await runCommand(TOOL_PATHS.vgm2wav || 'vgm2wav', [inputPath, wavPath])
    await runCommand(TOOL_PATHS.ffmpeg || 'ffmpeg', ['-y', '-i', wavPath, '-c:a', 'aac', '-b:a', AUDIO_BITRATE, '-movflags', '+faststart', outputFilePath])
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

async function convertSpcBufferToM4A(buffer, outputFilePath) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-spc-'))
  const inputPath = path.join(tempDir, 'track.spc')
  const wavPath = path.join(tempDir, 'track.wav')
  try {
    fs.writeFileSync(inputPath, buffer)
    await runCommand(TOOL_PATHS.spc2wav || 'spc2wav', [inputPath, wavPath])
    await runCommand(TOOL_PATHS.ffmpeg || 'ffmpeg', ['-y', '-i', wavPath, '-c:a', 'aac', '-b:a', AUDIO_BITRATE, '-movflags', '+faststart', outputFilePath])
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

function createTextOverlaySvg(gameInfo) {
  const title = escapeXml(gameInfo?.title || 'Unknown Game')
  const titleJp = gameInfo?.titleJp && gameInfo.titleJp !== gameInfo.title ? escapeXml(gameInfo.titleJp) : ''
  const system = escapeXml(gameInfo?.system || 'Unknown')
  const author = gameInfo?.author ? escapeXml(gameInfo.author) : ''
  const trackCount = gameInfo?.trackCount || 0
  const format = gameInfo?.format ? gameInfo.format.toUpperCase() : 'VGM'

  // Dynamic font size
  const rawTitle = gameInfo?.title || 'Unknown Game'
  let fontSize = 24
  if (rawTitle.length > 20) fontSize = 20
  if (rawTitle.length > 28) fontSize = 16
  if (rawTitle.length > 36) fontSize = 13

  const maxChars = Math.floor(580 / (fontSize * 0.62))
  const titleLines = wrapText(rawTitle, maxChars)

  // Title lines
  let y = 140
  const titleEls = titleLines.slice(0, 3).map((line, i) => {
    const ly = y + i * (fontSize + 14)
    return `<text x="540" y="${ly}" font-family="'Press Start 2P', monospace" font-size="${fontSize}" fill="#00fff7" filter="url(#glow)">${escapeXml(line)}</text>`
  }).join('\n    ')

  // Metadata layout: Track → Japanese title → Composer → System badge → Format badge
  let metaY = y + titleLines.slice(0, 3).length * (fontSize + 14) + 24
  const metaEls = []

  // 1. Track count (40px)
  if (trackCount > 0) {
    metaEls.push(`<text x="540" y="${metaY}" font-family="'Press Start 2P', monospace" font-size="40" fill="#aaaacc">${trackCount} Tracks</text>`)
    metaY += 60
  }

  // 2. Japanese title (35px)
  const jpEl = ''
  if (titleJp) {
    metaEls.push(`<text x="540" y="${metaY}" font-family="'Meiryo', 'Yu Gothic', sans-serif" font-size="35" fill="#ffff00" opacity="0.85">${titleJp}</text>`)
    metaY += 52
  }

  // 3. Composer (40px)
  if (author) {
    const authorLines = wrapText(author, 18)
    authorLines.slice(0, 2).forEach((line, i) => {
      metaEls.push(`<text x="540" y="${metaY + i * 52}" font-family="'Press Start 2P', monospace" font-size="40" fill="#aaaacc">${escapeXml(line)}</text>`)
    })
    metaY += authorLines.slice(0, 2).length * 52 + 14
  }

  // 4. System badge (30px)
  const badgeW = system.length * 28 + 44
  const badgeEl = `
    <rect x="534" y="${metaY - 34}" width="${badgeW}" height="52" rx="4" fill="rgba(0,255,0,0.08)" stroke="#00ff00" stroke-width="2"/>
    <text x="556" y="${metaY}" font-family="'Press Start 2P', monospace" font-size="30" fill="#00ff00">${system}</text>`
  metaY += 66

  // 5. Format badge (25px)
  const formatBadge = `
    <rect x="534" y="${metaY - 30}" width="${format.length * 24 + 34}" height="44" rx="3" fill="rgba(255,0,255,0.08)" stroke="#ff00ff" stroke-width="2"/>
    <text x="551" y="${metaY}" font-family="'Press Start 2P', monospace" font-size="25" fill="#ff00ff">${format}</text>`

  // Branding
  const brandEl = `<text x="1150" y="590" text-anchor="end" font-family="'Press Start 2P', monospace" font-size="14" fill="#8888aa">&#9834; 8-bitbox</text>`

  // Accent lines
  const lines = `
    <rect x="0" y="0" width="1200" height="3" fill="#00fff7" opacity="0.8"/>
    <rect x="0" y="627" width="1200" height="3" fill="#ff00ff" opacity="0.8"/>`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
  <defs>
    <style>
      @font-face {
        font-family: 'Press Start 2P';
        src: url('data:font/truetype;base64,${fontBase64}') format('truetype');
      }
    </style>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="4" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>
  ${lines}
  ${titleEls}
  ${metaEls.join('\n  ')}
  ${badgeEl}
  ${formatBadge}
  ${brandEl}
</svg>`
}

async function createOGImage(coverImageData, gameInfo, ogFullPath) {
  const metadata = await sharp(coverImageData).metadata()
  const origW = metadata.width || 256
  const origH = metadata.height || 240

  // Cover area: left panel with border
  const areaX = 50
  const areaY = 50
  const areaW = 430
  const areaH = 530

  // Scale to fit, nearest-neighbor for pixel art
  const scale = Math.min(areaW / origW, areaH / origH)
  const resW = Math.round(origW * scale)
  const resH = Math.round(origH * scale)
  const coverX = areaX + Math.round((areaW - resW) / 2)
  const coverY = areaY + Math.round((areaH - resH) / 2)

  // Border SVG
  const borderSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
    <rect x="${areaX - 4}" y="${areaY - 4}" width="${areaW + 8}" height="${areaH + 8}" rx="2" fill="none" stroke="#4a4a6a" stroke-width="4"/>
  </svg>`)

  // Text overlay SVG
  const textSvg = Buffer.from(createTextOverlaySvg(gameInfo))

  // Composite all layers
  await sharp({
    create: { width: OG_WIDTH, height: OG_HEIGHT, channels: 4, background: OG_BG_COLOR }
  })
    .composite([
      {
        input: await sharp(coverImageData)
          .resize(resW, resH, { kernel: 'nearest' })
          .png()
          .toBuffer(),
        left: coverX,
        top: coverY
      },
      { input: borderSvg, left: 0, top: 0 },
      { input: textSvg, left: 0, top: 0 }
    ])
    .png()
    .toFile(ogFullPath)

  return { resW, resH }
}

async function parseVGMTitle(buffer) {
  // VGM file header parsing for GD3 tag
  // Reference: https://vgmrips.net/wiki/VGM_Specification
  try {
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)

    // Check VGM magic number "Vgm "
    const magic = String.fromCharCode(
      view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)
    )
    if (magic !== 'Vgm ') return null

    // GD3 offset is at 0x14 (relative to 0x14)
    const gd3Offset = view.getUint32(0x14, true)
    if (gd3Offset === 0) return null

    const gd3Pos = 0x14 + gd3Offset

    // Check GD3 magic "Gd3 "
    const gd3Magic = String.fromCharCode(
      view.getUint8(gd3Pos), view.getUint8(gd3Pos + 1),
      view.getUint8(gd3Pos + 2), view.getUint8(gd3Pos + 3)
    )
    if (gd3Magic !== 'Gd3 ') return null

    // GD3 data starts at gd3Pos + 12
    let pos = gd3Pos + 12
    const strings = []

    // Read 11 null-terminated UTF-16LE strings
    for (let i = 0; i < 11 && pos < buffer.length - 1; i++) {
      let str = ''
      while (pos < buffer.length - 1) {
        const char = view.getUint16(pos, true)
        pos += 2
        if (char === 0) break
        str += String.fromCharCode(char)
      }
      strings.push(str)
    }

    return {
      trackNameEn: strings[0] || '',
      trackNameJp: strings[1] || '',
      gameNameEn: strings[2] || '',
      gameNameJp: strings[3] || '',
      systemNameEn: strings[4] || '',
      systemNameJp: strings[5] || '',
      authorNameEn: strings[6] || '',
      authorNameJp: strings[7] || '',
      releaseDate: strings[8] || '',
      vgmCreator: strings[9] || '',
      notes: strings[10] || ''
    }
  } catch (e) {
    return null
  }
}

async function processZipFile(zipPath, gameId) {
  const data = fs.readFileSync(zipPath)
  const zip = await JSZip.loadAsync(data)
  const audioDirName = path.basename(zipPath, '.zip')
  const gameAudioDir = path.join(OUTPUT_DIR, audioDirName)
  fs.mkdirSync(gameAudioDir, { recursive: true })

  const tracks = []
  let gameInfo = null
  let coverImageData = null
  let coverImageExt = null
  const usedAudioNames = new Set()
  let trackIndex = 0

  for (const [filename, file] of Object.entries(zip.files)) {
    if (file.dir) continue

    const lowerName = filename.toLowerCase()

    // Get cover image (extract the actual image data)
    if (lowerName.endsWith('.png') || lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) {
      coverImageData = await file.async('uint8array')
      coverImageExt = path.extname(filename).toLowerCase()
    }

    // Process VGM/VGZ files
    if (lowerName.endsWith('.vgm') || lowerName.endsWith('.vgz')) {
      trackIndex += 1
      let buffer = await file.async('uint8array')
      const sourceBuffer = Buffer.from(buffer)
      const isVgz = lowerName.endsWith('.vgz') || (buffer[0] === 0x1f && buffer[1] === 0x8b)

      // If VGZ (gzip compressed), decompress
      if (isVgz) {
        const pako = await import('pako')
        try {
          buffer = pako.default.inflate(sourceBuffer)
        } catch (e) {
          console.log(`  Skipping ${filename}: decompression failed`)
          continue
        }
      }

      const vgmInfo = await parseVGMTitle(buffer)

      const sourceBase = path.basename(filename, path.extname(filename))
      const prefix = String(trackIndex).padStart(3, '0')
      let audioBase = `${prefix}_${sanitizeForPath(sourceBase) || 'track'}`
      let dedupe = 2
      while (usedAudioNames.has(audioBase.toLowerCase())) {
        audioBase = `${prefix}_${sanitizeForPath(sourceBase) || 'track'}_${dedupe}`
        dedupe += 1
      }
      usedAudioNames.add(audioBase.toLowerCase())
      const audioFileName = `${audioBase}.m4a`
      const audioRelativePath = `${audioDirName}/${audioFileName}`
      const audioOutputPath = path.join(OUTPUT_DIR, audioRelativePath)
      const sourceExt = lowerName.endsWith('.vgm') ? 'vgm' : 'vgz'

      if (!fs.existsSync(audioOutputPath)) {
        console.log(`  -> Converting VGM: ${filename} -> ${audioRelativePath}`)
        await convertVgmBufferToM4A(sourceBuffer, sourceExt, audioOutputPath)
        console.log(`  -> Converted: ${audioRelativePath}`)
      } else {
        console.log(`  -> Skip existing audio: ${audioRelativePath}`)
      }

      tracks.push({
        filename: audioFileName,
        audioFile: audioRelativePath,
        originalFilename: filename,
        name: vgmInfo?.trackNameEn || vgmInfo?.trackNameJp || path.basename(filename, path.extname(filename)),
        nameJp: vgmInfo?.trackNameJp || ''
      })

      // Get game info from first track
      if (!gameInfo && vgmInfo) {
        gameInfo = {
          title: vgmInfo.gameNameEn || vgmInfo.gameNameJp || '',
          titleJp: vgmInfo.gameNameJp || '',
          system: vgmInfo.systemNameEn || vgmInfo.systemNameJp || '',
          author: vgmInfo.authorNameEn || vgmInfo.authorNameJp || ''
        }
      }
    }
  }

  // Save cover image if found
  let coverImagePath = null
  let ogImagePath = null

  if (coverImageData && coverImageExt) {
    const coverFileName = `${gameId}${coverImageExt}`
    const coverFullPath = path.join(COVERS_DIR, coverFileName)
    fs.writeFileSync(coverFullPath, coverImageData)
    coverImagePath = `covers/${coverFileName}`
    console.log(`  -> Extracted cover image: ${coverFileName}`)

    // Generate OG image (1200x630) with retro neon template
    try {
      const ogFileName = `${gameId}.png`
      const ogFullPath = path.join(OG_COVERS_DIR, ogFileName)

      // Add trackCount and format to gameInfo for OG image
      const gameInfoWithMeta = {
        ...gameInfo,
        trackCount: tracks.length,
        format: 'vgm'
      }

      const { resW, resH } = await createOGImage(coverImageData, gameInfoWithMeta, ogFullPath)

      ogImagePath = `og-covers/${ogFileName}`
      console.log(`  -> Generated OG image: ${ogFileName} (cover ${resW}x${resH})`)
    } catch (e) {
      console.log(`  -> Failed to generate OG image: ${e.message}`)
    }
  }

  return {
    gameInfo,
    tracks,
    coverImage: coverImagePath,
    ogImage: ogImagePath
  }
}

function parseSPCID666(buffer) {
  try {
    // Check SPC magic: "SNES-SPC700 Sound File Data v0.30"
    const magic = String.fromCharCode(...buffer.slice(0, 33))
    if (!magic.startsWith('SNES-SPC700')) return null

    const readString = (offset, len) => {
      const bytes = buffer.slice(offset, offset + len)
      const end = bytes.indexOf(0)
      const str = new TextDecoder('ascii').decode(end >= 0 ? bytes.slice(0, end) : bytes)
      return str.trim()
    }

    // ID666 tag offsets (text format)
    const title = readString(0x2E, 32)
    const game = readString(0x4E, 32)
    const artist = readString(0xB1, 32)

    // Duration in seconds (3 bytes ASCII at 0xA9)
    const durationStr = readString(0xA9, 3)
    const duration = parseInt(durationStr, 10) || 0

    // Fade length in ms (5 bytes ASCII at 0xAC)
    // Note: fade field starts right after duration at 0xAC (0xA9 + 3)
    const fadeStr = readString(0xAC, 5)
    const fade = parseInt(fadeStr, 10) || 0

    return { title, game, artist, duration, fade }
  } catch (e) {
    return null
  }
}

async function processSPCZipFile(zipPath, gameId) {
  const data = fs.readFileSync(zipPath)
  const zip = await JSZip.loadAsync(data)
  const audioDirName = path.basename(zipPath, '.zip')
  const gameAudioDir = path.join(OUTPUT_DIR, audioDirName)
  fs.mkdirSync(gameAudioDir, { recursive: true })

  const tracks = []
  let gameInfo = null
  let coverImageData = null
  let coverImageExt = null
  const usedAudioNames = new Set()
  let trackIndex = 0

  for (const [filename, file] of Object.entries(zip.files)) {
    if (file.dir) continue

    const lowerName = filename.toLowerCase()

    // Get cover image
    if (lowerName.endsWith('.png') || lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) {
      coverImageData = await file.async('uint8array')
      coverImageExt = path.extname(filename).toLowerCase()
    }

    // Process SPC files
    if (lowerName.endsWith('.spc')) {
      trackIndex += 1
      const buffer = await file.async('uint8array')
      const spcInfo = parseSPCID666(buffer)
      const sourceBase = path.basename(filename, '.spc')
      const prefix = String(trackIndex).padStart(3, '0')
      let audioBase = `${prefix}_${sanitizeForPath(sourceBase) || 'track'}`
      let dedupe = 2
      while (usedAudioNames.has(audioBase.toLowerCase())) {
        audioBase = `${prefix}_${sanitizeForPath(sourceBase) || 'track'}_${dedupe}`
        dedupe += 1
      }
      usedAudioNames.add(audioBase.toLowerCase())
      const audioFileName = `${audioBase}.m4a`
      const audioRelativePath = `${audioDirName}/${audioFileName}`
      const audioOutputPath = path.join(OUTPUT_DIR, audioRelativePath)

      if (!fs.existsSync(audioOutputPath)) {
        console.log(`  -> Converting SPC: ${filename} -> ${audioRelativePath}`)
        await convertSpcBufferToM4A(Buffer.from(buffer), audioOutputPath)
        console.log(`  -> Converted: ${audioRelativePath}`)
      } else {
        console.log(`  -> Skip existing audio: ${audioRelativePath}`)
      }

      tracks.push({
        filename: audioFileName,
        audioFile: audioRelativePath,
        originalFilename: filename,
        name: spcInfo?.title || path.basename(filename, '.spc'),
        duration: spcInfo?.duration || 0,
        fade: spcInfo?.fade || 10000
      })

      // Get game info from first track with valid metadata
      if (!gameInfo && spcInfo && spcInfo.game) {
        gameInfo = {
          title: spcInfo.game,
          titleJp: '',
          system: 'Super Nintendo',
          author: spcInfo.artist || ''
        }
      }
    }
  }

  // Save cover image if found
  let coverImagePath = null
  let ogImagePath = null

  if (coverImageData && coverImageExt) {
    const coverFileName = `${gameId}${coverImageExt}`
    const coverFullPath = path.join(COVERS_DIR, coverFileName)
    fs.writeFileSync(coverFullPath, coverImageData)
    coverImagePath = `covers/${coverFileName}`
    console.log(`  -> Extracted cover image: ${coverFileName}`)

    // Generate OG image
    try {
      const ogFileName = `${gameId}.png`
      const ogFullPath = path.join(OG_COVERS_DIR, ogFileName)

      // Add trackCount and format to gameInfo for OG image
      const gameInfoWithMeta = {
        ...gameInfo,
        trackCount: tracks.length,
        format: 'spc'
      }

      const { resW, resH } = await createOGImage(coverImageData, gameInfoWithMeta, ogFullPath)
      ogImagePath = `og-covers/${ogFileName}`
      console.log(`  -> Generated OG image: ${ogFileName} (cover ${resW}x${resH})`)
    } catch (e) {
      console.log(`  -> Failed to generate OG image: ${e.message}`)
    }
  }

  return {
    gameInfo,
    tracks,
    coverImage: coverImagePath,
    ogImage: ogImagePath
  }
}

async function main() {
  console.log('Scanning dist folder for zip files...')
  await ensureCommand('vgm2wav', ['-h'])
  await ensureCommand('spc2wav', ['-h'])
  await ensureCommand('ffmpeg', ['-version'])

  // Ensure output directories exist
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  }
  if (!fs.existsSync(COVERS_DIR)) {
    fs.mkdirSync(COVERS_DIR, { recursive: true })
  }
  if (!fs.existsSync(OG_COVERS_DIR)) {
    fs.mkdirSync(OG_COVERS_DIR, { recursive: true })
  }

  const targetFile = process.argv[2] // Optional single file to process

  const files = fs.readdirSync(DIST_DIR).filter(f => {
    if (!f.endsWith('.zip') || f.includes('_backup')) return false
    if (targetFile && !f.toLowerCase().includes(targetFile.toLowerCase())) return false
    return true
  })
  console.log(`Found ${files.length} zip files (Target: ${targetFile || 'All'})`)

  const manifest = {
    generatedAt: new Date().toISOString(),
    games: []
  }

  for (const file of files) {
    console.log(`Processing ${file}...`)
    const zipPath = path.join(DIST_DIR, file)
    const gameId = path.basename(file, '.zip').replace(/[^a-zA-Z0-9]/g, '_')

    try {
      const { gameInfo, tracks, coverImage, ogImage } = await processZipFile(zipPath, gameId)

      const game = {
        id: gameId,
        format: 'vgm',
        audioDir: path.basename(file, '.zip'),
        title: gameInfo?.title || path.basename(file, '.zip'),
        titleJp: gameInfo?.titleJp || '',
        system: gameInfo?.system || 'Unknown',
        author: gameInfo?.author || '',
        coverImage: coverImage,
        ogImage: ogImage,
        trackCount: tracks.length,
        tracks: tracks
      }

      manifest.games.push(game)
      console.log(`  -> ${game.title} (${tracks.length} tracks)`)

    } catch (e) {
      console.error(`  Error processing ${file}:`, e.message)
    }
  }

  // Process SPC directory
  if (fs.existsSync(SPC_DIR)) {
    const spcFiles = fs.readdirSync(SPC_DIR).filter(f => {
      if (!f.endsWith('.zip') || f.includes('_backup')) return false
      if (targetFile && !f.toLowerCase().includes(targetFile.toLowerCase())) return false
      return true
    })
    console.log(`\nFound ${spcFiles.length} SPC zip files (Target: ${targetFile || 'All'})`)

    for (const file of spcFiles) {
      console.log(`Processing SPC: ${file}...`)
      const zipPath = path.join(SPC_DIR, file)
      const gameId = path.basename(file, '.zip').replace(/[^a-zA-Z0-9]/g, '_')

      try {
        const { gameInfo, tracks, coverImage, ogImage } = await processSPCZipFile(zipPath, gameId)

        const game = {
          id: gameId,
          format: 'spc',
          audioDir: path.basename(file, '.zip'),
          title: gameInfo?.title || path.basename(file, '.zip'),
          titleJp: gameInfo?.titleJp || '',
          system: gameInfo?.system || 'Super Nintendo',
          author: gameInfo?.author || '',
          coverImage: coverImage,
          ogImage: ogImage,
          trackCount: tracks.length,
          tracks: tracks
        }

        manifest.games.push(game)
        console.log(`  -> ${game.title} (${tracks.length} tracks)`)

      } catch (e) {
        console.error(`  Error processing ${file}:`, e.message)
      }
    }
  }

  // Write manifest
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2))
  console.log(`\nManifest written to ${MANIFEST_PATH}`)
  console.log(`Total: ${manifest.games.length} games`)
}

main().catch(console.error)
