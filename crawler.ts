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

import "dotenv/config";
import { chromium, Browser, Page } from "playwright";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

// ============================================================
// CONFIGURATION - Edit these values
// ============================================================
const CONFIG = {
  // URLs to crawl (same format as your Config sheet)
  // Use sort=posttime_desc to get newest listings first
  URLS: [
    "https://rent.591.com.tw/list?region=1&kind=1&section=5,3,1,2&price=15000$_40000$&sort=posttime_desc&layout=3,4,2",
    "https://rent.591.com.tw/list?region=1&kind=1&metro=168&price=15000$_40000$&sort=posttime_desc&station=4181,4242,4187,4221&layout=3,4,2",
    // Add more URLs here
  ],

  // Crawling settings
  MAX_PAGES_PER_URL: 10, // Max pages per URL (30 items/page)
  MAX_ITEMS_PER_URL: 50, // Max items to fetch per URL (0 = unlimited)
  REQUEST_DELAY_MS: 2000, // Base delay + 0~4000ms random (2~6 seconds)

  // Sheet names
  SHEET_DATA: "Data",
  SHEET_CONFIG: "Config",
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
  "Property ID": string;
  Title: string; // Contains HYPERLINK formula with URL
  Price: string;
  "Price (Number)": number;
  "Property Type": string;
  "Size (坪)": string;
  Floor: string;
  Location: string;
  "Metro Distance": string;
  Tags: string;
  "Agent Type": string;
  "Agent Name": string;
  "Update Info": string;
  Views: number;
  "Source URL": string;
  "First Seen": string;
  "Last Updated": string;
  Status: string;
}

// ============================================================
// GOOGLE SHEETS CONNECTION
// ============================================================
async function connectToGoogleSheets(): Promise<GoogleSpreadsheet> {
  const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  const sheetId = process.env.GOOGLE_SHEETS_ID;

  if (!serviceAccountEmail || !privateKey || !sheetId) {
    throw new Error(
      "Missing environment variables. Required:\n" +
        "  GOOGLE_SHEETS_ID\n" +
        "  GOOGLE_SERVICE_ACCOUNT_EMAIL\n" +
        "  GOOGLE_PRIVATE_KEY"
    );
  }

  const auth = new JWT({
    email: serviceAccountEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
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
        "★ Mark",
        "★ Rating",
        "★ Remarks",
        "Property ID",
        "Title", // Hyperlink to property URL
        "Price",
        "Price (Number)",
        "Property Type",
        "Size (坪)",
        "Floor",
        "Location",
        "Metro Distance",
        "Tags",
        "Agent Type",
        "Agent Name",
        "Update Info",
        "Views",
        "Source URL",
        "First Seen",
        "Last Updated",
        "Status",
      ],
    });
  }

  return sheet;
}

async function getExistingProperties(sheet: any): Promise<Map<string, any>> {
  const rows = await sheet.getRows();
  const map = new Map();

  for (const row of rows) {
    const id = row.get("Property ID");
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
): Promise<{ added: number; updated: number; unchanged: number }> {
  // Format: YYYY-MM-DD HH:MM:SS
  const now = new Date()
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  const seenIds = new Set<string>();
  const newRows: any[][] = []; // Collect new rows to insert at top

  for (const listing of listings) {
    seenIds.add(listing.id);
    const existingRow = existingProperties.get(listing.id);

    // Create hyperlink formula: =HYPERLINK("url", "title")
    const titleWithLink = `=HYPERLINK("${
      listing.url
    }", "${listing.title.replace(/"/g, '""')}")`;

    if (existingRow) {
      // Check if any data changed (compare key fields)
      const priceStr = `${listing.price}${listing.priceUnit}`;
      const tagsStr = listing.tags.join(", ");

      const hasChanges =
        existingRow.get("Title") !== titleWithLink ||
        existingRow.get("Price") !== priceStr ||
        Number(existingRow.get("Price (Number)")) !== listing.priceNumber ||
        existingRow.get("Property Type") !== listing.propertyType ||
        existingRow.get("Size (坪)") !== listing.size ||
        existingRow.get("Floor") !== listing.floor ||
        existingRow.get("Location") !== listing.location ||
        existingRow.get("Metro Distance") !== listing.metroDistance ||
        existingRow.get("Tags") !== tagsStr ||
        existingRow.get("Agent Type") !== listing.agentType ||
        existingRow.get("Agent Name") !== listing.agentName ||
        existingRow.get("Update Info") !== listing.updateInfo ||
        existingRow.get("Status") !== "Active";
      // Note: Views excluded from change detection (changes too frequently)

      if (hasChanges) {
        // Update existing row (preserve user columns A-C)
        existingRow.set("Title", titleWithLink);
        existingRow.set("Price", priceStr);
        existingRow.set("Price (Number)", listing.priceNumber);
        existingRow.set("Property Type", listing.propertyType);
        existingRow.set("Size (坪)", listing.size);
        existingRow.set("Floor", listing.floor);
        existingRow.set("Location", listing.location);
        existingRow.set("Metro Distance", listing.metroDistance);
        existingRow.set("Tags", tagsStr);
        existingRow.set("Agent Type", listing.agentType);
        existingRow.set("Agent Name", listing.agentName);
        existingRow.set("Update Info", listing.updateInfo);
        existingRow.set("Views", listing.views);
        existingRow.set("Source URL", listing.sourceUrl);
        existingRow.set("Last Updated", now);
        existingRow.set("Status", "Active");
        await existingRow.save();
        updated++;
      } else {
        unchanged++;
      }
    } else {
      // Collect new rows to insert at top later
      newRows.push([
        "", // ★ Mark
        "", // ★ Rating
        "", // ★ Remarks
        listing.id,
        titleWithLink,
        `${listing.price}${listing.priceUnit}`,
        listing.priceNumber,
        listing.propertyType,
        listing.size,
        listing.floor,
        listing.location,
        listing.metroDistance,
        listing.tags.join(", "),
        listing.agentType,
        listing.agentName,
        listing.updateInfo,
        listing.views,
        listing.sourceUrl,
        now, // First Seen
        now, // Last Updated
        "Active",
      ]);
      added++;
    }
  }

  // Insert new rows at the top (after header row)
  if (newRows.length > 0) {
    console.log(`  Inserting ${newRows.length} new rows at top...`);
    // Insert blank rows at position 1 (after header)
    await sheet.insertDimension(
      "ROWS",
      { startIndex: 1, endIndex: 1 + newRows.length },
      false
    );
    // Load cells and set values
    await sheet.loadCells({
      startRowIndex: 1,
      endRowIndex: 1 + newRows.length,
      startColumnIndex: 0,
      endColumnIndex: 21,
    });
    for (let i = 0; i < newRows.length; i++) {
      const rowData = newRows[i];
      for (let j = 0; j < rowData.length; j++) {
        const cell = sheet.getCell(1 + i, j);
        cell.value = rowData[j];
      }
    }
    await sheet.saveUpdatedCells();
  }

  // Mark properties not found as Inactive
  for (const [id, row] of existingProperties) {
    if (!seenIds.has(id) && row.get("Status") === "Active") {
      row.set("Status", "Inactive");
      row.set("Last Updated", now);
      await row.save();
    }
  }

  return { added, updated, unchanged };
}

// ============================================================
// CRAWLER FUNCTIONS
// ============================================================
async function extractListingsFromPage(
  page: Page,
  sourceUrl: string
): Promise<ListingItem[]> {
  await page.waitForLoadState("networkidle");

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
    console.log("Could not extract __NUXT__ data");
    return [];
  }

  const listings: ListingItem[] = nuxtData.items.map((item: any) => {
    let agentType = "";
    let agentName = item.role_name || "";

    if (agentName.includes("仲介")) {
      agentType = "仲介";
      agentName = agentName.replace("仲介", "").trim();
    } else if (agentName.includes("屋主")) {
      agentType = "屋主";
      agentName = agentName.replace("屋主", "").trim();
    }

    return {
      id: String(item.id),
      title: item.title || "",
      price: item.price || "",
      priceUnit: item.price_unit || "元/月",
      priceNumber: item.price
        ? parseInt(String(item.price).replace(/,/g, ""), 10)
        : 0,
      propertyType: item.kind_name || "",
      size: String(item.area || ""),
      floor: item.floor_name || "",
      location: item.address || "",
      metroDistance: item.surrounding?.desc || "",
      tags: item.tags || [],
      agentType,
      agentName,
      updateInfo: item.refresh_time || "",
      views: item.browse_count || 0,
      url: `https://rent.591.com.tw/${item.id}`,
      sourceUrl,
    };
  });

  return listings;
}

async function crawlUrl(
  browser: Browser,
  baseUrl: string
): Promise<ListingItem[]> {
  const allListings: ListingItem[] = [];
  const maxItems = CONFIG.MAX_ITEMS_PER_URL;

  for (let pageNum = 1; pageNum <= CONFIG.MAX_PAGES_PER_URL; pageNum++) {
    // Check if we've reached the item limit
    if (maxItems > 0 && allListings.length >= maxItems) {
      console.log(`  Reached ${maxItems} items limit, stopping.`);
      break;
    }

    const url = pageNum === 1 ? baseUrl : `${baseUrl}&page=${pageNum}`;
    console.log(`  Page ${pageNum}: ${url}`);

    const page = await browser.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page
        .waitForSelector(".item-info-title, .item-title", { timeout: 10000 })
        .catch(() => {});

      const listings = await extractListingsFromPage(page, baseUrl);

      if (listings.length === 0) {
        console.log("  No more listings, stopping.");
        break;
      }

      allListings.push(...listings);
      console.log(
        `  Found ${listings.length} listings (total: ${allListings.length})`
      );

      if (pageNum < CONFIG.MAX_PAGES_PER_URL) {
        // Random delay: base + 0ms to base + 4000ms
        const delay =
          CONFIG.REQUEST_DELAY_MS + Math.floor(Math.random() * 4000);
        console.log(`  Waiting ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    } finally {
      await page.close();
    }
  }

  // Apply item limit
  if (maxItems > 0 && allListings.length > maxItems) {
    console.log(`  Trimming to ${maxItems} items`);
    return allListings.slice(0, maxItems);
  }

  return allListings;
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log("=".repeat(60));
  console.log("591 Rental Crawler with Google Sheets");
  console.log("=".repeat(60));

  // Connect to Google Sheets
  console.log("\n📊 Connecting to Google Sheets...");
  const doc = await connectToGoogleSheets();
  const sheet = await ensureDataSheet(doc);
  const existingProperties = await getExistingProperties(sheet);
  console.log(`Found ${existingProperties.size} existing properties in sheet`);

  // Launch browser
  console.log("\n🌐 Launching browser...");
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
      new Map(allListings.map((l) => [l.id, l])).values()
    );
    console.log(`Unique listings: ${uniqueListings.length}`);

    // Write to Google Sheets
    console.log("\n💾 Writing to Google Sheets...");
    const { added, updated, unchanged } = await writeListingsToSheet(
      sheet,
      uniqueListings,
      existingProperties
    );
    console.log(`✅ Added: ${added}, Updated: ${updated}, Unchanged: ${unchanged}`);
  } finally {
    await browser.close();
  }

  console.log("\n" + "=".repeat(60));
  console.log("Crawl complete!");
  console.log("=".repeat(60));
}

main().catch(console.error);
