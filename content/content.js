// WeebCentral Content Script
// Extracts manga metadata, chapter lists, and image URLs within the authenticated browser tab.

console.log('[WeebDownloader] Content script loaded on', window.location.href);

// Listen for messages from popup or background
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'PING') {
    sendResponse({ status: 'pong', url: window.location.href });
    return true;
  }

  if (request.action === 'GET_MANGA_INFO') {
    getMangaInfo()
      .then(info => sendResponse({ success: true, data: info }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // async response
  }

  if (request.action === 'GET_CHAPTER_LIST') {
    getChapterList(request.seriesId)
      .then(chapters => sendResponse({ success: true, data: chapters }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'GET_CHAPTER_PAGES') {
    getChapterPages(request.chapterUrl)
      .then(pages => sendResponse({ success: true, data: pages }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'FETCH_IMAGE_DATA') {
    fetchImageAsBase64(request.url)
      .then(data => sendResponse({ success: true, data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

/**
 * Extract series info from the current page
 */
async function getMangaInfo() {
  const url = window.location.href;
  const isSeries = url.includes('/series/');
  const isChapter = url.includes('/chapters/');

  let title = '';
  let seriesId = '';
  let coverUrl = '';

  if (isSeries) {
    const parts = window.location.pathname.split('/').filter(Boolean);
    // URL format: /series/01J76XYBPKS1TM2S3AWVSNBH3X/Kaguya-Wants-To-Be-Confessed-To
    const seriesIndex = parts.indexOf('series');
    if (seriesIndex !== -1 && parts[seriesIndex + 1]) {
      seriesId = parts[seriesIndex + 1];
    }

    // Title: look for h1 or meta
    const h1 = document.querySelector('h1');
    if (h1) {
      title = h1.textContent.trim();
    }
    if (!title) {
      const ogTitle = document.querySelector('meta[property="og:title"]');
      if (ogTitle) title = ogTitle.content.trim();
    }
    if (!title) {
      title = document.title.replace(' - Weeb Central', '').trim();
    }

    // Cover image
    const coverEl = document.querySelector('section[x-data] img, article img, img[alt*="Cover"]');
    if (coverEl) {
      coverUrl = coverEl.src || coverEl.getAttribute('srcset') || '';
    }
  } else if (isChapter) {
    // If currently on a chapter page, extract series link
    const seriesLink = document.querySelector('a[href*="/series/"]');
    if (seriesLink) {
      const href = seriesLink.getAttribute('href');
      const match = href.match(/\/series\/([^\/]+)/);
      if (match) seriesId = match[1];
      title = seriesLink.textContent.trim();
    }
    if (!title) {
      title = document.title.replace(' - Weeb Central', '').trim();
    }
  }

  // Clean title for folder safety
  const safeTitle = title.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();

  return {
    title: safeTitle || 'Manga',
    originalTitle: title,
    seriesId,
    coverUrl,
    currentUrl: url,
    isSeries,
    isChapter
  };
}

/**
 * Fetch and parse the full chapter list for a series
 */
async function getChapterList(seriesId) {
  if (!seriesId) {
    const info = await getMangaInfo();
    seriesId = info.seriesId;
  }

  if (!seriesId) {
    throw new Error('Could not determine Series ID from page.');
  }

  const chapterListUrl = `https://weebcentral.com/series/${seriesId}/full-chapter-list`;
  console.log('[WeebDownloader] Fetching chapter list from:', chapterListUrl);

  const response = await fetch(chapterListUrl, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml',
      'X-Requested-With': 'XMLHttpRequest'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to load chapter list: HTTP ${response.status}`);
  }

  const html = await response.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Find all chapter link elements: div[x-data] > a or any a[href*="/chapters/"]
  const links = Array.from(doc.querySelectorAll('div[x-data] > a, a[href*="/chapters/"]'));

  if (links.length === 0) {
    throw new Error('No chapters found in full-chapter-list response.');
  }

  const chapters = [];
  const seenUrls = new Set();

  links.forEach((a, index) => {
    let href = a.getAttribute('href') || '';
    if (href.startsWith('/')) {
      href = 'https://weebcentral.com' + href;
    }
    if (!href || seenUrls.has(href)) return;
    seenUrls.add(href);

    // Extract title / name
    // Tachiyomi: element.selectFirst("span.flex > span")
    const titleSpan = a.querySelector('span.flex > span') || a.querySelector('span') || a;
    let name = (titleSpan ? titleSpan.textContent : a.textContent).trim();
    name = name.replace(/\s+/g, ' ');

    // Extract chapter number
    let chapterNum = null;
    const numMatch = name.match(/(?:Chapter|Ch\.?)\s*([\d.]+)/i) || name.match(/(\d+(?:\.\d+)?)/);
    if (numMatch) {
      chapterNum = parseFloat(numMatch[1]);
    } else {
      chapterNum = index + 1;
    }

    // Extract date if available
    const timeEl = a.querySelector('time');
    const date = timeEl ? (timeEl.getAttribute('datetime') || timeEl.textContent.trim()) : '';

    chapters.push({
      id: href.split('/chapters/')[1]?.split('/')[0] || `ch_${index}`,
      url: href,
      name,
      chapterNumber: chapterNum,
      date
    });
  });

  // Sort chapters ascending by chapter number
  chapters.sort((a, b) => (a.chapterNumber || 0) - (b.chapterNumber || 0));

  console.log(`[WeebDownloader] Loaded ${chapters.length} chapters.`);
  return chapters;
}

/**
 * Fetch image URLs for a specific chapter
 */
async function getChapterPages(chapterUrl) {
  const urlObj = new URL(chapterUrl);
  let cleanPath = urlObj.pathname.replace(/\/+$/, '');
  if (!cleanPath.endsWith('/images')) {
    cleanPath += '/images';
  }
  urlObj.pathname = cleanPath;
  urlObj.searchParams.set('is_prev', 'False');
  urlObj.searchParams.set('reading_style', 'long_strip');
  const imagesUrl = urlObj.toString();

  console.log('[WeebDownloader] Fetching chapter images from:', imagesUrl);

  // Try fetching /images first with HX-Request
  let response = await fetch(imagesUrl, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'HX-Request': 'true'
    }
  });

  // If failed with HX-Request, retry without it
  if (!response.ok) {
    console.warn(`[WeebDownloader] /images with HX-Request returned HTTP ${response.status}, retrying plain fetch...`);
    response = await fetch(imagesUrl);
  }

  // If /images still failed, try the main chapter reader URL directly
  if (!response.ok) {
    console.warn(`[WeebDownloader] /images failed, fetching base chapter URL: ${chapterUrl}`);
    response = await fetch(chapterUrl);
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch chapter pages: HTTP ${response.status} from ${imagesUrl}`);
  }

  const html = await response.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Strategy 1: Find all <img> tags in document
  let imgElements = Array.from(doc.querySelectorAll('section img, img.cursor-pointer, main img, article img, img'));
  const imageUrls = [];

  imgElements.forEach(img => {
    let src = img.getAttribute('src') ||
              img.getAttribute('data-src') ||
              img.getAttribute('x-bind:src') ||
              img.getAttribute(':src') ||
              img.getAttribute('data-original') ||
              (img.getAttribute('srcset') ? img.getAttribute('srcset').split(',')[0].trim().split(' ')[0] : '') ||
              img.src;

    if (!src) return;
    if (src.startsWith('//')) src = 'https:' + src;
    if (src.startsWith('/')) src = 'https://weebcentral.com' + src;

    // Filter out UI icons (e.g. svg, official badge, logo, avatar)
    const lower = src.toLowerCase();
    if (lower.endsWith('.svg') ||
        lower.includes('official-translation') ||
        lower.includes('favicon') ||
        lower.includes('avatar') ||
        lower.includes('logo')) {
      return;
    }

    if (!imageUrls.includes(src)) {
      imageUrls.push(src);
    }
  });

  // Strategy 2: If DOM parsing yielded 0 images, extract image URLs from raw HTML via regex
  if (imageUrls.length === 0) {
    console.log('[WeebDownloader] DOM search yielded 0 images. Attempting regex scan of response HTML...');
    const imgRegex = /https?:\/\/[^"'\s\)<>]+\.(?:jpg|jpeg|png|webp|avif)(?:\?[^"'\s\)<>]*)?/gi;
    const matches = html.match(imgRegex) || [];
    matches.forEach(m => {
      const lower = m.toLowerCase();
      if (!lower.endsWith('.svg') && !lower.includes('favicon') && !lower.includes('avatar') && !lower.includes('logo')) {
        if (!imageUrls.includes(m)) {
          imageUrls.push(m);
        }
      }
    });
  }

  console.log(`[WeebDownloader] Found ${imageUrls.length} pages in chapter.`);
  if (imageUrls.length === 0) {
    throw new Error(`No manga pages found for chapter (Checked: ${imagesUrl}). Status: ${response.status}, Length: ${html.length}`);
  }

  return imageUrls;
}

/**
 * Fetch image as Base64 data to pass across extension messaging
 */
async function fetchImageAsBase64(url) {
  const response = await fetch(url, {
    headers: {
      'Accept': 'image/avif,image/webp,image/apng,image/*,*/*'
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} downloading ${url}`);
  }

  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      // reader.result is data:image/...;base64,...
      const base64 = reader.result.split(',')[1];
      const mime = blob.type || 'image/jpeg';
      resolve({ base64, mime });
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
