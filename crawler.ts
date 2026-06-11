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
import {
  refreshToAbsolute,
  shouldUpdateRefresh,
  formatTaipei,
} from "./time-utils";

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
  URL_RETRY_COUNT: 3, // max attempts per URL (1 original + 2 retries) when 0 listings returned
  URL_RETRY_DELAY_MS: 45_000, // delay between URL-level retries (45s)
  SHEET_OPERATION_TIMEOUT_MS: 30_000, // per Sheets API call timeout
  SHEET_RETRY_COUNT: 3, // max retries for Sheets operations
  SHEET_RETRY_DELAY_MS: 2_000, // base delay between retries (linear backoff)

  // Publish/update time settings
  // "更新時間" is derived from a coarse relative string and recomputed each run,
  // so it drifts a few hours. Only treat a newer value as a *real* refresh when
  // it jumps ahead by more than this (must exceed the max crawl-schedule gap).
  REFRESH_UPDATE_THRESHOLD_MS: 12 * 60 * 60 * 1000,

  // Sheet names
  SHEET_DATA: "Data",
  SHEET_CONFIG: "Config",

  // User-facing crawl frequency, shown in the Config sheet so sheet viewers know
  // how fresh the data is. KEEP IN SYNC with the live schedule (the homelab cron
  // in CT 130's root crontab — the GitHub schedule in crawl.yml is disabled).
  // There's no runtime API to read the cron, so this label is maintained by hand.
  CRAWL_SCHEDULE_NOTE:
    "每天自動更新 9 次（台灣時間 05:00 / 07:00 / 10:00 / 12:00 / 14:00 / 17:00 / 19:00 / 21:00 / 24:00）",
};

// ============================================================
// DATA SHEET COLUMN LAYOUT
// ============================================================
// Single source of truth for column order. Adding a column here keeps every
// index-based read/write below in sync — do NOT hardcode column numbers.
// User columns (★) are A-C and always preserved; crawler manages D onward.
const COLUMNS = [
  "★ Mark", // A
  "★ Rating", // B
  "★ Remarks", // C
  "Property ID", // D
  "Title", // E
  "Price", // F
  "前次價格", // G - previous price, written only when price changes
  "價格異動時間", // H - when the price change was observed (UTC+8)
  "Property Type", // I
  "Size (坪)", // J
  "Floor", // K
  "Location", // L
  "Metro Distance", // M
  "Tags", // N
  "Agent Type", // O
  "Agent Name", // P
  "發佈時間", // Q - absolute publish time (UTC+8), from detail page
  "更新時間", // R - absolute update time (UTC+8), derived from refresh string
  "Views", // S
  "Source URL", // T
  "First Seen", // U
  "Last Updated", // V
  "Status", // W
] as const;

const COL: Record<string, number> = Object.fromEntries(
  COLUMNS.map((header, index) => [header, index])
);
const COL_COUNT = COLUMNS.length;
const FIRST_CRAWLER_COL = COL["Title"]; // E — first column the crawler overwrites

function ts() {
  return new Date().toISOString().slice(11, 19) + "Z";
}

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
    // No userAgent override: a headful Chromium self-reports a UA that is
    // internally consistent with its Sec-CH-UA client hints and platform.
    // Pinning a Mac UA while running headless Linux made the three layers
    // disagree — a stronger bot signal than a consistent real identity.
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
  updateInfo: string; // raw 591 relative refresh string ("2天前更新")
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
  發佈時間: string; // absolute publish time (UTC+8)
  更新時間: string; // absolute update time (UTC+8)
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
      headerValues: [...COLUMNS],
    });
  }

  return sheet;
}

/**
 * Migrate an existing Data sheet to the current column layout.
 *
 * State-based and idempotent (no version flag): each step checks for its own
 * marker column and no-ops when already present. insertDimension shifts all
 * existing cell data right automatically, so user columns and prior data stay
 * aligned. Steps run in historical order so a sheet several versions behind
 * catches up in one pass.
 */
async function migrateDataSheetSchema(sheet: any): Promise<void> {
  await withRetry(() => sheet.loadHeaderRow(), "loadHeaderRow (migrate)").catch(
    () => {}
  );

  // Step 1: "Update Info" → 發佈時間 + 更新時間
  let headers: string[] = sheet.headerValues || [];
  if (!headers.includes("發佈時間")) {
    const updateInfoIdx = headers.indexOf("Update Info");
    if (updateInfoIdx === -1) {
      console.log("  ⚠️ Unexpected Data sheet layout, skipping schema migration");
      return;
    }

    console.log("  🔧 Migrating Data sheet: adding 發佈時間 / 更新時間 columns...");

    // Insert a blank column at the 發佈時間 position (before Update Info).
    await withRetry(
      () =>
        sheet.insertDimension(
          "COLUMNS",
          { startIndex: updateInfoIdx, endIndex: updateInfoIdx + 1 },
          false
        ),
      "insertDimension (migrate)",
      { maxRetries: 1 }
    );

    // Write the new header cell and rename the shifted "Update Info" header.
    await withRetry(
      () =>
        sheet.loadCells({
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: updateInfoIdx,
          endColumnIndex: updateInfoIdx + 2,
        }),
      "loadCells (migrate header)"
    );
    sheet.getCell(0, updateInfoIdx).value = "發佈時間";
    sheet.getCell(0, updateInfoIdx + 1).value = "更新時間";
    await withRetry(() => sheet.saveUpdatedCells(), "saveUpdatedCells (migrate)");

    await withRetry(() => sheet.loadHeaderRow(), "loadHeaderRow (post-migrate)");
    console.log("  ✅ Schema migration complete (發佈時間/更新時間)");
  }

  // Step 2: 前次價格 + 價格異動時間 (after Price)
  headers = sheet.headerValues || [];
  if (!headers.includes("前次價格")) {
    const priceIdx = headers.indexOf("Price");
    if (priceIdx === -1) {
      console.log("  ⚠️ Price column not found, skipping price-history migration");
      return;
    }

    console.log(
      "  🔧 Migrating Data sheet: adding 前次價格 / 價格異動時間 columns..."
    );

    // Insert two blank columns right after Price.
    await withRetry(
      () =>
        sheet.insertDimension(
          "COLUMNS",
          { startIndex: priceIdx + 1, endIndex: priceIdx + 3 },
          false
        ),
      "insertDimension (migrate price)",
      { maxRetries: 1 }
    );

    await withRetry(
      () =>
        sheet.loadCells({
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: priceIdx + 1,
          endColumnIndex: priceIdx + 3,
        }),
      "loadCells (migrate price header)"
    );
    sheet.getCell(0, priceIdx + 1).value = "前次價格";
    sheet.getCell(0, priceIdx + 2).value = "價格異動時間";
    await withRetry(
      () => sheet.saveUpdatedCells(),
      "saveUpdatedCells (migrate price)"
    );

    await withRetry(
      () => sheet.loadHeaderRow(),
      "loadHeaderRow (post-migrate price)"
    );
    console.log("  ✅ Schema migration complete (前次價格/價格異動時間)");
  }
}

async function formatConfigSheet(sheet: any) {
  // Load cells for columns A-F (data columns + helper columns).
  // Rows 0-4: header + Example block. Tips + status (rows 5+) are written
  // separately by writeConfigStatusBlock() every run.
  await withRetry(
    () =>
      sheet.loadCells({
        startRowIndex: 0,
        endRowIndex: 5,
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

    // Tips + status block (rows 5+) are written every run by
    // writeConfigStatusBlock() so existing sheets stay current.
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

/**
 * Write the Tips + status block into the Config sheet's helper area (columns
 * E-F; D is the spacer). Owned here — not in formatConfigSheet() — and rewritten
 * every crawl so existing sheets always reflect the current layout and data.
 * Layout (0-indexed rows, after the Example block ends at row 4):
 *   row 5  💡 Tips:
 *   row 6  • Set Status ...        (one bullet per row, E only)
 *   row 7  • Get URLs ...
 *   row 8  • Sort by '最新' ...
 *   row 10 ⏰ 更新頻率： <schedule>  (static promise — the cron)
 *   row 11 🕐 最後更新： <timestamp> (dynamic fact — when this run happened)
 */
async function writeConfigStatusBlock(sheet: any): Promise<void> {
  const gray = { red: 0.95, green: 0.95, blue: 0.95 };
  // { row, col, value, bold }. Empty-string F cells clear the old two-column
  // tip layout (second bullet used to sit in column F) on existing sheets.
  const cells = [
    { row: 5, col: 4, value: "💡 Tips:", bold: true },
    { row: 6, col: 4, value: "• Set Status to 'Inactive' to skip a URL", bold: false },
    { row: 6, col: 5, value: "", bold: false },
    { row: 7, col: 4, value: "• Get URLs from 591.com.tw search page", bold: false },
    { row: 7, col: 5, value: "", bold: false },
    { row: 8, col: 4, value: "• Sort by '最新' (sort=posttime_desc) to catch new listings sooner", bold: false },
    { row: 8, col: 5, value: "", bold: false },
    { row: 10, col: 4, value: "⏰ 更新頻率：", bold: true },
    { row: 10, col: 5, value: CONFIG.CRAWL_SCHEDULE_NOTE, bold: false },
    { row: 11, col: 4, value: "🕐 最後更新：", bold: true },
    { row: 11, col: 5, value: `${formatTaipei(Date.now())}（台灣時間）`, bold: false },
  ];

  await withRetry(() => sheet.loadCells("E6:F12"), "loadCells (statusBlock)");
  for (const { row, col, value, bold } of cells) {
    const cell = sheet.getCell(row, col);
    cell.value = value;
    cell.backgroundColor = gray;
    if (bold) cell.textFormat = { bold: true };
  }
  await withRetry(
    () => sheet.saveUpdatedCells(),
    "saveUpdatedCells (statusBlock)"
  );
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

  // Refresh the user-facing Tips + status block every run (idempotent).
  await writeConfigStatusBlock(sheet);

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
): Promise<{
  added: number;
  updated: number;
  unchanged: number;
  inactive: number;
  priceChanges: number;
}> {
  // Crawl instant: `crawlDate` anchors relative→absolute conversion; `now` is the
  // human-readable stamp used for First Seen / Last Updated (kept as-is, UTC).
  const crawlDate = new Date();
  const now = crawlDate
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
  const threshold = CONFIG.REFRESH_UPDATE_THRESHOLD_MS;
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let inactive = 0;
  let priceChanges = 0;
  const seenIds = new Set<string>();
  const newRows: any[][] = []; // Collect new rows to insert at top

  // Collect updates for batch operation (columns E onward).
  // priceDirection marks a real price change for cell coloring (down = green).
  const rowsToUpdate: {
    rowIndex: number;
    data: any[];
    priceDirection: "up" | "down" | null;
  }[] = [];
  // Collect rows to mark as inactive
  const rowsToInactivate: number[] = [];

  for (const listing of listings) {
    seenIds.add(listing.id);
    const existing = existingProperties.get(listing.id);

    // Create hyperlink formula: =HYPERLINK("url", "title")
    const titleWithLink = `=HYPERLINK("${
      listing.url
    }", "${listing.title.replace(/"/g, '""')}")`;
    const tagsStr = listing.tags.join(", ");
    // Absolute update time derived from the relative refresh string ("" if unparseable)
    const candidateUpdate = refreshToAbsolute(listing.updateInfo, crawlDate);

    if (existing) {
      const { row: existingRow, rowIndex } = existing;

      // 更新時間: only rewrite when the new value reflects a *real* refresh
      // (jumped ahead past the drift threshold), otherwise preserve (null).
      const storedUpdate = existingRow.get("更新時間") || "";
      const refreshAdvanced = candidateUpdate
        ? shouldUpdateRefresh(storedUpdate, candidateUpdate, threshold)
        : false;
      const updateCell = refreshAdvanced ? candidateUpdate : null;

      // Price change: only counts as one when BOTH sides are valid positive
      // numbers (a blank/garbled stored price still triggers a rewrite via
      // priceDiffers, but records no 前次價格 — there is no trustworthy baseline;
      // a 0/NaN crawled price means extraction failed, not a real change).
      const storedPrice = Number(existingRow.get("Price"));
      const priceDiffers = storedPrice !== listing.priceNumber;
      const realPriceChange =
        priceDiffers &&
        Number.isFinite(storedPrice) &&
        storedPrice > 0 &&
        Number.isFinite(listing.priceNumber) &&
        listing.priceNumber > 0;
      const priceDirection: "up" | "down" | null = realPriceChange
        ? listing.priceNumber < storedPrice
          ? "down"
          : "up"
        : null;

      // Note: Title comparison uses raw title text (not HYPERLINK formula)
      // because sheet returns displayed value, not formula string.
      // Update/publish times are handled separately above (not here).
      const otherChanged =
        existingRow.get("Title") !== listing.title ||
        priceDiffers ||
        existingRow.get("Property Type") !== listing.propertyType ||
        existingRow.get("Size (坪)") !== listing.size ||
        existingRow.get("Floor") !== listing.floor ||
        existingRow.get("Location") !== listing.location ||
        existingRow.get("Metro Distance") !== listing.metroDistance ||
        existingRow.get("Tags") !== tagsStr ||
        existingRow.get("Agent Type") !== listing.agentType ||
        existingRow.get("Agent Name") !== listing.agentName ||
        existingRow.get("Status") !== "Active";
      // Note: Views excluded from change detection (changes too frequently)

      const hasChanges = otherChanged || refreshAdvanced;

      if (hasChanges) {
        // Collect update data for batch operation (columns E-W)
        rowsToUpdate.push({
          rowIndex,
          priceDirection,
          data: [
            titleWithLink, // E: Title
            listing.priceNumber, // F: Price - numeric with format
            realPriceChange ? storedPrice : null, // G: 前次價格 (null = preserve)
            realPriceChange ? formatTaipei(crawlDate.getTime()) : null, // H: 價格異動時間 (null = preserve)
            listing.propertyType, // I: Property Type
            listing.size, // J: Size
            listing.floor, // K: Floor
            listing.location, // L: Location
            listing.metroDistance, // M: Metro Distance
            tagsStr, // N: Tags
            listing.agentType, // O: Agent Type
            listing.agentName, // P: Agent Name
            null, // Q: 發佈時間 — detail-page crawl removed; preserve existing
            updateCell, // R: 更新時間 (null = preserve)
            listing.views, // S: Views
            listing.sourceUrl, // T: Source URL
            null, // U: First Seen - preserve
            now, // V: Last Updated
            "Active", // W: Status
          ],
        });
        updated++;
        if (realPriceChange) priceChanges++;
      } else {
        unchanged++;
      }
    } else {
      // Collect new rows to insert at top later
      newRows.push([
        "", // A: ★ Mark
        "", // B: ★ Rating
        "", // C: ★ Remarks
        listing.id, // D: Property ID
        titleWithLink, // E: Title
        listing.priceNumber, // F: Price - numeric with format
        "", // G: 前次價格 — no price history yet for a new listing
        "", // H: 價格異動時間
        listing.propertyType, // I: Property Type
        listing.size, // J: Size
        listing.floor, // K: Floor
        listing.location, // L: Location
        listing.metroDistance, // M: Metro Distance
        tagsStr, // N: Tags
        listing.agentType, // O: Agent Type
        listing.agentName, // P: Agent Name
        "", // Q: 發佈時間 — left blank (detail-page crawl removed)
        candidateUpdate || "", // R: 更新時間
        listing.views, // S: Views
        listing.sourceUrl, // T: Source URL
        now, // U: First Seen
        now, // V: Last Updated
        "Active", // W: Status
      ]);
      added++;
    }
  }

  // Collect rows to mark as inactive — only when we have crawl results.
  // If seenIds is empty (crawl failed/timed out), skip to avoid falsely marking
  // all existing listings as inactive.
  if (seenIds.size > 0) {
    for (const [id, { row, rowIndex }] of existingProperties) {
      if (!seenIds.has(id) && row.get("Status") === "Active") {
        rowsToInactivate.push(rowIndex);
        inactive++;
      }
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
      // Load cells and set values (all columns A..last)
      await withRetry(
        () =>
          sheet.loadCells({
            startRowIndex: 1,
            endRowIndex: 1 + newRows.length,
            startColumnIndex: 0,
            endColumnIndex: COL_COUNT,
          }),
        "loadCells (newRows)"
      );
      for (let i = 0; i < newRows.length; i++) {
        const rowData = newRows[i];
        for (let j = 0; j < rowData.length; j++) {
          const cell = sheet.getCell(1 + i, j);
          cell.value = rowData[j];
          // Apply number format to Price column
          if (j === COL["Price"] && rowData[j] !== null && rowData[j] !== "") {
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

      // Load all cells that need updating (columns E..last)
      // Skip A-C (user columns) and D (Property ID - never changes)
      await withRetry(
        () =>
          sheet.loadCells({
            startRowIndex: minRow,
            endRowIndex: maxRow + 1,
            startColumnIndex: FIRST_CRAWLER_COL, // Column E: Title (skip A-D)
            endColumnIndex: COL_COUNT,
          }),
        "loadCells (batchUpdate)"
      );

      // Apply updates (data array maps to columns E..last)
      const priceDataIdx = COL["Price"] - FIRST_CRAWLER_COL;
      const prevPriceDataIdx = COL["前次價格"] - FIRST_CRAWLER_COL;
      // Price-change highlight: 降價 = light green, 漲價 = light red. The color
      // persists until the next price change recolors it, so a glance at the
      // sheet shows which listings have ever moved and in which direction.
      const PRICE_DOWN_BG = { red: 0.851, green: 0.918, blue: 0.827 }; // #D9EAD3
      const PRICE_UP_BG = { red: 0.957, green: 0.8, blue: 0.8 }; // #F4CCCC
      for (const { rowIndex, data, priceDirection } of rowsToUpdate) {
        for (let col = 0; col < data.length; col++) {
          // Skip null values (preserve existing, e.g., First Seen)
          if (data[col] !== null) {
            const cell = sheet.getCell(rowIndex, col + FIRST_CRAWLER_COL);
            cell.value = data[col];
            // Apply number format to Price / 前次價格 columns
            if (col === priceDataIdx || col === prevPriceDataIdx) {
              cell.numberFormat = { type: "NUMBER", pattern: '#,##0"元/月"' };
            }
            if (col === priceDataIdx && priceDirection) {
              cell.backgroundColor =
                priceDirection === "down" ? PRICE_DOWN_BG : PRICE_UP_BG;
            }
          }
        }
      }

      // Apply inactive status (only Last Updated and Status columns)
      for (const rowIndex of rowsToInactivate) {
        sheet.getCell(rowIndex, COL["Last Updated"]).value = now;
        sheet.getCell(rowIndex, COL["Status"]).value = "Inactive";
      }

      // Single batch save for all updates
      await withRetry(() => sheet.saveUpdatedCells(), "saveUpdatedCells (batchUpdate)");
    } catch (error) {
      console.error(`  ❌ Error in batch update:`, error);
      throw error;
    }
  }

  return { added, updated, unchanged, inactive, priceChanges };
}

// ============================================================
// CRAWLER FUNCTIONS
// ============================================================
async function extractListingsFromPage(
  page: Page,
  sourceUrl: string
): Promise<ListingItem[]> {
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
          };
        }
      }
      return null;
    });

  let nuxtData = await extractNuxt();

  if (!nuxtData || !nuxtData.items) {
    // Data not in initial HTML — wait for client-side hydration
    await page
      .waitForLoadState("networkidle", { timeout: CONFIG.NETWORK_IDLE_TIMEOUT_MS })
      .catch(() => {
        console.log(`    [${ts()}] networkidle timeout, proceeding with available data...`);
      });
    nuxtData = await extractNuxt();
  }

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

      let page: Page | null = null;
      try {
        const newPageStart = Date.now();
        let newPageTimerId: ReturnType<typeof setTimeout> | undefined;
        page = await Promise.race([
          context.newPage(),
          new Promise<never>((_, reject) => {
            newPageTimerId = setTimeout(
              () => reject(new Error("newPage() timed out after 30s")),
              30_000
            );
          }),
        ]).finally(() => clearTimeout(newPageTimerId));
        console.log(`    [${ts()}] newPage() done (${Date.now() - newPageStart}ms)`);

        let crawlTimerId: ReturnType<typeof setTimeout> | undefined;
        const listings = await Promise.race([
          (async () => {
            const gotoStart = Date.now();
            const response = await page!.goto(url, {
              waitUntil: "domcontentloaded",
              timeout: CONFIG.PAGE_GOTO_TIMEOUT_MS,
            });
            console.log(
              `    [${ts()}] goto done in ${Date.now() - gotoStart}ms, status: ${response?.status() ?? "null"}`
            );

            const challenge = await detectChallengePage(response, page!, url);
            if (challenge.blocked) {
              console.log(`  ⚠️ Blocked: ${challenge.reason}`);
              return [] as ListingItem[];
            }

            await page!
              .waitForSelector(".item-info-title, .item-title", {
                timeout: CONFIG.PAGE_SELECTOR_TIMEOUT_MS,
              })
              .catch(() => {
                console.log(`    [${ts()}] selector timeout, proceeding...`);
              });

            return await extractListingsFromPage(page!, baseUrl);
          })(),
          new Promise<ListingItem[]>((_, reject) => {
            crawlTimerId = setTimeout(() => {
              console.log(
                `    [${ts()}] ⏱️ per-page timeout (${CONFIG.PAGE_CRAWL_TIMEOUT_MS}ms) triggered`
              );
              reject(
                new Error(
                  `Page ${pageNum} timed out after ${CONFIG.PAGE_CRAWL_TIMEOUT_MS}ms`
                )
              );
            }, CONFIG.PAGE_CRAWL_TIMEOUT_MS);
          }),
        ]).finally(() => clearTimeout(crawlTimerId));

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
        console.log(`  [${ts()}] ⚠️ Error: ${message}`);
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
        if (page) {
          const closeStart = Date.now();
          await Promise.race([
            page.close(),
            new Promise<void>((r) => setTimeout(r, 5000)),
          ]).catch(() => {});
          const closeMs = Date.now() - closeStart;
          if (closeMs > 1000) {
            console.log(`    [${ts()}] ⚠️ page.close() took ${closeMs}ms`);
          }
        }
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
  await migrateDataSheetSchema(sheet);
  const existingProperties = await getExistingProperties(sheet);
  console.log(`Found ${existingProperties.size} existing properties in sheet`);

  // Launch browser with stealth
  console.log(`\n🌐 [${ts()}] Launching browser...`);
  const launchStart = Date.now();
  const browser = await chromium.launch({
    // Headful by default to drop the headless bot signal. On the self-hosted
    // runner this runs under xvfb (virtual display). Set HEADLESS=true to
    // force headless (e.g. an environment without any display).
    headless: process.env.HEADLESS === "true",
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await createStealthContext(browser);
  console.log(`  Browser ready in ${Date.now() - launchStart}ms`);

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

      let listings: ListingItem[] = [];
      for (let attempt = 1; attempt <= CONFIG.URL_RETRY_COUNT; attempt++) {
        if (attempt > 1) {
          console.log(
            `  🔄 URL retry ${attempt}/${CONFIG.URL_RETRY_COUNT}, waiting ${CONFIG.URL_RETRY_DELAY_MS / 1000}s...`
          );
          await new Promise((r) => setTimeout(r, CONFIG.URL_RETRY_DELAY_MS));
        }
        listings = await crawlUrl(context, urls[i]);
        if (listings.length > 0) break;
        if (attempt < CONFIG.URL_RETRY_COUNT) {
          console.log(`  ⚠️ No listings returned, will retry...`);
        }
      }
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
    const { added, updated, unchanged, inactive, priceChanges } =
      await writeListingsToSheet(sheet, uniqueListings, existingProperties);
    console.log(
      `✅ Added: ${added}, Updated: ${updated}, Unchanged: ${unchanged}, Inactive: ${inactive}, Price changes: ${priceChanges}`
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
