/**
 * 591 Rental Crawler with Google Sheets Integration
 *
 * Prerequisites:
 *   npm install
 *   npx playwright install chromium
 *
 * Local testing:
 *   1. Copy .env.example to .env
 *   2. Fill in your credentials
 *   3. npm run crawl
 *
 * Environment Variables:
 *   GOOGLE_SHEETS_ID - The Google Sheets document ID
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL - Service account email
 *   GOOGLE_PRIVATE_KEY - Service account private key
 */

import 'dotenv/config';
import { chromium, Browser, Page } from 'playwright';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';

// ============================================================
// CONFIGURATION - Edit these values
// ============================================================
const CONFIG = {
  // URLs to crawl (same format as your Config sheet)
  URLS: [
    'https://rent.591.com.tw/list?region=3&kind=3&other=near_subway,rental-subsidy',
    // Add more URLs here
  ],

  // Crawling settings
  MAX_PAGES_PER_URL: 10,    // Max pages per URL (30 items/page)
  REQUEST_DELAY_MS: 2000,   // Delay between requests

  // Sheet names
  SHEET_DATA: 'Data',
  SHEET_CONFIG: 'Config',
};

// ============================================================
// TYPES
// ============================================================
interface ListingItem {
  id: string;
  title: string;
  price: string;
  priceUnit: string;
  priceNumber: number;
  propertyType: string;
  size: string;
  floor: string;
  location: string;
  metroDistance: string;
  tags: string[];
  agentType: string;
  agentName: string;
  updateInfo: string;
  views: number;
  url: string;
  sourceUrl: string;
}

interface SheetRow {
  'Property ID': string;
  'Title': string;
  'Price': string;
  'Price (Number)': number;
  'Property Type': string;
  'Size (坪)': string;
  'Floor': string;
  'Location': string;
  'Metro Distance': string;
  'Tags': string;
  'Agent Type': string;
  'Agent Name': string;
  'Update Info': string;
  'Views': number;
  'URL': string;
  'Source URL': string;
  'First Seen': string;
  'Last Updated': string;
  'Status': string;
}

// ============================================================
// GOOGLE SHEETS CONNECTION
// ============================================================
async function connectToGoogleSheets(): Promise<GoogleSpreadsheet> {
  const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const sheetId = process.env.GOOGLE_SHEETS_ID;

  if (!serviceAccountEmail || !privateKey || !sheetId) {
    throw new Error(
      'Missing environment variables. Required:\n' +
      '  GOOGLE_SHEETS_ID\n' +
      '  GOOGLE_SERVICE_ACCOUNT_EMAIL\n' +
      '  GOOGLE_PRIVATE_KEY'
    );
  }

  const auth = new JWT({
    email: serviceAccountEmail,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const doc = new GoogleSpreadsheet(sheetId, auth);
  await doc.loadInfo();
  console.log(`Connected to: ${doc.title}`);

  return doc;
}

async function ensureDataSheet(doc: GoogleSpreadsheet) {
  let sheet = doc.sheetsByTitle[CONFIG.SHEET_DATA];

  if (!sheet) {
    console.log(`Creating "${CONFIG.SHEET_DATA}" sheet...`);
    sheet = await doc.addSheet({
      title: CONFIG.SHEET_DATA,
      headerValues: [
        '★ Mark', '★ Rating', '★ Remarks',
        'Property ID', 'Title', 'Price', 'Price (Number)',
        'Property Type', 'Size (坪)', 'Floor', 'Location',
        'Metro Distance', 'Tags', 'Agent Type', 'Agent Name',
        'Update Info', 'Views', 'URL', 'Source URL',
        'First Seen', 'Last Updated', 'Status'
      ],
    });
  }

  return sheet;
}

async function getExistingProperties(sheet: any): Promise<Map<string, any>> {
  const rows = await sheet.getRows();
  const map = new Map();

  for (const row of rows) {
    const id = row.get('Property ID');
    if (id) {
      map.set(id, row);
    }
  }

  return map;
}

async function writeListingsToSheet(
  sheet: any,
  listings: ListingItem[],
  existingProperties: Map<string, any>
): Promise<{ added: number; updated: number }> {
  const now = new Date().toISOString().split('T')[0];
  let added = 0;
  let updated = 0;
  const seenIds = new Set<string>();

  for (const listing of listings) {
    seenIds.add(listing.id);
    const existingRow = existingProperties.get(listing.id);

    if (existingRow) {
      // Update existing row (preserve user columns A-C)
      existingRow.set('Title', listing.title);
      existingRow.set('Price', `${listing.price}${listing.priceUnit}`);
      existingRow.set('Price (Number)', listing.priceNumber);
      existingRow.set('Property Type', listing.propertyType);
      existingRow.set('Size (坪)', listing.size);
      existingRow.set('Floor', listing.floor);
      existingRow.set('Location', listing.location);
      existingRow.set('Metro Distance', listing.metroDistance);
      existingRow.set('Tags', listing.tags.join(', '));
      existingRow.set('Agent Type', listing.agentType);
      existingRow.set('Agent Name', listing.agentName);
      existingRow.set('Update Info', listing.updateInfo);
      existingRow.set('Views', listing.views);
      existingRow.set('URL', listing.url);
      existingRow.set('Source URL', listing.sourceUrl);
      existingRow.set('Last Updated', now);
      existingRow.set('Status', 'Active');
      await existingRow.save();
      updated++;
    } else {
      // Add new row
      await sheet.addRow({
        '★ Mark': '',
        '★ Rating': '',
        '★ Remarks': '',
        'Property ID': listing.id,
        'Title': listing.title,
        'Price': `${listing.price}${listing.priceUnit}`,
        'Price (Number)': listing.priceNumber,
        'Property Type': listing.propertyType,
        'Size (坪)': listing.size,
        'Floor': listing.floor,
        'Location': listing.location,
        'Metro Distance': listing.metroDistance,
        'Tags': listing.tags.join(', '),
        'Agent Type': listing.agentType,
        'Agent Name': listing.agentName,
        'Update Info': listing.updateInfo,
        'Views': listing.views,
        'URL': listing.url,
        'Source URL': listing.sourceUrl,
        'First Seen': now,
        'Last Updated': now,
        'Status': 'Active',
      });
      added++;
    }
  }

  // Mark properties not found as Inactive
  for (const [id, row] of existingProperties) {
    if (!seenIds.has(id) && row.get('Status') === 'Active') {
      row.set('Status', 'Inactive');
      row.set('Last Updated', now);
      await row.save();
    }
  }

  return { added, updated };
}

// ============================================================
// CRAWLER FUNCTIONS
// ============================================================
async function extractListingsFromPage(page: Page, sourceUrl: string): Promise<ListingItem[]> {
  await page.waitForLoadState('networkidle');

  const nuxtData = await page.evaluate(() => {
    const nuxt = (window as any).__NUXT__;
    if (!nuxt || !nuxt.data) return null;

    for (const key of Object.keys(nuxt.data)) {
      const entry = nuxt.data[key];
      if (entry && entry.data && entry.data.items) {
        return {
          items: entry.data.items,
          total: entry.data.total,
        };
      }
    }
    return null;
  });

  if (!nuxtData || !nuxtData.items) {
    console.log('Could not extract __NUXT__ data');
    return [];
  }

  const listings: ListingItem[] = nuxtData.items.map((item: any) => {
    let agentType = '';
    let agentName = item.role_name || '';

    if (agentName.includes('仲介')) {
      agentType = '仲介';
      agentName = agentName.replace('仲介', '').trim();
    } else if (agentName.includes('屋主')) {
      agentType = '屋主';
      agentName = agentName.replace('屋主', '').trim();
    }

    return {
      id: String(item.id),
      title: item.title || '',
      price: item.price || '',
      priceUnit: item.price_unit || '元/月',
      priceNumber: item.price ? parseInt(String(item.price).replace(/,/g, ''), 10) : 0,
      propertyType: item.kind_name || '',
      size: String(item.area || ''),
      floor: item.floor_name || '',
      location: item.address || '',
      metroDistance: item.surrounding?.desc || '',
      tags: item.tags || [],
      agentType,
      agentName,
      updateInfo: item.refresh_time || '',
      views: item.browse_count || 0,
      url: `https://rent.591.com.tw/${item.id}`,
      sourceUrl,
    };
  });

  return listings;
}

async function crawlUrl(browser: Browser, baseUrl: string): Promise<ListingItem[]> {
  const allListings: ListingItem[] = [];

  for (let pageNum = 1; pageNum <= CONFIG.MAX_PAGES_PER_URL; pageNum++) {
    const url = pageNum === 1 ? baseUrl : `${baseUrl}&page=${pageNum}`;
    console.log(`  Page ${pageNum}: ${url}`);

    const page = await browser.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForSelector('.item-info-title, .item-title', { timeout: 10000 }).catch(() => {});

      const listings = await extractListingsFromPage(page, baseUrl);

      if (listings.length === 0) {
        console.log('  No more listings, stopping.');
        break;
      }

      allListings.push(...listings);
      console.log(`  Found ${listings.length} listings (total: ${allListings.length})`);

      if (pageNum < CONFIG.MAX_PAGES_PER_URL) {
        await new Promise(r => setTimeout(r, CONFIG.REQUEST_DELAY_MS));
      }
    } finally {
      await page.close();
    }
  }

  return allListings;
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log('='.repeat(60));
  console.log('591 Rental Crawler with Google Sheets');
  console.log('='.repeat(60));

  // Connect to Google Sheets
  console.log('\n📊 Connecting to Google Sheets...');
  const doc = await connectToGoogleSheets();
  const sheet = await ensureDataSheet(doc);
  const existingProperties = await getExistingProperties(sheet);
  console.log(`Found ${existingProperties.size} existing properties in sheet`);

  // Launch browser
  console.log('\n🌐 Launching browser...');
  const browser = await chromium.launch({ headless: true });

  try {
    const allListings: ListingItem[] = [];

    // Crawl each URL
    for (const url of CONFIG.URLS) {
      console.log(`\n📍 Crawling: ${url}`);
      const listings = await crawlUrl(browser, url);
      allListings.push(...listings);
    }

    console.log(`\n📊 Total listings crawled: ${allListings.length}`);

    // Deduplicate by ID
    const uniqueListings = Array.from(
      new Map(allListings.map(l => [l.id, l])).values()
    );
    console.log(`Unique listings: ${uniqueListings.length}`);

    // Write to Google Sheets
    console.log('\n💾 Writing to Google Sheets...');
    const { added, updated } = await writeListingsToSheet(sheet, uniqueListings, existingProperties);
    console.log(`✅ Added: ${added}, Updated: ${updated}`);

  } finally {
    await browser.close();
  }

  console.log('\n' + '='.repeat(60));
  console.log('Crawl complete!');
  console.log('='.repeat(60));
}

main().catch(console.error);
