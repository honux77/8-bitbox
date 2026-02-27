import fs from 'fs'
import os from 'os'
import path from 'path'
import JSZip from 'jszip'
import zlib from 'zlib'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DEFAULT_SRC_DIR = path.join(__dirname, '../../vgz')
const DEFAULT_OUT_DIR = path.join(__dirname, '../public/music-mp3')
const DEFAULT_FORMAT = 'mp3'
const DEFAULT_BITRATE = '192k'
const DEFAULT_SAMPLE_RATE = 44100

function parseArgs(argv) {
  const args = {
    src: DEFAULT_SRC_DIR,
    out: DEFAULT_OUT_DIR,
    format: DEFAULT_FORMAT,
    bitrate: DEFAULT_BITRATE,
    sampleRate: DEFAULT_SAMPLE_RATE,
    force: false,
    limit: 0
  }

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    const next = argv[i + 1]
    if (token === '--src' && next) {
      args.src = path.resolve(next)
      i += 1
    } else if (token === '--out' && next) {
      args.out = path.resolve(next)
      i += 1
    } else if (token === '--format' && next) {
      args.format = next.toLowerCase()
      i += 1
    } else if (token === '--bitrate' && next) {
      args.bitrate = next
      i += 1
    } else if (token === '--sample-rate' && next) {
      args.sampleRate = Number.parseInt(next, 10)
      i += 1
    } else if (token === '--limit' && next) {
      args.limit = Number.parseInt(next, 10)
      i += 1
    } else if (token === '--force') {
      args.force = true
    } else if (token === '--help' || token === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${token}`)
    }
  }

  if (!Number.isFinite(args.sampleRate) || args.sampleRate < 8000) {
    throw new Error('Invalid --sample-rate value')
  }
  if (!Number.isFinite(args.limit) || args.limit < 0) {
    throw new Error('Invalid --limit value')
  }
  if (!['mp3', 'ogg', 'wav', 'm4a'].includes(args.format)) {
    throw new Error('Unsupported --format. Use one of: mp3, ogg, wav, m4a')
  }
  return args
}

function printHelp() {
  console.log(`Usage: node scripts/convert-vgz-to-web-audio.js [options]

Options:
  --src <dir>          Source folder that contains VGM/VGZ ZIP files
  --out <dir>          Output folder for converted audio
  --format <format>    mp3 (default), ogg, wav, m4a
  --bitrate <value>    FFmpeg target bitrate for lossy formats (default: 192k)
  --sample-rate <hz>   Output sample rate (default: 44100)
  --limit <n>          Convert at most n tracks (0 = all)
  --force              Re-convert even if target file exists
  -h, --help           Show this help message
`)
}

function sanitizeName(input) {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s\-().]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function runCommand(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts
    })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (data) => {
      stdout += data.toString()
    })
    child.stderr.on('data', (data) => {
      stderr += data.toString()
    })
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

async function checkDependency(command, versionArgs = ['--version']) {
  try {
    await runCommand(command, versionArgs)
  } catch (_) {
    throw new Error(`Required command not found: ${command}`)
  }
}

function isGzipBuffer(buffer) {
  return buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b
}

async function convertTrackToAudio({
  trackName,
  trackData,
  isVgz,
  outFile,
  format,
  bitrate,
  sampleRate,
  tempDir
}) {
  const safeBase = sanitizeName(path.basename(trackName, path.extname(trackName))) || 'track'
  const inVgmPath = path.join(tempDir, `${safeBase}.vgm`)
  const wavPath = path.join(tempDir, `${safeBase}.wav`)

  let vgmData = trackData
  if (isVgz || isGzipBuffer(trackData)) {
    vgmData = zlib.gunzipSync(trackData)
  }

  fs.writeFileSync(inVgmPath, vgmData)
  await runCommand('vgm2wav', [inVgmPath, wavPath])

  if (format === 'wav') {
    fs.copyFileSync(wavPath, outFile)
    return
  }

  const ffmpegArgs = ['-y', '-i', wavPath, '-ar', String(sampleRate), '-vn']
  if (format === 'mp3') {
    ffmpegArgs.push('-c:a', 'libmp3lame', '-b:a', bitrate, outFile)
  } else if (format === 'm4a') {
    ffmpegArgs.push('-c:a', 'aac', '-b:a', bitrate, '-movflags', '+faststart', outFile)
  } else {
    ffmpegArgs.push('-c:a', 'libvorbis', '-b:a', bitrate, outFile)
  }
  await runCommand('ffmpeg', ffmpegArgs)
}

async function convertArchive(zipPath, outputRoot, options, progress) {
  const zipBuffer = fs.readFileSync(zipPath)
  const zip = await JSZip.loadAsync(zipBuffer)
  const gameNameRaw = path.basename(zipPath, '.zip')
  const gameName = sanitizeName(gameNameRaw) || 'game'
  const gameOutDir = path.join(outputRoot, gameName)
  fs.mkdirSync(gameOutDir, { recursive: true })

  const tracks = Object.entries(zip.files).filter(([entryName, entry]) => {
    if (entry.dir) return false
    const lower = entryName.toLowerCase()
    return lower.endsWith('.vgm') || lower.endsWith('.vgz')
  })

  if (tracks.length === 0) return []

  const results = []
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgz-convert-'))
  try {
    for (const [entryName, entry] of tracks) {
      if (options.limit > 0 && progress.converted >= options.limit) break

      const outBase = sanitizeName(path.basename(entryName, path.extname(entryName))) || 'track'
      const outFile = path.join(gameOutDir, `${outBase}.${options.format}`)
      const relOutFile = path.relative(outputRoot, outFile)

      if (!options.force && fs.existsSync(outFile)) {
        progress.skipped += 1
        results.push({ source: entryName, output: relOutFile, skipped: true })
        continue
      }

      const trackData = await entry.async('nodebuffer')
      const isVgz = entryName.toLowerCase().endsWith('.vgz')
      await convertTrackToAudio({
        trackName: entryName,
        trackData,
        isVgz,
        outFile,
        format: options.format,
        bitrate: options.bitrate,
        sampleRate: options.sampleRate,
        tempDir
      })

      progress.converted += 1
      results.push({ source: entryName, output: relOutFile, skipped: false })
      console.log(`  ✓ ${entryName} -> ${relOutFile}`)
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }

  return results
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (!fs.existsSync(args.src)) {
    throw new Error(`Source directory not found: ${args.src}`)
  }

  await checkDependency('vgm2wav', ['-h'])
  if (args.format !== 'wav') {
    await checkDependency('ffmpeg', ['-version'])
  }

  fs.mkdirSync(args.out, { recursive: true })
  const zipFiles = fs.readdirSync(args.src)
    .filter((name) => name.toLowerCase().endsWith('.zip'))
    .sort((a, b) => a.localeCompare(b))

  if (zipFiles.length === 0) {
    console.log(`No ZIP files found in ${args.src}`)
    return
  }

  console.log(`Converting ${zipFiles.length} archives from ${args.src}`)
  console.log(`Output: ${args.out} | Format: ${args.format}`)

  const progress = { converted: 0, skipped: 0 }
  const manifest = []

  for (const zipName of zipFiles) {
    if (args.limit > 0 && progress.converted >= args.limit) break
    const zipPath = path.join(args.src, zipName)
    console.log(`\n[${zipName}]`)
    const converted = await convertArchive(zipPath, args.out, args, progress)
    if (converted.length > 0) {
      manifest.push({
        archive: zipName,
        tracks: converted
      })
    }
  }

  const manifestPath = path.join(args.out, 'conversion-manifest.json')
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    format: args.format,
    bitrate: args.bitrate,
    sampleRate: args.sampleRate,
    archives: manifest
  }, null, 2)}\n`)

  console.log('\nDone.')
  console.log(`Converted: ${progress.converted}, Skipped: ${progress.skipped}`)
  console.log(`Manifest: ${manifestPath}`)
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`)
  process.exit(1)
})
