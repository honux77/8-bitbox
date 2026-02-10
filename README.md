# 9-Player (舊-Player)

> **9 = 舊 (구)** - 옛것을 플레이하다

레트로 게임 음악(VGM)을 브라우저에서 재생하는 모던 웹 플레이어입니다.

## Features

- **Real-time Audio Visualization** - 주파수 스펙트럼 시각화
- **Cover Art Display** - 앨범 커버 이미지 확대 보기
- **Responsive Design** - 데스크탑/모바일 반응형 지원
- **Auto-play** - 트랙 자동 재생 및 다음 곡 넘기기
- **Keyboard Shortcuts** - 키보드로 빠른 조작
- **URL Sharing** - 특정 곡을 URL로 직접 공유 가능
- **Favorites** - 앨범 즐겨찾기 및 필터링 (localStorage 저장)
- **Time Display** - 경과/남은 시간 실시간 표시
- **PWA Support** - 앱으로 설치 가능

## URL Sharing

재생 중인 곡의 URL을 공유하면 해당 곡이 바로 재생됩니다.

```
https://9-player.vercel.app/#GameID/TrackName
```

- 🔗 버튼으로 현재 곡 URL 복사
- URL로 접속하면 해당 곡 자동 재생

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play / Pause |
| `N` | Next Track |
| `P` | Previous Track |
| `S` | Stop |
| `ESC` | Back to Album List |

## Tech Stack

- **Frontend**: React 19 + Vite
- **Audio Engine**: VGMPlay (WebAssembly/Emscripten)
- **Styling**: CSS with CSS Variables
- **PWA**: vite-plugin-pwa
- **Storage**: localStorage (favorites)

## Getting Started

### Development

```bash
cd frontend
npm install
npm run dev
```

### Build

```bash
cd frontend
npm run build
```

### Deploy to Vercel

1. Vercel에서 GitHub 리포지토리 연결
2. Root Directory: `frontend`
3. Deploy

## Supported Formats

VGMPlay에서 지원하는 모든 포맷:
- VGM/VGZ (Video Game Music)
- 다양한 레트로 사운드 칩 지원 (YM2612, SN76489, YM2151, etc.)

## Credits

- Original [vgmplay-js](https://github.com/nickvlessert/vgmplay-js-2) by Niek Vlessert
- [VGMPlay](https://github.com/vgmrips/vgmplay) - VGM playback library
- Music files from [VGMRips](https://vgmrips.net)

## License

MIT License
