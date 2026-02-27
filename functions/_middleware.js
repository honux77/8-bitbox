// Cloudflare Pages Middleware for dynamic OG tags
function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
}

export async function onRequest(context) {
    const { request, next } = context
    const url = new URL(request.url)
    const gameId = url.searchParams.get('game')

    // If no game query param, serve normally
    if (!gameId) {
        return next()
    }

    // Get the original response (the SPA index.html)
    const response = await next()

    // Only modify HTML responses
    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('text/html')) {
        return response
    }

    let html = await response.text()
    const trackName = url.searchParams.get('track')

    try {
        // Fetch manifest to get game/track info
        const manifestUrl = new URL('/music/manifest.json', request.url)
        const manifestRes = await fetch(manifestUrl)
        const manifest = await manifestRes.json()

        const game = manifest.games.find(g => g.id === gameId)
        if (game) {
            const baseUrl = url.origin
            let title = `${game.title} - 8-bitbox`
            let description = `${game.system} | ${game.trackCount} tracks`

            // Use OG image if available, fallback to cover, then default
            let imageUrl = game.ogImage
                ? `${baseUrl}/music/${game.ogImage}`
                : game.coverImage
                    ? `${baseUrl}/music/${game.coverImage}`
                    : `${baseUrl}/icons/og-image.png`

            if (trackName) {
                const track = game.tracks?.find(t => t.name === trackName)
                if (track) {
                    title = `${track.name} - ${game.title} | 8-bitbox`
                    description = `${game.author || game.system} | ${game.title}`
                }
            }

            // Replace OG tags
            html = html.replace(
                /<meta property="og:title" content="[^"]*"/,
                `<meta property="og:title" content="${escapeHtml(title)}"`
            )
            html = html.replace(
                /<meta property="og:description" content="[^"]*"/,
                `<meta property="og:description" content="${escapeHtml(description)}"`
            )
            html = html.replace(
                /<meta property="og:url" content="[^"]*"/,
                `<meta property="og:url" content="${escapeHtml(url.href)}"`
            )
            html = html.replace(
                /<meta property="og:image" content="[^"]*"/,
                `<meta property="og:image" content="${escapeHtml(imageUrl)}"`
            )

            // Replace Twitter tags
            html = html.replace(
                /<meta name="twitter:title" content="[^"]*"/,
                `<meta name="twitter:title" content="${escapeHtml(title)}"`
            )
            html = html.replace(
                /<meta name="twitter:description" content="[^"]*"/,
                `<meta name="twitter:description" content="${escapeHtml(description)}"`
            )
            html = html.replace(
                /<meta name="twitter:image" content="[^"]*"/,
                `<meta name="twitter:image" content="${escapeHtml(imageUrl)}"`
            )

            // Replace title tag
            html = html.replace(
                /<title>[^<]*<\/title>/,
                `<title>${escapeHtml(title)}</title>`
            )
        }
    } catch (e) {
        // If manifest fetch fails, serve original HTML
        console.error('Middleware error:', e)
    }

    return new Response(html, {
        headers: {
            ...Object.fromEntries(response.headers),
            'content-type': 'text/html; charset=utf-8',
        },
    })
}
