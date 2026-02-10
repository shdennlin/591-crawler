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

import { chromium, Browser, Page, BrowserContext, Response } from 'playwright';
import * as fs from 'fs';

const TEST_URL = 'https://rent.591.com.tw/list?region=3&kind=3';

// ============================================================
// STEALTH & CHALLENGE DETECTION
// ============================================================
async function createStealthContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
    extraHTTPHeaders: {
      'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Upgrade-Insecure-Requests': '1',
    },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  return context;
}

async function detectChallengePage(
  response: Response | null,
  page: Page,
  url: string
): Promise<{ blocked: boolean; reason: string }> {
  if (!response) {
    return { blocked: true, reason: 'No response received' };
  }
  const status = response.status();
  if (status === 403) {
    return { blocked: true, reason: 'HTTP 403 Forbidden (anti-bot)' };
  }
  if (status === 429) {
    return { blocked: true, reason: 'HTTP 429 Too Many Requests (rate limited)' };
  }

  const finalUrl = response.url();
  if (finalUrl !== url && !finalUrl.startsWith('https://rent.591.com.tw/')) {
    return { blocked: true, reason: `Redirected to ${finalUrl}` };
  }

  return { blocked: false, reason: '' };
}

async function detectChallengeContent(
  page: Page
): Promise<{ blocked: boolean; reason: string }> {
  const title = await page.title().catch(() => '');
  const challengeTitles = [
    /just a moment/i,
    /checking your browser/i,
    /cloudflare/i,
    /attention required/i,
    /please wait/i,
  ];
  for (const pattern of challengeTitles) {
    if (pattern.test(title)) {
      return { blocked: true, reason: `Challenge page: "${title}"` };
    }
  }

  const bodyText = await page
    .evaluate(() => document.body?.innerText?.slice(0, 2000) || '')
    .catch(() => '');
  const challengePatterns = [
    /cloudflare/i,
    /ray id/i,
    /captcha/i,
    /human verification/i,
    /enable javascript and cookies/i,
  ];
  for (const pattern of challengePatterns) {
    if (pattern.test(bodyText)) {
      return { blocked: true, reason: 'Anti-bot content detected on page' };
    }
  }

  return { blocked: false, reason: '' };
}

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
  // __NUXT__ is server-rendered in HTML — try extracting immediately after domcontentloaded.
  // Only fall back to networkidle wait if data isn't available yet.
  const extractNuxt = () =>
    page.evaluate(() => {
      const nuxt = (window as any).__NUXT__;
      if (!nuxt || !nuxt.data) return null;

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

  let nuxtData = await extractNuxt();

  if (!nuxtData || !nuxtData.items) {
    await page
      .waitForLoadState('networkidle', { timeout: 15_000 })
      .catch(() => {
        console.log('  networkidle timeout, proceeding with available data...');
      });
    nuxtData = await extractNuxt();
  }

  if (!nuxtData || !nuxtData.items) {
    const challenge = await detectChallengeContent(page);
    if (challenge.blocked) {
      console.log(`  ⚠️ ${challenge.reason}`);
    } else {
      console.log('  ⚠️ Could not extract __NUXT__ data (page may have changed structure)');
    }
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

async function crawlPage(context: BrowserContext, url: string, pageNum: number): Promise<ListingItem[]> {
  const fullUrl = pageNum === 1 ? url : `${url}&page=${pageNum}`;
  console.log(`\nFetching page ${pageNum}: ${fullUrl}`);

  const page = await context.newPage();

  try {
    const response = await page.goto(fullUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    const challenge = await detectChallengePage(response, page, fullUrl);
    if (challenge.blocked) {
      console.log(`  ⚠️ Blocked: ${challenge.reason}`);
      return [];
    }

    // Wait for listings to appear
    await page.waitForSelector('.item-info-title, .item-title', { timeout: 10000 }).catch(() => {});

    const listings = await extractListingsFromPage(page);
    return listings;
  } finally {
    await Promise.race([
      page.close(),
      new Promise<void>((r) => setTimeout(r, 5000)),
    ]).catch(() => {});
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('591 Rental Crawler - Playwright Test');
  console.log('='.repeat(60));

  console.log('\nLaunching browser...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await createStealthContext(browser);

  try {
    const allListings: ListingItem[] = [];
    const maxPages = 3; // Test with first 3 pages

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      try {
        const listings = await crawlPage(context, TEST_URL, pageNum);

        if (listings.length === 0) {
          console.log('No more listings found, stopping');
          break;
        }

        allListings.push(...listings);
        console.log(`Page ${pageNum}: ${listings.length} listings (total: ${allListings.length})`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`  ⚠️ Page ${pageNum} error: ${message}`);
        if (message.includes('Timeout') || message.includes('timed out')) {
          console.log('  Skipping remaining pages.');
          break;
        }
      }

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
    await Promise.race([
      context.close(),
      new Promise<void>((r) => setTimeout(r, 5_000)),
    ]).catch(() => {});
    await Promise.race([
      browser.close(),
      new Promise<void>((r) => setTimeout(r, 10_000)),
    ]).catch(() => {});
  }

  console.log('\n' + '='.repeat(60));
  console.log('Test complete!');
  console.log('='.repeat(60));
}

main().catch(console.error);
