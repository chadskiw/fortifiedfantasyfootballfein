const express = require('express');
const fetch = require('node-fetch');

const router = express.Router();

const SEARCH_ITEM_REGEX = /<li class="searchresult data-search"[\s\S]*?<\/li>/gi;

function decodeHtmlEntities(value) {
  if (!value) return '';
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x2F;/g, '/')
    .replace(/&#47;/g, '/');
}

function stripTags(value) {
  if (!value) return '';
  return value.replace(/<[^>]*>/g, '');
}

function extractFirst(regex, text) {
  const match = regex.exec(text);
  if (!match) return null;
  return match[1] || null;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'SoundtrackShare/1.0 (+https://soundtrackofmydaytriplife.com)',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  if (!response.ok) {
    throw new Error(`bandcamp_response_${response.status}`);
  }
  return response.text();
}

function parseSearchResults(html, limit = 12) {
  const results = [];
  let match;
  while ((match = SEARCH_ITEM_REGEX.exec(html)) && results.length < limit) {
    const block = match[0];
    const url = extractFirst(/<div class="heading">\s*<a href="([^"]+)/i, block);
    const titleRaw = extractFirst(/<div class="heading">\s*<a[^>]*>([\s\S]*?)<\/a>/i, block);
    const artUrl = extractFirst(/<img src="([^"]+)"/i, block);
    const subheadRaw = extractFirst(/<div class="subhead">([\s\S]*?)<\/div>/i, block) || '';
    const releaseRaw = extractFirst(/<div class="released">([\s\S]*?)<\/div>/i, block) || '';
    const albumMatch = subheadRaw.match(/from\s+([^<]+)\s+by\s+/i);
    const artistMatch = subheadRaw.match(/by\s+([^<]+)$/i);
    const album = albumMatch ? decodeHtmlEntities(stripTags(albumMatch[1])).trim() : null;
    const artist = artistMatch ? decodeHtmlEntities(stripTags(artistMatch[1])).trim() : null;
    const title = decodeHtmlEntities(stripTags(titleRaw || '')).trim();
    const sanitizedUrl = url ? decodeHtmlEntities(url) : null;
    const art = artUrl ? decodeHtmlEntities(artUrl) : null;
    results.push({
      title,
      artist,
      album,
      url: sanitizedUrl,
      art_url: art,
      release: decodeHtmlEntities(stripTags(releaseRaw)).replace(/^released\s+/i, '').trim() || null,
    });
  }
  return results;
}

function extractJsonBlock(html, key) {
  const regex = new RegExp(`var\\s+${key}\\s*=\\s*(\\{[\\s\\S]*?\\});`);
  const match = regex.exec(html);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch (err) {
    console.error(`[bandcamp] failed to parse ${key}`, err);
    return null;
  }
}

router.get('/search', async (req, res) => {
  const query = String(req.query.query || req.query.q || '').trim();
  if (!query) {
    return res.status(400).json({ ok: false, error: 'missing_query' });
  }
  try {
    const html = await fetchText(`https://bandcamp.com/search?q=${encodeURIComponent(query)}&item_type=t`);
    const results = parseSearchResults(html, 15);
    return res.json({ ok: true, results });
  } catch (err) {
    console.error('[bandcamp] search error', err);
    return res.status(502).json({ ok: false, error: 'bandcamp_unreachable' });
  }
});

router.get('/track', async (req, res) => {
  const rawUrl = String(req.query.url || '').trim();
  const trackUrl = decodeHtmlEntities(rawUrl).replace(/&amp;/g, '&');
  if (!trackUrl) {
    return res.status(400).json({ ok: false, error: 'missing_track_url' });
  }
  try {
    const html = await fetchText(trackUrl);
    const tralbumData = extractJsonBlock(html, 'TralbumData');
    if (!tralbumData || !Array.isArray(tralbumData.trackinfo)) {
      return res.status(404).json({ ok: false, error: 'track_data_missing' });
    }
    const playableTrack =
      tralbumData.trackinfo.find((track) => track?.file && (track.file['mp3-128'] || track.file.mp3_128)) ||
      tralbumData.trackinfo.find((track) => track?.file);
    if (!playableTrack?.file) {
      return res.status(422).json({ ok: false, error: 'track_not_streamable' });
    }
    const audioUrl = playableTrack.file['mp3-128'] || playableTrack.file.mp3_128 || null;
    if (!audioUrl) {
      return res.status(422).json({ ok: false, error: 'audio_url_missing' });
    }
    const trackPayload = {
      title: playableTrack.title || tralbumData.current?.title || tralbumData.title || null,
      artist: tralbumData.artist || null,
      album: tralbumData.current?.album_title || tralbumData.album_title || null,
      duration: playableTrack.duration || tralbumData.duration || null,
      audio_url: audioUrl,
      art_url: tralbumData.artFullsizeUrl || tralbumData.artfullsize_url || null,
      track_url: trackUrl,
      release_date: tralbumData.release_date || tralbumData.publish_date || null,
      licensing: tralbumData.license_type || null,
    };
    return res.json({ ok: true, track: trackPayload });
  } catch (err) {
    console.error('[bandcamp] track error', err);
    return res.status(502).json({ ok: false, error: 'track_fetch_failed' });
  }
});

module.exports = router;
