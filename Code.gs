/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║                              ⚠️  DEPRECATED  ⚠️                               ║
 * ╠══════════════════════════════════════════════════════════════════════════════╣
 * ║  This Google Apps Script version is NO LONGER WORKING.                       ║
 * ║                                                                              ║
 * ║  Reason: 591.com.tw's CloudFront CDN blocks requests from Google's IPs.      ║
 * ║                                                                              ║
 * ║  Please use the Playwright-based crawler instead:                            ║
 * ║    - crawler.ts (with Google Sheets sync via API)                            ║
 * ║    - Runs on GitHub Actions (scheduled every 6 hours)                        ║
 * ║                                                                              ║
 * ║  See README.md for setup instructions.                                       ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

/**
 * 591 Rental Housing Crawler for Google Apps Script
 *
 * This script crawls rent.591.com.tw to collect rental property listings
 * and stores them in a Google Sheet for tracking and analysis.
 *
 * Setup Instructions:
 * 1. Create a new Google Sheet
 * 2. Go to Extensions > Apps Script
 * 3. Copy this entire code into Code.gs
 * 4. Run setupSheets() once to create the required sheets
 * 5. Add your search URLs to the Config sheet
 * 6. Run main() to start crawling, or run createTrigger() for automatic scheduling
 */

// ╔════════════════════════════════════════════════════════════════════════════╗
// ║                    USER CONFIGURATION - MODIFY HERE                        ║
// ╚════════════════════════════════════════════════════════════════════════════╝

const USER_CONFIG = {
  // ─────────────────────────────────────────────────────────────────────────────
  // TRIGGER SETTINGS
  // ─────────────────────────────────────────────────────────────────────────────
  TRIGGER_HOURS: 6,           // How often to run automatically (hours: 1, 2, 4, 6, 8, 12, 24)

  // ─────────────────────────────────────────────────────────────────────────────
  // REQUEST SETTINGS (adjust if getting blocked)
  // ─────────────────────────────────────────────────────────────────────────────
  REQUEST_DELAY_MS: 2000,     // Delay between requests in milliseconds (increase if getting blocked)
  MAX_PAGES_PER_URL: 10,      // Maximum pages to crawl per URL (50 pages = 1500 items max)

  // ─────────────────────────────────────────────────────────────────────────────
  // USER COLUMNS (columns reserved for your notes at the beginning of Data sheet)
  // ─────────────────────────────────────────────────────────────────────────────
  USER_COLUMN_HEADERS: [
    '★ Mark',                 // Column A: Mark/Flag (e.g., ✓, ✗, ⭐, ?)
    '★ Rating',               // Column B: Rating (e.g., 1-5, A/B/C, Good/Bad)
    '★ Remarks',              // Column C: Your notes/remarks
  ],
};

// ╔════════════════════════════════════════════════════════════════════════════╗
// ║                    SYSTEM CONFIGURATION - DO NOT MODIFY                    ║
// ╚════════════════════════════════════════════════════════════════════════════╝

const CONFIG = {
  // Sheet names
  SHEET_NAME_CONFIG: 'Config',
  SHEET_NAME_DATA: 'Data',

  // Request settings (from user config)
  USER_AGENT: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  ITEMS_PER_PAGE: 30,
  REQUEST_DELAY_MS: USER_CONFIG.REQUEST_DELAY_MS,
  MAX_PAGES_PER_URL: USER_CONFIG.MAX_PAGES_PER_URL,

  // Trigger settings (from user config)
  TRIGGER_HOURS: USER_CONFIG.TRIGGER_HOURS,

  // User columns (from user config)
  USER_COLUMNS: USER_CONFIG.USER_COLUMN_HEADERS.length,

  // Data headers for the Data sheet (user columns + system columns)
  DATA_HEADERS: [
    ...USER_CONFIG.USER_COLUMN_HEADERS,
    'Property ID',
    'Title',
    'Price',
    'Price (Number)',
    'Property Type',
    'Size (坪)',
    'Floor',
    'Location',
    'Metro Distance',
    'Tags',
    'Agent Type',
    'Agent Name',
    'Update Info',
    'Views',
    'URL',
    'Source URL',
    'First Seen',
    'Last Updated',
    'Status'
  ],

  // Config headers
  CONFIG_HEADERS: [
    'URL',
    'Description',
    'Last Fetched',
    'Items Found',
    'Status'
  ]
};

// ========================================
// SETUP FUNCTIONS
// ========================================

/**
 * Sets up the required sheets with headers.
 * Run this once when first setting up the spreadsheet.
 */
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Setup Config sheet
  let configSheet = ss.getSheetByName(CONFIG.SHEET_NAME_CONFIG);
  if (!configSheet) {
    configSheet = ss.insertSheet(CONFIG.SHEET_NAME_CONFIG);
  }
  configSheet.getRange(1, 1, 1, CONFIG.CONFIG_HEADERS.length).setValues([CONFIG.CONFIG_HEADERS]);
  configSheet.getRange(1, 1, 1, CONFIG.CONFIG_HEADERS.length).setFontWeight('bold');
  configSheet.setFrozenRows(1);

  // Setup Data sheet
  let dataSheet = ss.getSheetByName(CONFIG.SHEET_NAME_DATA);
  if (!dataSheet) {
    dataSheet = ss.insertSheet(CONFIG.SHEET_NAME_DATA);
  }
  dataSheet.getRange(1, 1, 1, CONFIG.DATA_HEADERS.length).setValues([CONFIG.DATA_HEADERS]);
  dataSheet.getRange(1, 1, 1, CONFIG.DATA_HEADERS.length).setFontWeight('bold');
  dataSheet.setFrozenRows(1);

  // Add sample URLs to Config sheet
  const sampleUrls = [
    ['https://rent.591.com.tw/list?region=3&kind=3&other=near_subway,rental-subsidy', '新北市分租套房-近捷運-租金補貼', '', '', ''],
    ['https://rent.591.com.tw/list?region=1&kind=1&section=8,9&price=10000$_30000$&layout=3,2', '台北市整層住家-大安信義區-1-3萬-2-3房', '', '', '']
  ];

  const lastRow = configSheet.getLastRow();
  if (lastRow === 1) {
    configSheet.getRange(2, 1, sampleUrls.length, sampleUrls[0].length).setValues(sampleUrls);
  }

  Logger.log('Sheets setup completed successfully!');
  Logger.log('Please add your search URLs to the Config sheet and run main() to start crawling.');
}

// ========================================
// MAIN FUNCTIONS
// ========================================

/**
 * Main entry point - processes all URLs from the Config sheet.
 */
function main() {
  const startTime = new Date();
  Logger.log('Starting 591 crawler at ' + startTime.toISOString());

  const urls = getConfigUrls();
  if (urls.length === 0) {
    Logger.log('No URLs found in Config sheet. Please add URLs first.');
    return;
  }

  Logger.log('Found ' + urls.length + ' URL(s) to process');

  let totalNewItems = 0;
  let totalUpdatedItems = 0;

  for (let i = 0; i < urls.length; i++) {
    const urlConfig = urls[i];
    Logger.log('\n--- Processing URL ' + (i + 1) + '/' + urls.length + ' ---');
    Logger.log('URL: ' + urlConfig.url);

    try {
      const result = processUrl(urlConfig.url, urlConfig.row);
      totalNewItems += result.newItems;
      totalUpdatedItems += result.updatedItems;

      // Update config sheet with results
      updateConfigStatus(urlConfig.row, result.totalItems, 'Success');

    } catch (error) {
      Logger.log('Error processing URL: ' + error.message);
      updateConfigStatus(urlConfig.row, 0, 'Error: ' + error.message);
    }

    // Delay between URLs
    if (i < urls.length - 1) {
      Utilities.sleep(CONFIG.REQUEST_DELAY_MS);
    }
  }

  const endTime = new Date();
  const duration = (endTime - startTime) / 1000;

  Logger.log('\n========================================');
  Logger.log('Crawling completed!');
  Logger.log('Duration: ' + duration.toFixed(1) + ' seconds');
  Logger.log('New items: ' + totalNewItems);
  Logger.log('Updated items: ' + totalUpdatedItems);
  Logger.log('========================================');
}

/**
 * Processes a single URL with pagination.
 */
function processUrl(url, configRow) {
  const allListings = [];
  let pageNum = 1;
  let hasMore = true;

  while (hasMore && pageNum <= CONFIG.MAX_PAGES_PER_URL) {
    Logger.log('Fetching page ' + pageNum);

    // Page 1 uses original URL, subsequent pages add &page=N
    const pageUrl = pageNum === 1 ? url : buildPageUrl(url, pageNum);
    const html = fetchListPage(pageUrl);

    if (!html) {
      Logger.log('Failed to fetch page, stopping pagination');
      break;
    }

    const listings = parseListings(html, url);
    Logger.log('Found ' + listings.length + ' listings on page ' + pageNum);

    if (listings.length === 0) {
      hasMore = false;
    } else {
      allListings.push(...listings);
      pageNum++;

      // Check if we got fewer items than expected (last page)
      if (listings.length < CONFIG.ITEMS_PER_PAGE) {
        hasMore = false;
      }

      // Delay between page requests
      if (hasMore) {
        Utilities.sleep(CONFIG.REQUEST_DELAY_MS);
      }
    }
  }

  Logger.log('Total listings collected: ' + allListings.length);

  // Write listings to sheet
  const result = writeListings(allListings, url);

  return {
    totalItems: allListings.length,
    newItems: result.newItems,
    updatedItems: result.updatedItems
  };
}

/**
 * Builds a paginated URL using page=N parameter.
 */
function buildPageUrl(baseUrl, pageNum) {
  const separator = baseUrl.includes('?') ? '&' : '?';
  return baseUrl + separator + 'page=' + pageNum;
}

/**
 * Fetches HTML content from a URL.
 */
function fetchListPage(url) {
  const options = {
    method: 'get',
    headers: {
      'User-Agent': CONFIG.USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Referer': 'https://rent.591.com.tw/',
      'sec-ch-ua': '"Google Chrome";v="120", "Chromium";v="120", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1'
    },
    followRedirects: true,
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const responseCode = response.getResponseCode();

    if (responseCode === 200) {
      return response.getContentText();
    } else {
      Logger.log('HTTP Error: ' + responseCode);
      // Log response headers for debugging
      const headers = response.getAllHeaders();
      Logger.log('Response headers: ' + JSON.stringify(headers));
      return null;
    }
  } catch (error) {
    Logger.log('Fetch error: ' + error.message);
    return null;
  }
}

// ========================================
// HTML PARSING FUNCTIONS
// ========================================

/**
 * Parses HTML to extract listing data from __NUXT__ SSR data.
 * 591 uses Nuxt.js and embeds listing data in window.__NUXT__ object.
 */
function parseListings(html, sourceUrl) {
  const listings = [];

  // Try to extract __NUXT__ data first (modern 591 uses Nuxt.js SSR)
  const nuxtData = extractNuxtData(html);
  if (nuxtData && nuxtData.items && nuxtData.items.length > 0) {
    Logger.log('Using __NUXT__ data extraction method');
    return parseNuxtListings(nuxtData, sourceUrl);
  }

  // Fallback to HTML parsing if __NUXT__ extraction fails
  Logger.log('Falling back to HTML parsing method');
  return parseHtmlListings(html, sourceUrl);
}

/**
 * Extracts __NUXT__ data from HTML.
 */
function extractNuxtData(html) {
  try {
    // Find the __NUXT__ script content
    const nuxtMatch = html.match(/window\.__NUXT__\s*=\s*(\{[\s\S]*?\})\s*(?:<\/script>|;?\s*$)/m);
    if (!nuxtMatch) {
      // Try alternative pattern for encoded/minified version
      const altMatch = html.match(/__NUXT__\s*=\s*\(function\([^)]*\)\{return\s*(\{[\s\S]*?\})\}\([^)]*\)\)/);
      if (!altMatch) {
        Logger.log('Could not find __NUXT__ data in HTML');
        return null;
      }
    }

    // Look for listing data pattern in HTML
    // The data contains "items":[ array with listing objects
    const itemsMatch = html.match(/"items":\s*\[([\s\S]*?)\],"total"/);
    if (!itemsMatch) {
      Logger.log('Could not find items array in __NUXT__ data');
      return null;
    }

    // Extract total count
    const totalMatch = html.match(/"total":\s*"?(\d+)"?/);
    const total = totalMatch ? parseInt(totalMatch[1], 10) : 0;

    // Extract firstRow for pagination
    const firstRowMatch = html.match(/"firstRow":\s*(\d+)/);
    const firstRow = firstRowMatch ? parseInt(firstRowMatch[1], 10) : 0;

    // Parse individual items from the items array
    const items = parseItemsFromJson(itemsMatch[1]);

    return {
      items: items,
      total: total,
      firstRow: firstRow
    };
  } catch (error) {
    Logger.log('Error extracting __NUXT__ data: ' + error.message);
    return null;
  }
}

/**
 * Parses items array from JSON string.
 */
function parseItemsFromJson(itemsStr) {
  const items = [];

  // Split by "},{"  to separate individual items
  const itemStrings = itemsStr.split(/\},\s*\{/);

  for (let i = 0; i < itemStrings.length; i++) {
    let itemStr = itemStrings[i];
    // Add back the braces
    if (i > 0) itemStr = '{' + itemStr;
    if (i < itemStrings.length - 1) itemStr = itemStr + '}';

    try {
      // Extract key fields using regex (more reliable than JSON.parse for partial data)
      const item = {};

      // Extract id
      const idMatch = itemStr.match(/"id":\s*(\d+)/);
      if (idMatch) item.id = idMatch[1];

      // Extract title
      const titleMatch = itemStr.match(/"title":\s*"([^"]+)"/);
      if (titleMatch) item.title = decodeUnicodeEscapes(titleMatch[1]);

      // Extract price
      const priceMatch = itemStr.match(/"price":\s*"([^"]+)"/);
      if (priceMatch) item.price = priceMatch[1];

      // Extract price_unit
      const priceUnitMatch = itemStr.match(/"price_unit":\s*"([^"]+)"/);
      if (priceUnitMatch) item.price_unit = decodeUnicodeEscapes(priceUnitMatch[1]);

      // Extract kind_name (property type)
      const kindMatch = itemStr.match(/"kind_name":\s*"([^"]+)"/);
      if (kindMatch) item.kind_name = decodeUnicodeEscapes(kindMatch[1]);

      // Extract area (size)
      const areaMatch = itemStr.match(/"area":\s*(\d+(?:\.\d+)?)/);
      if (areaMatch) item.area = areaMatch[1];

      // Extract floor_name
      const floorMatch = itemStr.match(/"floor_name":\s*"([^"]+)"/);
      if (floorMatch) item.floor_name = floorMatch[1];

      // Extract address
      const addressMatch = itemStr.match(/"address":\s*"([^"]+)"/);
      if (addressMatch) item.address = decodeUnicodeEscapes(addressMatch[1]);

      // Extract role_name (agent info)
      const roleMatch = itemStr.match(/"role_name":\s*"([^"]+)"/);
      if (roleMatch) item.role_name = decodeUnicodeEscapes(roleMatch[1]);

      // Extract refresh_time
      const refreshMatch = itemStr.match(/"refresh_time":\s*"([^"]+)"/);
      if (refreshMatch) item.refresh_time = decodeUnicodeEscapes(refreshMatch[1]);

      // Extract browse_count
      const browseMatch = itemStr.match(/"browse_count":\s*(\d+)/);
      if (browseMatch) item.browse_count = browseMatch[1];

      // Extract tags array
      const tagsMatch = itemStr.match(/"tags":\s*\[([^\]]*)\]/);
      if (tagsMatch) {
        const tagStrings = tagsMatch[1].match(/"([^"]+)"/g) || [];
        item.tags = tagStrings.map(function(t) {
          return decodeUnicodeEscapes(t.replace(/"/g, '').trim());
        }).filter(function(t) { return t; });
      }

      // Extract surrounding (metro distance)
      const surroundingMatch = itemStr.match(/"surrounding":\s*\{[^}]*"desc":\s*"([^"]+)"/);
      if (surroundingMatch) {
        item.surrounding_desc = decodeUnicodeEscapes(surroundingMatch[1]);
      }

      if (item.id) {
        items.push(item);
      }
    } catch (e) {
      // Skip malformed items
      continue;
    }
  }

  return items;
}

/**
 * Decodes Unicode escape sequences in strings.
 */
function decodeUnicodeEscapes(str) {
  if (!str) return '';
  return str.replace(/\\u([0-9a-fA-F]{4})/g, function(match, code) {
    return String.fromCharCode(parseInt(code, 16));
  });
}

/**
 * Parses listings from __NUXT__ data.
 */
function parseNuxtListings(nuxtData, sourceUrl) {
  const listings = [];

  for (const item of nuxtData.items) {
    const listing = {
      propertyId: String(item.id),
      title: item.title || '',
      price: item.price ? (item.price + (item.price_unit || '元/月')) : '',
      priceNumber: item.price ? parseInt(String(item.price).replace(/,/g, ''), 10) : 0,
      propertyType: item.kind_name || '',
      size: item.area || '',
      floor: item.floor_name || '',
      location: item.address || '',
      metroDistance: item.surrounding_desc || '',
      tags: Array.isArray(item.tags) ? item.tags.join(', ') : '',
      agentType: '',
      agentName: '',
      updateInfo: item.refresh_time || '',
      views: item.browse_count || '',
      url: 'https://rent.591.com.tw/' + item.id,
      sourceUrl: sourceUrl
    };

    // Parse agent info from role_name
    if (item.role_name) {
      if (item.role_name.indexOf('仲介') >= 0) {
        listing.agentType = '仲介';
        listing.agentName = item.role_name.replace('仲介', '').trim();
      } else if (item.role_name.indexOf('屋主') >= 0) {
        listing.agentType = '屋主';
        listing.agentName = item.role_name.replace('屋主', '').trim();
      } else {
        listing.agentName = item.role_name;
      }
    }

    listings.push(listing);
  }

  return listings;
}

/**
 * Fallback: Parses listings from HTML (legacy method).
 */
function parseHtmlListings(html, sourceUrl) {
  const listings = [];

  // Find all property links and extract unique IDs
  const linkPattern = /href="https:\/\/rent\.591\.com\.tw\/(\d+)"/gi;
  const propertyIds = new Set();
  let match;

  while ((match = linkPattern.exec(html)) !== null) {
    propertyIds.add(match[1]);
  }

  // For each unique property ID, extract its data
  for (const propertyId of propertyIds) {
    const propertyUrl = 'https://rent.591.com.tw/' + propertyId;

    // Find the context around this property link
    const propertyIndex = html.indexOf('href="' + propertyUrl + '"');
    if (propertyIndex === -1) continue;

    // Get surrounding context
    const contextStart = Math.max(0, propertyIndex - 2000);
    const contextEnd = Math.min(html.length, propertyIndex + 3000);
    const context = html.substring(contextStart, contextEnd);

    let listing = {
      propertyId: propertyId,
      title: '',
      price: '',
      priceNumber: 0,
      propertyType: '',
      size: '',
      floor: '',
      location: '',
      metroDistance: '',
      tags: '',
      agentType: '',
      agentName: '',
      updateInfo: '',
      views: '',
      url: propertyUrl,
      sourceUrl: sourceUrl
    };

    // Extract title
    const titleMatch = context.match(/class="item-info-title"[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/i);
    if (titleMatch) {
      listing.title = cleanText(titleMatch[1]);
    }

    // Extract price
    const priceMatch = context.match(/(\d{1,3}(?:,\d{3})*)\s*(?:<[^>]*>)*\s*元\/月/);
    if (priceMatch) {
      listing.price = priceMatch[1] + '元/月';
      listing.priceNumber = parseInt(priceMatch[1].replace(/,/g, ''), 10);
    }

    // Extract tags
    const tagMatches = context.match(/<span class="tag"[^>]*>([^<]+)<\/span>/gi) || [];
    const tags = tagMatches.map(function(t) {
      const tagTextMatch = t.match(/>([^<]+)</);
      return tagTextMatch ? cleanText(tagTextMatch[1]) : '';
    }).filter(function(t) { return t; });
    listing.tags = tags.join(', ');

    // Extract info texts
    const infoTextMatches = context.match(/<div class="item-info-txt"[^>]*>[\s\S]*?<\/div>/gi) || [];
    const infoTexts = infoTextMatches.map(function(t) {
      return cleanText(t.replace(/<[^>]*>/g, ' '));
    }).filter(function(t) { return t; });

    if (infoTexts.length >= 1) {
      const typeInfo = infoTexts[0];
      const typeParts = typeInfo.split(/\s+/);

      if (typeParts.length > 0) {
        listing.propertyType = typeParts[0];
      }

      const sizeMatch = typeInfo.match(/(\d+(?:\.\d+)?)\s*坪/);
      if (sizeMatch) {
        listing.size = sizeMatch[1];
      }

      const floorMatch = typeInfo.match(/(\d+F\/\d+F)/i);
      if (floorMatch) {
        listing.floor = floorMatch[1];
      }
    }

    if (infoTexts.length >= 2) {
      listing.location = infoTexts[1];
    }

    if (infoTexts.length >= 3) {
      listing.metroDistance = infoTexts[2];
    }

    if (infoTexts.length >= 4) {
      const agentInfo = infoTexts[3];

      if (agentInfo.indexOf('仲介') >= 0) {
        listing.agentType = '仲介';
        const nameMatch = agentInfo.match(/仲介(.+?)(?:\d|$)/);
        if (nameMatch) {
          listing.agentName = cleanText(nameMatch[1]);
        }
      } else if (agentInfo.indexOf('屋主') >= 0) {
        listing.agentType = '屋主';
      }

      const updateMatch = agentInfo.match(/(\d+[^更]*更新)/);
      if (updateMatch) {
        listing.updateInfo = updateMatch[1];
      }

      const viewsMatch = agentInfo.match(/(\d+)\s*人瀏覽/);
      if (viewsMatch) {
        listing.views = viewsMatch[1];
      }
    }

    if (listing.title || listing.price) {
      listings.push(listing);
    }
  }

  return listings;
}

/**
 * Cleans text by removing extra whitespace and HTML entities.
 */
function cleanText(text) {
  if (!text) return '';
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// ========================================
// SHEET OPERATIONS
// ========================================

/**
 * Gets URLs from the Config sheet.
 */
function getConfigUrls() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const configSheet = ss.getSheetByName(CONFIG.SHEET_NAME_CONFIG);

  if (!configSheet) {
    Logger.log('Config sheet not found. Please run setupSheets() first.');
    return [];
  }

  const lastRow = configSheet.getLastRow();
  if (lastRow <= 1) {
    return [];
  }

  const data = configSheet.getRange(2, 1, lastRow - 1, CONFIG.CONFIG_HEADERS.length).getValues();
  const urls = [];

  for (let i = 0; i < data.length; i++) {
    const url = data[i][0];
    if (url && url.toString().indexOf('591.com.tw') >= 0) {
      urls.push({
        url: url.toString().trim(),
        description: data[i][1],
        row: i + 2
      });
    }
  }

  return urls;
}

/**
 * Updates the status in Config sheet.
 */
function updateConfigStatus(row, itemsFound, status) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const configSheet = ss.getSheetByName(CONFIG.SHEET_NAME_CONFIG);

  if (configSheet) {
    const now = new Date();
    configSheet.getRange(row, 3).setValue(now);
    configSheet.getRange(row, 4).setValue(itemsFound);
    configSheet.getRange(row, 5).setValue(status);
  }
}

/**
 * Finds an existing property by ID.
 */
function findExistingProperty(propertyId, dataSheet, existingData) {
  const propIdCol = CONFIG.USER_COLUMNS;  // Property ID is after user columns
  for (let i = 0; i < existingData.length; i++) {
    if (existingData[i][propIdCol] == propertyId) {
      return {
        row: i + 2,
        data: existingData[i]
      };
    }
  }
  return null;
}

/**
 * Writes listings to the Data sheet with deduplication.
 */
function writeListings(listings, sourceUrl) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dataSheet = ss.getSheetByName(CONFIG.SHEET_NAME_DATA);

  if (!dataSheet) {
    Logger.log('Data sheet not found. Please run setupSheets() first.');
    return { newItems: 0, updatedItems: 0 };
  }

  // Get existing data for deduplication
  const lastRow = dataSheet.getLastRow();
  let existingData = [];
  if (lastRow > 1) {
    existingData = dataSheet.getRange(2, 1, lastRow - 1, CONFIG.DATA_HEADERS.length).getValues();
  }

  const now = new Date();
  let newItems = 0;
  let updatedItems = 0;
  const newRows = [];
  const activePropertyIds = new Set();

  for (let j = 0; j < listings.length; j++) {
    const listing = listings[j];
    activePropertyIds.add(listing.propertyId);

    const existing = findExistingProperty(listing.propertyId, dataSheet, existingData);

    if (!existing) {
      // New listing - prepare row for batch insert
      // First 3 columns are user columns (empty for new rows)
      newRows.push([
        '',  // ★ Mark (user column)
        '',  // ★ Rating (user column)
        '',  // ★ Remarks (user column)
        listing.propertyId,
        listing.title,
        listing.price,
        listing.priceNumber,
        listing.propertyType,
        listing.size,
        listing.floor,
        listing.location,
        listing.metroDistance,
        listing.tags,
        listing.agentType,
        listing.agentName,
        listing.updateInfo,
        listing.views,
        listing.url,
        listing.sourceUrl,
        now,
        now,
        'Active'
      ]);
      newItems++;
    } else {
      // Update existing listing (preserve user columns, update data columns)
      // Column offsets: +3 for user columns (1-indexed: col 4 = Property ID)
      const colOffset = CONFIG.USER_COLUMNS;
      const rowNum = existing.row;
      dataSheet.getRange(rowNum, colOffset + 2).setValue(listing.title);      // Title
      dataSheet.getRange(rowNum, colOffset + 3).setValue(listing.price);      // Price
      dataSheet.getRange(rowNum, colOffset + 4).setValue(listing.priceNumber); // Price (Number)
      dataSheet.getRange(rowNum, colOffset + 10).setValue(listing.tags);      // Tags
      dataSheet.getRange(rowNum, colOffset + 13).setValue(listing.updateInfo); // Update Info
      dataSheet.getRange(rowNum, colOffset + 14).setValue(listing.views);     // Views
      dataSheet.getRange(rowNum, colOffset + 18).setValue(now);               // Last Updated
      dataSheet.getRange(rowNum, colOffset + 19).setValue('Active');          // Status
      updatedItems++;
    }
  }

  // Batch insert new rows
  if (newRows.length > 0) {
    const insertRow = dataSheet.getLastRow() + 1;
    dataSheet.getRange(insertRow, 1, newRows.length, newRows[0].length).setValues(newRows);
    Logger.log('Inserted ' + newRows.length + ' new listings');
  }

  // Mark properties not found in this crawl as Inactive
  markInactiveProperties(dataSheet, existingData, activePropertyIds, sourceUrl);

  return { newItems: newItems, updatedItems: updatedItems };
}

/**
 * Marks properties not found in the current crawl as Inactive.
 */
function markInactiveProperties(dataSheet, existingData, activePropertyIds, sourceUrl) {
  const colOffset = CONFIG.USER_COLUMNS;  // Offset for user columns
  for (let i = 0; i < existingData.length; i++) {
    const row = existingData[i];
    const propertyId = row[colOffset + 0];      // Property ID (index 3)
    const rowSourceUrl = row[colOffset + 15];   // Source URL (index 18)
    const currentStatus = row[colOffset + 18];  // Status (index 21)

    if (rowSourceUrl === sourceUrl &&
        currentStatus === 'Active' &&
        !activePropertyIds.has(propertyId.toString())) {
      dataSheet.getRange(i + 2, colOffset + 19).setValue('Inactive');  // Status column (col 22)
    }
  }
}

// ========================================
// TRIGGER FUNCTIONS
// ========================================

/**
 * Creates a time-based trigger to run the crawler every 6 hours.
 */
function createTrigger() {
  // Delete existing triggers first
  deleteTriggers();

  // Create new trigger
  ScriptApp.newTrigger('main')
    .timeBased()
    .everyHours(CONFIG.TRIGGER_HOURS)
    .create();

  Logger.log('Trigger created: Crawler will run every ' + CONFIG.TRIGGER_HOURS + ' hours');
}

/**
 * Deletes all existing triggers for this script.
 */
function deleteTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    ScriptApp.deleteTrigger(triggers[i]);
  }
  Logger.log('All existing triggers deleted');
}

/**
 * Lists all current triggers.
 */
function listTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  if (triggers.length === 0) {
    Logger.log('No triggers found');
  } else {
    Logger.log('Current triggers:');
    for (let i = 0; i < triggers.length; i++) {
      Logger.log('- ' + triggers[i].getHandlerFunction() + ' (' + triggers[i].getEventType() + ')');
    }
  }
}

// ========================================
// UTILITY FUNCTIONS
// ========================================

/**
 * Test function to verify the crawler is working.
 */
function testCrawler() {
  const testUrl = 'https://rent.591.com.tw/list?region=3&kind=3&other=near_subway';

  Logger.log('Testing crawler with URL: ' + testUrl);

  const html = fetchListPage(testUrl);
  if (!html) {
    Logger.log('Failed to fetch page');
    return;
  }

  Logger.log('HTML length: ' + html.length);

  const listings = parseListings(html, testUrl);
  Logger.log('Found ' + listings.length + ' listings');

  if (listings.length > 0) {
    Logger.log('\nSample listing:');
    Logger.log(JSON.stringify(listings[0], null, 2));
  }
}

/**
 * Manually run the crawler (same as main, but can be called from menu).
 */
function runCrawler() {
  main();
}

/**
 * Creates a custom menu in the spreadsheet.
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('591 Crawler')
    .addItem('Run Crawler Now', 'runCrawler')
    .addItem('Setup Sheets', 'setupSheets')
    .addSeparator()
    .addItem('Create Auto Trigger (Every 6 Hours)', 'createTrigger')
    .addItem('Delete All Triggers', 'deleteTriggers')
    .addItem('List Current Triggers', 'listTriggers')
    .addSeparator()
    .addItem('Test Crawler', 'testCrawler')
    .addToUi();
}
