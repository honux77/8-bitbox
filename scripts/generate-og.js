import fs from 'fs'
import path from 'path'
import sharp from 'sharp'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const MANIFEST_PATH = path.join(__dirname, '../public/music/manifest.json')
const COVERS_DIR = path.join(__dirname, '../public/music/covers')
const OUTPUT_DIR = path.join(__dirname, '../public/music/og-covers')
const FONT_PATH = path.join(__dirname, 'fonts/PressStart2P-Regular.ttf')

// OG image dimensions
const OG_WIDTH = 1200
const OG_HEIGHT = 630
const OG_BG_COLOR = '#0f0f23'

// Load Font
if (!fs.existsSync(FONT_PATH)) {
    console.error(`Font not found at ${FONT_PATH}`)
    process.exit(1)
}
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

    // Metadata layout
    let metaY = y + titleLines.slice(0, 3).length * (fontSize + 14) + 24
    const metaEls = []

    // 1. Track count
    if (trackCount > 0) {
        metaEls.push(`<text x="540" y="${metaY}" font-family="'Press Start 2P', monospace" font-size="40" fill="#aaaacc">${trackCount} Tracks</text>`)
        metaY += 60
    }

    // 2. Japanese title
    if (titleJp) {
        metaEls.push(`<text x="540" y="${metaY}" font-family="'Meiryo', 'Yu Gothic', sans-serif" font-size="35" fill="#ffff00" opacity="0.85">${titleJp}</text>`)
        metaY += 52
    }

    // 3. Composer
    if (author) {
        const authorLines = wrapText(author, 18)
        authorLines.slice(0, 2).forEach((line, i) => {
            metaEls.push(`<text x="540" y="${metaY + i * 52}" font-family="'Press Start 2P', monospace" font-size="40" fill="#aaaacc">${escapeXml(line)}</text>`)
        })
        metaY += authorLines.slice(0, 2).length * 52 + 14
    }

    // 4. System badge
    const badgeW = system.length * 28 + 44
    const badgeEl = `
    <rect x="534" y="${metaY - 34}" width="${badgeW}" height="52" rx="4" fill="rgba(0,255,0,0.08)" stroke="#00ff00" stroke-width="2"/>
    <text x="556" y="${metaY}" font-family="'Press Start 2P', monospace" font-size="30" fill="#00ff00">${system}</text>`
    metaY += 66

    // 5. Format badge
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

async function main() {
    if (!fs.existsSync(MANIFEST_PATH)) {
        console.error('Manifest file not found:', MANIFEST_PATH)
        process.exit(1)
    }

    // Ensure output directory exists
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true })
    }

    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'))
    const targetGame = process.argv[2] // Optional: specific game ID or title

    console.log(`Loaded manifest with ${manifest.games.length} games.`)
    if (targetGame) {
        console.log(`Targeting game containing: "${targetGame}"`)
    }

    for (const game of manifest.games) {
        // Filter if target provided
        if (targetGame && !game.id.toLowerCase().includes(targetGame.toLowerCase()) && !game.title.toLowerCase().includes(targetGame.toLowerCase())) {
            continue
        }

        console.log(`Processing: ${game.title} (${game.id})`)

        // Identify cover image path
        // Manifest 'coverImage' is relative to public/music, e.g. "covers/GameID.png"
        // We need absolute path provided by COVERS_DIR + filename
        const coverFilename = path.basename(game.coverImage)
        const coverFullPath = path.join(COVERS_DIR, coverFilename)

        if (!fs.existsSync(coverFullPath)) {
            console.warn(`  Warning: Cover image not found at ${coverFullPath}. Skipping.`)
            continue
        }

        const coverImageData = fs.readFileSync(coverFullPath)
        const ogFilename = `${game.id}.png`
        const ogFullPath = path.join(OUTPUT_DIR, ogFilename)

        try {
            const { resW, resH } = await createOGImage(coverImageData, game, ogFullPath)
            console.log(`  -> Generated OG image: ${ogFilename} (cover ${resW}x${resH})`)
        } catch (e) {
            console.error(`  -> Failed to generate OG image: ${e.message}`)
        }
    }

    console.log('Done.')
}

main().catch(console.error)
