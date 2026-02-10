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
import { chromium, Browser, Page, BrowserContext, Response } from "playwright";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

// ============================================================
// CONFIGURATION - Edit these values
// ============================================================
const CONFIG = {
  // Crawling settings
  MAX_PAGES_PER_URL: 10, // Max pages per URL (30 items/page)
  MAX_ITEMS_PER_URL: 30, // Max items to fetch per URL (0 = unlimited)
  REQUEST_DELAY_MS: 2000, // Base delay + 0~4000ms random (2~6 seconds)

  // Timeout settings (ms)
  PAGE_GOTO_TIMEOUT_MS: 30_000, // page.goto timeout
  PAGE_SELECTOR_TIMEOUT_MS: 10_000, // waitForSelector timeout
  NETWORK_IDLE_TIMEOUT_MS: 15_000, // networkidle wait — graceful degradation
  PAGE_CRAWL_TIMEOUT_MS: 60_000, // per-page overall safety net
  PAGE_RETRY_COUNT: 3, // max retries for non-timeout page errors
  SHEET_OPERATION_TIMEOUT_MS: 30_000, // per Sheets API call timeout
  SHEET_RETRY_COUNT: 3, // max retries for Sheets operations
  SHEET_RETRY_DELAY_MS: 2_000, // base delay between retries (linear backoff)

  // Sheet names
  SHEET_DATA: "Data",
  SHEET_CONFIG: "Config",
};

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  options: { maxRetries?: number; timeoutMs?: number; retryDelayMs?: number } = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? CONFIG.SHEET_RETRY_COUNT;
  const timeoutMs = options.timeoutMs ?? CONFIG.SHEET_OPERATION_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? CONFIG.SHEET_RETRY_DELAY_MS;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs)
        ),
      ]);
      return result;
    } catch (error) {
      const isLastAttempt = attempt === maxRetries;
      if (isLastAttempt) {
        console.error(`  ❌ ${label} failed after ${maxRetries} attempt(s): ${error}`);
        throw error;
      }
      const delay = retryDelayMs * attempt;
      console.log(`  ⚠️ ${label} attempt ${attempt} failed, retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("Unreachable");
}


/**
 * Parse environment variables to find all configured Google Sheets.
 * Supports: GOOGLE_SHEETS_ID (default) and GOOGLE_SHEETS_ID_<name> (named sheets)
 */
function getSheetConfigs(): { name: string; id: string }[] {
  const configs: { name: string; id: string }[] = [];

  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("GOOGLE_SHEETS_ID") && value) {
      const suffix = key.replace("GOOGLE_SHEETS_ID", "");
      const name = suffix ? suffix.replace(/^_/, "").toLowerCase() : "default";
      configs.push({ name, id: value });
    }
  }

  return configs;
}

// ============================================================
// STEALTH & CHALLENGE DETECTION
// ============================================================
async function createStealthContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    locale: "zh-TW",
    timezoneId: "Asia/Taipei",
    extraHTTPHeaders: {
      "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      "Upgrade-Insecure-Requests": "1",
    },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  return context;
}

async function detectChallengePage(
  response: Response | null,
  page: Page,
  url: string
): Promise<{ blocked: boolean; reason: string }> {
  if (!response) {
    return { blocked: true, reason: "No response received" };
  }
  const status = response.status();
  if (status === 403) {
    return { blocked: true, reason: "HTTP 403 Forbidden (anti-bot)" };
  }
  if (status === 429) {
    return { blocked: true, reason: "HTTP 429 Too Many Requests (rate limited)" };
  }

  const finalUrl = response.url();
  if (finalUrl !== url && !finalUrl.startsWith("https://rent.591.com.tw/")) {
    return { blocked: true, reason: `Redirected to ${finalUrl}` };
  }

  return { blocked: false, reason: "" };
}

async function detectChallengeContent(
  page: Page
): Promise<{ blocked: boolean; reason: string }> {
  const title = await page.title().catch(() => "");
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
    .evaluate(() => document.body?.innerText?.slice(0, 2000) || "")
    .catch(() => "");
  const challengePatterns = [
    /cloudflare/i,
    /ray id/i,
    /captcha/i,
    /human verification/i,
    /enable javascript and cookies/i,
  ];
  for (const pattern of challengePatterns) {
    if (pattern.test(bodyText)) {
      return { blocked: true, reason: "Anti-bot content detected on page" };
    }
  }

  return { blocked: false, reason: "" };
}

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
  Price: number; // Numeric value, displayed with format "#,##0元/月"
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
async function connectToGoogleSheets(sheetId: string): Promise<GoogleSpreadsheet> {
  const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!serviceAccountEmail || !privateKey) {
    throw new Error(
      "Missing credentials. Required:\n" +
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
  await withRetry(() => doc.loadInfo(), "loadInfo");
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
        "Price", // Numeric value with display format "#,##0元/月"
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

async function formatConfigSheet(sheet: any) {
  // Load cells for columns A-F (data columns + helper columns)
  // Rows: header (0), example (1), instructions (2-6)
  await withRetry(
    () =>
      sheet.loadCells({
        startRowIndex: 0,
        endRowIndex: 7,
        startColumnIndex: 0,
        endColumnIndex: 6,
      }),
    "loadCells (formatConfig)"
  );

  // === Column A-C: Data columns ===
  const headerNotes = [
    "Enter 591.com.tw search URLs here. You can modify these URLs anytime.",
    "Optional: A friendly description for this search",
    "Set to 'Active' to crawl this URL, or 'Inactive' to skip it",
  ];

  // Format header row (row 0) - Light blue background
  for (let col = 0; col < 3; col++) {
    const cell = sheet.getCell(0, col);
    cell.backgroundColor = { red: 0.89, green: 0.95, blue: 0.99 }; // Light blue #E3F2FD
    cell.textFormat = { bold: true };
    cell.note = headerNotes[col];
  }

  // === Column D: Spacer ===
  // (empty column for visual separation)

  // === Column E-F: Helper/Instructions columns ===
  const helperContent = [
    // Row 0: Helper header
    { col: 4, row: 0, value: "📖 Instructions", bold: true },
    { col: 5, row: 0, value: "", bold: false },

    // Row 1: Example header
    { col: 4, row: 1, value: "Example:", bold: true },
    { col: 5, row: 1, value: "", bold: false },

    // Row 2: Example URL
    {
      col: 4,
      row: 2,
      value: "URL:",
      bold: false,
    },
    {
      col: 5,
      row: 2,
      value: "https://rent.591.com.tw/list?region=1&kind=1&price=15000$_40000$&sort=posttime_desc",
      bold: false,
    },

    // Row 3: Example Description
    { col: 4, row: 3, value: "Description:", bold: false },
    { col: 5, row: 3, value: "Taipei < 40k", bold: false },

    // Row 4: Example Status
    { col: 4, row: 4, value: "Status:", bold: false },
    { col: 5, row: 4, value: "Active", bold: false },

    // Row 5: Tips header
    { col: 4, row: 5, value: "💡 Tips:", bold: true },
    { col: 5, row: 5, value: "", bold: false },

    // Row 6: Tips content
    { col: 4, row: 6, value: "• Set Status to 'Inactive' to skip a URL", bold: false },
    { col: 5, row: 6, value: "• Get URLs from 591.com.tw search page", bold: false },
  ];

  // Apply helper content with gray background
  for (const item of helperContent) {
    const cell = sheet.getCell(item.row, item.col);
    cell.value = item.value;
    cell.backgroundColor = { red: 0.95, green: 0.95, blue: 0.95 }; // Light gray #F2F2F2
    if (item.bold) {
      cell.textFormat = { bold: true };
    }
  }

  await withRetry(() => sheet.saveUpdatedCells(), "saveUpdatedCells (formatConfig)");
  console.log("  ✨ Config sheet formatted with colors, notes, and instructions");
}

async function ensureConfigSheet(doc: GoogleSpreadsheet): Promise<string[]> {
  let sheet = doc.sheetsByTitle[CONFIG.SHEET_CONFIG];

  if (!sheet) {
    console.log(`Creating "${CONFIG.SHEET_CONFIG}" sheet...`);
    sheet = await doc.addSheet({
      title: CONFIG.SHEET_CONFIG,
      headerValues: ["URL", "Description", "Status"],
    });

    // Format and add helper instructions
    await formatConfigSheet(sheet);
  }

  // Read active URLs from sheet
  const rows = await withRetry<any[]>(() => sheet.getRows(), "getRows (config)");
  const activeUrls: string[] = [];

  for (const row of rows) {
    const url = row.get("URL");
    const status = row.get("Status");
    if (url && status?.toLowerCase() === "active") {
      activeUrls.push(url);
    }
  }

  if (activeUrls.length === 0) {
    console.log("\n" + "=".repeat(60));
    console.log("⚠️  NO URLS CONFIGURED");
    console.log("=".repeat(60));
    console.log("\nPlease add URLs to the Config sheet in Google Sheets:");
    console.log(`  📋 Sheet: "${CONFIG.SHEET_CONFIG}"`);
    console.log("\nSee the instructions on the right side of the sheet (columns E-F)");
    console.log("or follow this format:");
    console.log("  | URL                              | Description | Status |");
    console.log("  |----------------------------------|-------------|--------|");
    console.log("  | https://rent.591.com.tw/list?... | My search   | Active |");
    console.log("\nSet Status to 'Active' for URLs you want to crawl.");
    console.log("Run the crawler again after configuring the sheet.");
    console.log("=".repeat(60) + "\n");
    
    // Throw error instead of process.exit() to allow other sheets to continue
    throw new Error("No active URLs configured in Config sheet");
  }

  console.log(`📋 Loaded ${activeUrls.length} active URL(s) from Config sheet`);
  return activeUrls;
}

async function getExistingProperties(
  sheet: any
): Promise<Map<string, { row: any; rowIndex: number }>> {
  const rows = await withRetry<any[]>(() => sheet.getRows(), "getRows (data)");
  const map = new Map<string, { row: any; rowIndex: number }>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const id = row.get("Property ID");
    if (id) {
      // rowIndex is 1-based (0 is header), so actual row = i + 1
      map.set(id, { row, rowIndex: i + 1 });
    }
  }

  return map;
}

async function writeListingsToSheet(
  sheet: any,
  listings: ListingItem[],
  existingProperties: Map<string, { row: any; rowIndex: number }>
): Promise<{ added: number; updated: number; unchanged: number; inactive: number }> {
  // Format: YYYY-MM-DD HH:MM:SS
  const now = new Date()
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let inactive = 0;
  const seenIds = new Set<string>();
  const newRows: any[][] = []; // Collect new rows to insert at top

  // Collect updates for batch operation (columns E-T, indices 4-19)
  const rowsToUpdate: { rowIndex: number; data: any[] }[] = [];
  // Collect rows to mark as inactive
  const rowsToInactivate: number[] = [];

  for (const listing of listings) {
    seenIds.add(listing.id);
    const existing = existingProperties.get(listing.id);

    // Create hyperlink formula: =HYPERLINK("url", "title")
    const titleWithLink = `=HYPERLINK("${
      listing.url
    }", "${listing.title.replace(/"/g, '""')}")`;

    if (existing) {
      const { row: existingRow, rowIndex } = existing;
      // Check if any data changed (compare key fields)
      const tagsStr = listing.tags.join(", ");

      // Note: Title comparison uses raw title text (not HYPERLINK formula)
      // because sheet returns displayed value, not formula string
      const hasChanges =
        existingRow.get("Title") !== listing.title ||
        Number(existingRow.get("Price")) !== listing.priceNumber ||
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
        // Collect update data for batch operation (columns E-T, indices 4-19)
        rowsToUpdate.push({
          rowIndex,
          data: [
            titleWithLink, // E: Title (index 4)
            listing.priceNumber, // F: Price (index 5) - numeric with format
            listing.propertyType, // G: Property Type (index 6)
            listing.size, // H: Size (index 7)
            listing.floor, // I: Floor (index 8)
            listing.location, // J: Location (index 9)
            listing.metroDistance, // K: Metro Distance (index 10)
            tagsStr, // L: Tags (index 11)
            listing.agentType, // M: Agent Type (index 12)
            listing.agentName, // N: Agent Name (index 13)
            listing.updateInfo, // O: Update Info (index 14)
            listing.views, // P: Views (index 15)
            listing.sourceUrl, // Q: Source URL (index 16)
            null, // R: First Seen (index 17) - preserve
            now, // S: Last Updated (index 18)
            "Active", // T: Status (index 19)
          ],
        });
        updated++;
      } else {
        unchanged++;
      }
    } else {
      // Collect new rows to insert at top later
      newRows.push([
        "", // A: ★ Mark (index 0)
        "", // B: ★ Rating (index 1)
        "", // C: ★ Remarks (index 2)
        listing.id, // D: Property ID (index 3)
        titleWithLink, // E: Title (index 4)
        listing.priceNumber, // F: Price (index 5) - numeric with format
        listing.propertyType, // G: Property Type (index 6)
        listing.size, // H: Size (index 7)
        listing.floor, // I: Floor (index 8)
        listing.location, // J: Location (index 9)
        listing.metroDistance, // K: Metro Distance (index 10)
        listing.tags.join(", "), // L: Tags (index 11)
        listing.agentType, // M: Agent Type (index 12)
        listing.agentName, // N: Agent Name (index 13)
        listing.updateInfo, // O: Update Info (index 14)
        listing.views, // P: Views (index 15)
        listing.sourceUrl, // Q: Source URL (index 16)
        now, // R: First Seen (index 17)
        now, // S: Last Updated (index 18)
        "Active", // T: Status (index 19)
      ]);
      added++;
    }
  }

  // Collect rows to mark as inactive
  for (const [id, { row, rowIndex }] of existingProperties) {
    if (!seenIds.has(id) && row.get("Status") === "Active") {
      rowsToInactivate.push(rowIndex);
      inactive++;
    }
  }

  // Insert new rows at the top (after header row)
  if (newRows.length > 0) {
    console.log(`  Inserting ${newRows.length} new rows at top...`);
    try {
      // Insert blank rows at position 1 (after header)
      // insertDimension is NOT idempotent — timeout only, no retry
      await withRetry(
        () =>
          sheet.insertDimension(
            "ROWS",
            { startIndex: 1, endIndex: 1 + newRows.length },
            false
          ),
        "insertDimension",
        { maxRetries: 1 }
      );
      // Load cells and set values (columns A-T, 20 columns total)
      await withRetry(
        () =>
          sheet.loadCells({
            startRowIndex: 1,
            endRowIndex: 1 + newRows.length,
            startColumnIndex: 0,
            endColumnIndex: 20, // Column T: Status (index 19)
          }),
        "loadCells (newRows)"
      );
      for (let i = 0; i < newRows.length; i++) {
        const rowData = newRows[i];
        for (let j = 0; j < rowData.length; j++) {
          const cell = sheet.getCell(1 + i, j);
          cell.value = rowData[j];
          // Apply number format to Price column (index 5)
          if (j === 5 && rowData[j] !== null && rowData[j] !== "") {
            cell.numberFormat = { type: "NUMBER", pattern: '#,##0"元/月"' };
          }
        }
      }
      await withRetry(() => sheet.saveUpdatedCells(), "saveUpdatedCells (newRows)");

      // After inserting new rows, existing row indices shift down
      // Adjust rowsToUpdate and rowsToInactivate indices
      const shiftAmount = newRows.length;
      for (const update of rowsToUpdate) {
        update.rowIndex += shiftAmount;
      }
      for (let i = 0; i < rowsToInactivate.length; i++) {
        rowsToInactivate[i] += shiftAmount;
      }
    } catch (error) {
      console.error(`  ❌ Error inserting new rows:`, error);
      throw error;
    }
  }

  // Batch update existing rows and mark inactive (single API call)
  const allUpdateIndices = [
    ...rowsToUpdate.map((r) => r.rowIndex),
    ...rowsToInactivate,
  ];

  if (allUpdateIndices.length > 0) {
    const updateCount = rowsToUpdate.length;
    const inactiveCount = rowsToInactivate.length;
    console.log(
      `  Batch updating ${updateCount} rows, marking ${inactiveCount} inactive...`
    );

    try {
      const minRow = Math.min(...allUpdateIndices);
      const maxRow = Math.max(...allUpdateIndices);

      // Load all cells that need updating (columns E-T, indices 4-19)
      // Skip A-C (user columns) and D (Property ID - never changes)
      await withRetry(
        () =>
          sheet.loadCells({
            startRowIndex: minRow,
            endRowIndex: maxRow + 1,
            startColumnIndex: 4, // Column E: Title (skip A-D)
            endColumnIndex: 20, // Column T: Status (index 19)
          }),
        "loadCells (batchUpdate)"
      );

      // Apply updates (data array maps to columns E-T, indices 4-19)
      for (const { rowIndex, data } of rowsToUpdate) {
        for (let col = 0; col < data.length; col++) {
          // Skip null values (preserve existing, e.g., First Seen)
          if (data[col] !== null) {
            const cell = sheet.getCell(rowIndex, col + 4); // +4 = column E
            cell.value = data[col];
            // Apply number format to Price column (col 1 = index 5 after +4 offset)
            if (col === 1) {
              cell.numberFormat = { type: "NUMBER", pattern: '#,##0"元/月"' };
            }
          }
        }
      }

      // Apply inactive status (only Last Updated and Status columns)
      for (const rowIndex of rowsToInactivate) {
        sheet.getCell(rowIndex, 18).value = now; // S: Last Updated (index 18)
        sheet.getCell(rowIndex, 19).value = "Inactive"; // T: Status (index 19)
      }

      // Single batch save for all updates
      await withRetry(() => sheet.saveUpdatedCells(), "saveUpdatedCells (batchUpdate)");
    } catch (error) {
      console.error(`  ❌ Error in batch update:`, error);
      throw error;
    }
  }

  return { added, updated, unchanged, inactive };
}

// ============================================================
// CRAWLER FUNCTIONS
// ============================================================
async function extractListingsFromPage(
  page: Page,
  sourceUrl: string
): Promise<ListingItem[]> {
  await page
    .waitForLoadState("networkidle", { timeout: CONFIG.NETWORK_IDLE_TIMEOUT_MS })
    .catch(() => {
      console.log("  networkidle timeout, proceeding with available data...");
    });

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
    const challenge = await detectChallengeContent(page);
    if (challenge.blocked) {
      console.log(`  ⚠️ ${challenge.reason}`);
    } else {
      console.log("  ⚠️ Could not extract __NUXT__ data (page may have changed structure)");
    }
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
  context: BrowserContext,
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

    let succeeded = false;
    for (let attempt = 1; attempt <= CONFIG.PAGE_RETRY_COUNT; attempt++) {
      if (attempt > 1) {
        const delay =
          CONFIG.REQUEST_DELAY_MS + Math.floor(Math.random() * 4000);
        console.log(
          `  🔄 Retry ${attempt}/${CONFIG.PAGE_RETRY_COUNT} after ${delay}ms...`
        );
        await new Promise((r) => setTimeout(r, delay));
      }

      const page = await context.newPage();
      try {
        const listings = await Promise.race([
          (async () => {
            const response = await page.goto(url, {
              waitUntil: "domcontentloaded",
              timeout: CONFIG.PAGE_GOTO_TIMEOUT_MS,
            });

            const challenge = await detectChallengePage(response, page, url);
            if (challenge.blocked) {
              console.log(`  ⚠️ Blocked: ${challenge.reason}`);
              return [] as ListingItem[];
            }

            await page
              .waitForSelector(".item-info-title, .item-title", {
                timeout: CONFIG.PAGE_SELECTOR_TIMEOUT_MS,
              })
              .catch(() => {});

            return await extractListingsFromPage(page, baseUrl);
          })(),
          new Promise<ListingItem[]>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `Page ${pageNum} timed out after ${CONFIG.PAGE_CRAWL_TIMEOUT_MS}ms`
                  )
                ),
              CONFIG.PAGE_CRAWL_TIMEOUT_MS
            )
          ),
        ]);

        if (listings.length === 0) {
          console.log("  No more listings, stopping.");
          return allListings;
        }

        allListings.push(...listings);
        console.log(
          `  Found ${listings.length} listings (total: ${allListings.length})`
        );
        succeeded = true;
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`  ⚠️ Error: ${message}`);
        if (message.includes("timed out")) {
          console.log(`  Skipping remaining pages for this URL.`);
          return allListings;
        }
        if (attempt === CONFIG.PAGE_RETRY_COUNT) {
          console.log(
            `  ❌ Failed after ${CONFIG.PAGE_RETRY_COUNT} attempts, skipping page.`
          );
        }
      } finally {
        // Force-close with timeout to prevent hanging on stuck pages
        await Promise.race([
          page.close(),
          new Promise<void>((r) => setTimeout(r, 5000)),
        ]).catch(() => {});
      }
    }

    // Between-page delay (only after successful crawl)
    if (succeeded && pageNum < CONFIG.MAX_PAGES_PER_URL) {
      const delay =
        CONFIG.REQUEST_DELAY_MS + Math.floor(Math.random() * 4000);
      console.log(`  Waiting ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
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
/**
 * Process a single Google Sheet: crawl URLs and write listings
 */
async function processSheet(sheetName: string, sheetId: string): Promise<void> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`📊 Processing: ${sheetName}`);
  console.log("=".repeat(60));

  // Connect to Google Sheets
  console.log("\n📊 Connecting to Google Sheets...");
  const doc = await connectToGoogleSheets(sheetId);

  // Load URLs from Config sheet (creates if not exists)
  const urls = await ensureConfigSheet(doc);

  const sheet = await ensureDataSheet(doc);
  const existingProperties = await getExistingProperties(sheet);
  console.log(`Found ${existingProperties.size} existing properties in sheet`);

  // Launch browser with stealth
  console.log("\n🌐 Launching browser...");
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await createStealthContext(browser);

  try {
    const allListings: ListingItem[] = [];

    // Crawl each URL from Config sheet
    for (let i = 0; i < urls.length; i++) {
      if (i > 0) {
        const delay = CONFIG.REQUEST_DELAY_MS + Math.floor(Math.random() * 4000);
        console.log(`\n⏳ Waiting ${delay}ms before next URL...`);
        await new Promise((r) => setTimeout(r, delay));
      }
      console.log(`\n📍 Crawling: ${urls[i]}`);
      const listings = await crawlUrl(context, urls[i]);
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
    const { added, updated, unchanged, inactive } = await writeListingsToSheet(
      sheet,
      uniqueListings,
      existingProperties
    );
    console.log(
      `✅ Added: ${added}, Updated: ${updated}, Unchanged: ${unchanged}, Inactive: ${inactive}`
    );
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

  console.log(`\n✅ Completed: ${sheetName}`);
}

async function main() {
  const sheetConfigs = getSheetConfigs();

  if (sheetConfigs.length === 0) {
    throw new Error(
      "No Google Sheets configured.\n" +
        "Set GOOGLE_SHEETS_ID or GOOGLE_SHEETS_ID_<name> environment variables."
    );
  }

  console.log("=".repeat(60));
  console.log("591 Rental Crawler with Google Sheets");
  console.log("=".repeat(60));
  console.log(
    `\nFound ${sheetConfigs.length} sheet(s): ${sheetConfigs.map((c) => c.name).join(", ")}`
  );

  const results: { name: string; success: boolean; error?: string }[] = [];

  for (const config of sheetConfigs) {
    try {
      await processSheet(config.name, config.id);
      results.push({ name: config.name, success: true });
    } catch (error) {
      console.error(`\n❌ Failed: ${config.name} - ${error}`);
      results.push({
        name: config.name,
        success: false,
        error: String(error),
      });
    }
  }

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("Summary:");
  for (const r of results) {
    console.log(`  ${r.success ? "✅" : "❌"} ${r.name}`);
  }
  console.log("=".repeat(60));

  // Throw if all sheets failed
  const allFailed = results.every((r) => !r.success);
  if (allFailed) {
    throw new Error("All sheets failed to process");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
