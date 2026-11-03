// Precompute a low-resolution frequency spectrum for each audio track.
//
// The player uses plain HTML5 Audio (no Web Audio API) so playback keeps
// running in the background on mobile. That rules out a live AnalyserNode,
// so instead we analyse each track offline and ship the result next to the
// audio file as `<track>.spec`. The client reads it in sync with
// `audio.currentTime`.
//
// .spec binary format (little endian):
//   0  char[4]  magic "SPEC"
//   4  uint8    version (1)
//   5  uint8    band count
//   6  uint16   frames per second
//   8  uint32   frame count
//  12  uint8[frameCount * bandCount]  levels 0..255, frame-major
//
// Usage:
//   node scripts/generate-spectrum.js [--force] [filter]
//     Scans public/music for *.m4a and writes missing .spec files.

import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const MUSIC_DIR = path.join(__dirname, '../public/music')

export const SPEC_VERSION = 1
const SAMPLE_RATE = 22050
const FFT_SIZE = 1024
const FPS = 30
const BANDS = 16
const MIN_FREQ = 50
const MAX_FREQ = 10000
const DYNAMIC_RANGE_DB = 36
// Music energy falls off with frequency; tilt so treble bars are visible too
const TILT_DB_PER_OCTAVE = 3

export function specPathFor(audioPath) {
  return audioPath.replace(/\.[^./\\]+$/, '') + '.spec'
}

function decodeToMonoFloat(inputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-v', 'error', '-i', inputPath,
      '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', 'pipe:1'
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []
    let stderr = ''
    child.stdout.on('data', (d) => chunks.push(d))
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        // A corrupt stream makes ffmpeg log one line per bad packet; keep it short
        const lines = stderr.trim().split('\n').filter(Boolean)
        const more = lines.length > 1 ? ` (+${lines.length - 1} more ffmpeg errors, file may be corrupt)` : ''
        return reject(new Error(`ffmpeg failed (${code}): ${lines[0] || 'unknown error'}${more}`))
      }
      const buf = Buffer.concat(chunks)
      const aligned = new Float32Array(buf.length >> 2)
      for (let i = 0; i < aligned.length; i++) aligned[i] = buf.readFloatLE(i * 4)
      resolve(aligned)
    })
  })
}

// In-place iterative radix-2 FFT
function fft(re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    const half = len >> 1
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < half; k++) {
        const a = i + k
        const b = a + half
        const tr = re[b] * cr - im[b] * ci
        const ti = re[b] * ci + im[b] * cr
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

function buildBands() {
  const binHz = SAMPLE_RATE / FFT_SIZE
  const maxBin = FFT_SIZE / 2 - 1
  const bands = []
  const ratio = Math.pow(MAX_FREQ / MIN_FREQ, 1 / BANDS)
  for (let b = 0; b < BANDS; b++) {
    const lo = MIN_FREQ * Math.pow(ratio, b)
    const hi = lo * ratio
    let start = Math.max(1, Math.round(lo / binHz))
    let end = Math.min(maxBin, Math.round(hi / binHz))
    if (end <= start) end = Math.min(maxBin, start + 1)
    const center = Math.sqrt(lo * hi)
    const tilt = TILT_DB_PER_OCTAVE * Math.log2(center / 1000)
    bands.push({ start, end, tilt })
  }
  return bands
}

export function analyseSamples(samples) {
  const hop = SAMPLE_RATE / FPS
  const frameCount = Math.max(0, Math.floor(samples.length / hop))
  const bands = buildBands()
  const window = new Float32Array(FFT_SIZE)
  for (let i = 0; i < FFT_SIZE; i++) window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT_SIZE - 1))

  const db = new Float32Array(frameCount * BANDS)
  const re = new Float64Array(FFT_SIZE)
  const im = new Float64Array(FFT_SIZE)
  const norm = 2 / (FFT_SIZE * 0.5) // amplitude scaling incl. Hann coherent gain

  for (let f = 0; f < frameCount; f++) {
    // Center the window on the frame time
    const center = Math.round(f * hop)
    const offset = center - FFT_SIZE / 2
    for (let i = 0; i < FFT_SIZE; i++) {
      const s = samples[offset + i]
      re[i] = (s === undefined ? 0 : s) * window[i]
      im[i] = 0
    }
    fft(re, im)
    for (let b = 0; b < BANDS; b++) {
      const { start, end, tilt } = bands[b]
      let power = 0
      for (let k = start; k < end; k++) {
        const mr = re[k] * norm
        const mi = im[k] * norm
        power += mr * mr + mi * mi
      }
      power /= (end - start)
      db[f * BANDS + b] = 10 * Math.log10(power + 1e-12) + tilt
    }
  }

  // Normalise per track: map [ref - range, ref] to 0..255, where ref is a
  // high percentile so a few transients don't flatten everything else.
  const levels = new Uint8Array(frameCount * BANDS)
  if (frameCount === 0) return { frameCount, levels }
  const sorted = Float32Array.from(db).sort()
  const ref = sorted[Math.floor((sorted.length - 1) * 0.995)]
  if (ref < -90) return { frameCount, levels } // effectively silent
  const floor = ref - DYNAMIC_RANGE_DB
  for (let i = 0; i < db.length; i++) {
    const v = (db[i] - floor) / DYNAMIC_RANGE_DB
    levels[i] = Math.round(255 * Math.min(1, Math.max(0, v)))
  }
  return { frameCount, levels }
}

export function encodeSpec({ frameCount, levels }) {
  const header = Buffer.alloc(12)
  header.write('SPEC', 0, 'ascii')
  header.writeUInt8(SPEC_VERSION, 4)
  header.writeUInt8(BANDS, 5)
  header.writeUInt16LE(FPS, 6)
  header.writeUInt32LE(frameCount, 8)
  return Buffer.concat([header, Buffer.from(levels.buffer, levels.byteOffset, levels.byteLength)])
}

export async function generateSpectrum(audioPath, { force = false } = {}) {
  const outPath = specPathFor(audioPath)
  if (!force && fs.existsSync(outPath)) return { outPath, skipped: true }
  const samples = await decodeToMonoFloat(audioPath)
  const result = analyseSamples(samples)
  fs.writeFileSync(outPath, encodeSpec(result))
  return { outPath, skipped: false, frameCount: result.frameCount }
}

function findAudioFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...findAudioFiles(full))
    else if (/\.m4a$/i.test(entry.name)) out.push(full)
  }
  return out
}

async function main() {
  const args = process.argv.slice(2)
  const force = args.includes('--force')
  const filter = args.find(a => !a.startsWith('--'))?.toLowerCase()
  if (!fs.existsSync(MUSIC_DIR)) throw new Error(`Music directory not found: ${MUSIC_DIR}`)

  const files = findAudioFiles(MUSIC_DIR)
    .filter(f => !filter || f.toLowerCase().includes(filter))
  console.log(`Found ${files.length} audio files (${force ? 'force overwrite' : 'skip existing'})`)

  let made = 0
  let failed = 0
  for (const file of files) {
    const rel = path.relative(MUSIC_DIR, file)
    try {
      const r = await generateSpectrum(file, { force })
      if (r.skipped) continue
      made++
      console.log(`  [SPEC] ${rel} (${r.frameCount} frames)`)
    } catch (e) {
      failed++
      console.error(`  [FAIL] ${rel}: ${e.message}`)
    }
  }
  console.log(`Done: ${made} generated, ${files.length - made - failed} skipped, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
