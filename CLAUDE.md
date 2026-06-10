# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

591 Rental Housing Crawler - A Playwright-based web scraper for Taiwan's largest rental platform (rent.591.com.tw) that syncs listings to Google Sheets via GitHub Actions.

## Commands

```bash
# Install dependencies (uses Bun for speed)
bun install
bunx playwright install chromium

# Run crawler (requires env vars)
bun run crawl

# Local test (outputs JSON/CSV, no Google Sheets)
bun run test
```

**Environment Variables** (set in `.env` or export):
- `GOOGLE_SHEETS_ID` - Sheet ID from URL (or use `GOOGLE_SHEETS_ID_<name>` for multiple sheets)
- `GOOGLE_SERVICE_ACCOUNT_EMAIL` - Service account email
- `GOOGLE_PRIVATE_KEY` - Private key with `\n` for newlines

## Architecture

```
Config Sheet (URLs) → Playwright Crawl → Extract __NUXT__ data →
Parse Listings → Deduplicate by Property ID → Write to Data Sheet
```

### Core Flow (crawler.ts)

1. `getSheetConfigs()` - Discovers sheets from `GOOGLE_SHEETS_ID*` env vars
2. `processSheet()` - Orchestrates crawl for a single sheet (loop for multiple)
3. `connectToGoogleSheets(sheetId)` - Authenticates via Service Account JWT
4. `ensureConfigSheet()` - Reads active URLs from Config sheet
5. `crawlUrl()` - Navigates pages with Playwright, handles pagination
6. `extractListingsFromPage()` - Parses `window.__NUXT__` for listing data (591 uses Nuxt.js SSR)
7. `migrateDataSheetSchema()` - Idempotently adds new columns to existing sheets (發佈時間/更新時間, then 前次價格/價格異動時間)
8. `writeListingsToSheet()` - Batch writes with deduplication, marks removed listings as "Inactive"

### Data Extraction

591.com.tw embeds listing data in `window.__NUXT__.data[key].data.items`. The crawler evaluates this in browser context after waiting for `networkidle` state.

**Time fields** (see `time-utils.ts`): 591 list pages expose no absolute timestamps — only relative strings (`refresh_time`, e.g. "2天前更新"). The crawler:
- **發佈時間 (publish)**: absolute publish time lives only on the *detail page* (`favData.posttime`). Fetching it required visiting every listing's detail page — slow (~4s anti-bot delay each) and bot-risky — so detail-page crawling was **removed**. The column is kept and existing values are preserved, but new rows are left blank.
- **更新時間 (update)**: derived from the relative `refresh_time` anchored to crawl time → UTC+8. Recomputed each run but only rewritten when it jumps past `REFRESH_UPDATE_THRESHOLD_MS` (a real refresh vs. bucket drift).

**Price-change tracking**: when an existing listing's Price differs from the stored value (and the stored value is a valid number), the crawler writes the old price to 前次價格, stamps 價格異動時間 (UTC+8), and colors the Price cell (降價 = light green #D9EAD3, 漲價 = light red #F4CCCC). The color persists until the next price change recolors it. Only the latest change is kept (no full history). Sorting/filtering by 價格異動時間 in Sheets surfaces recent price moves without reordering rows.

### Google Sheets Structure

**Config Sheet**: URL | Description | Status (Active/Inactive)

**Data Sheet** (column order is the single source of truth in `crawler.ts` `COLUMNS`):
- Columns A-C: User columns (★ Mark, ★ Rating, ★ Remarks) - **always preserved**
- Column D: Property ID (unique key)
- Columns E-W: Crawler-managed data (Title, Price, 前次價格, 價格異動時間, …, 發佈時間, 更新時間, …, Status)
- Schema migration is automatic & idempotent (each step detects its own marker column — 發佈時間, then 前次價格; no version flag)

### Deduplication Logic

- New listings: Insert at row 2 (after header)
- Existing listings: Update only if data changed (preserve user columns A-C)
- Missing listings: Mark as "Inactive" (data preserved for reference)

## Configuration

```typescript
const CONFIG = {
  MAX_PAGES_PER_URL: 10,         // Max pages per URL (30 items/page)
  MAX_ITEMS_PER_URL: 30,         // Max items to fetch
  REQUEST_DELAY_MS: 2000,        // Base delay + 0-4000ms random
  PAGE_GOTO_TIMEOUT_MS: 30_000,  // page.goto timeout
  PAGE_SELECTOR_TIMEOUT_MS: 10_000, // waitForSelector timeout
  NETWORK_IDLE_TIMEOUT_MS: 15_000,  // networkidle graceful timeout
  PAGE_CRAWL_TIMEOUT_MS: 60_000,    // per-page overall safety net
  PAGE_RETRY_COUNT: 3,             // max retries for non-timeout page errors
  URL_RETRY_COUNT: 3,              // max attempts per URL when 0 listings returned
  URL_RETRY_DELAY_MS: 45_000,      // delay between URL-level retries (45s)
  SHEET_OPERATION_TIMEOUT_MS: 30_000, // per Sheets API call timeout
  SHEET_RETRY_COUNT: 3,          // max retries for Sheets operations
  SHEET_RETRY_DELAY_MS: 2_000,   // base delay between retries
  SHEET_DATA: "Data",
  SHEET_CONFIG: "Config",
};
```

### Timeout Layering (defense in depth)

```
Layer 1: networkidle wait       15s  (graceful degradation — proceeds on timeout)
Layer 2: page.goto              30s  (Playwright navigation timeout)
Layer 3: per-page crawl         60s  (safety net — skips page on timeout)
Layer 3.5: URL-level retry      3x with 45s delay (when URL returns 0 listings)
Layer 4: Sheets API per-call    30s  (with 3x retry + linear backoff)
Layer 5: GitHub Actions job     15m  (outermost safety net)
```

## GitHub Actions

Workflow: `.github/workflows/crawl.yml`
- Schedule: 9x daily (05:00, 07:00, 10:00, 12:00, 14:00, 17:00, 19:00, 21:00, 24:00 UTC+8) — via homelab cron in CT 130 (root crontab), not GitHub's scheduler
- Manual trigger via workflow_dispatch
- Requires 3 secrets: `GOOGLE_SHEETS_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`
- Multiple sheets: Add `GOOGLE_SHEETS_ID_<NAME>` secrets (auto-discovered, no workflow changes needed)
