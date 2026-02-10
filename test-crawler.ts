/**
 * 591 Rental Crawler - Local Test Script with Playwright
 *
 * Prerequisites:
 *   npm init -y
 *   npm install playwright typescript tsx
 *   npx playwright install chromium
 *
 * Run with: npx tsx test-crawler.ts
 */

import { chromium, Browser, Page } from 'playwright';
import * as fs from 'fs';

const TEST_URL = 'https://rent.591.com.tw/list?region=3&kind=3';

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
}

interface NuxtListData {
  items: any[];
  total: string | number;
  firstRow: number;
}

async function extractListingsFromPage(page: Page): Promise<ListingItem[]> {
  // Wait for the page to load completely (15s timeout — graceful degradation)
  await page
    .waitForLoadState('networkidle', { timeout: 15_000 })
    .catch(() => {
      console.log('  networkidle timeout, proceeding with available data...');
    });

  // Extract data from window.__NUXT__
  const nuxtData = await page.evaluate(() => {
    const nuxt = (window as any).__NUXT__;
    if (!nuxt || !nuxt.data) return null;

    // Find the data key that contains items
    for (const key of Object.keys(nuxt.data)) {
      const entry = nuxt.data[key];
      if (entry && entry.data && entry.data.items) {
        return {
          items: entry.data.items,
          total: entry.data.total,
          firstRow: entry.data.firstRow || 0
        };
      }
    }
    return null;
  });

  if (!nuxtData || !nuxtData.items) {
    console.log('Could not extract __NUXT__ data');
    return [];
  }

  console.log(`Found ${nuxtData.items.length} items, total: ${nuxtData.total}`);

  // Transform items to our format
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
    };
  });

  return listings;
}

async function crawlPage(browser: Browser, url: string, pageNum: number): Promise<ListingItem[]> {
  const fullUrl = pageNum === 1 ? url : `${url}&page=${pageNum}`;
  console.log(`\nFetching page ${pageNum}: ${fullUrl}`);

  const page = await browser.newPage();

  try {
    await page.goto(fullUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    // Wait for listings to appear
    await page.waitForSelector('.item-info-title, .item-title', { timeout: 10000 }).catch(() => {});

    const listings = await extractListingsFromPage(page);
    return listings;
  } finally {
    await page.close();
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('591 Rental Crawler - Playwright Test');
  console.log('='.repeat(60));

  console.log('\nLaunching browser...');
  const browser = await chromium.launch({
    headless: true,
  });

  try {
    const allListings: ListingItem[] = [];
    const maxPages = 3; // Test with first 3 pages

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      const listings = await crawlPage(browser, TEST_URL, pageNum);

      if (listings.length === 0) {
        console.log('No more listings found, stopping');
        break;
      }

      allListings.push(...listings);
      console.log(`Page ${pageNum}: ${listings.length} listings (total: ${allListings.length})`);

      // Small delay between pages
      if (pageNum < maxPages) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    console.log(`\n📊 Total: ${allListings.length} listings from ${maxPages} pages`);

    if (allListings.length > 0) {
      console.log('\n--- Sample Listings ---\n');

      // Show first 5 listings
      allListings.slice(0, 5).forEach((listing, idx) => {
        console.log(`[${idx + 1}] ${listing.title}`);
        console.log(`    ID: ${listing.id}`);
        console.log(`    Price: ${listing.price}${listing.priceUnit} (${listing.priceNumber})`);
        console.log(`    Type: ${listing.propertyType} | Size: ${listing.size}坪 | Floor: ${listing.floor}`);
        console.log(`    Location: ${listing.location}`);
        console.log(`    Agent: ${listing.agentType} ${listing.agentName}`);
        console.log(`    Tags: ${listing.tags.join(', ')}`);
        console.log(`    Update: ${listing.updateInfo} | Views: ${listing.views}`);
        console.log(`    URL: ${listing.url}`);
        console.log('');
      });

      // Save to JSON file
      const outputFile = 'test-output.json';
      fs.writeFileSync(outputFile, JSON.stringify(allListings, null, 2), 'utf-8');
      console.log(`💾 Full results saved to: ${outputFile}`);

      // Save to CSV
      const csvFile = 'test-output.csv';
      const csvHeader = 'ID,Title,Price,PriceNumber,Type,Size,Floor,Location,AgentType,AgentName,UpdateInfo,Views,Tags,URL\n';
      const csvRows = allListings.map(l =>
        `"${l.id}","${l.title.replace(/"/g, '""')}","${l.price}${l.priceUnit}",${l.priceNumber},"${l.propertyType}","${l.size}","${l.floor}","${l.location}","${l.agentType}","${l.agentName}","${l.updateInfo}",${l.views},"${l.tags.join('; ')}","${l.url}"`
      ).join('\n');
      fs.writeFileSync(csvFile, csvHeader + csvRows, 'utf-8');
      console.log(`💾 CSV saved to: ${csvFile}`);
    }

  } finally {
    await browser.close();
  }

  console.log('\n' + '='.repeat(60));
  console.log('Test complete!');
  console.log('='.repeat(60));
}

main().catch(console.error);
