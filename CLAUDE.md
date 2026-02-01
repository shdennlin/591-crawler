# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

591 Rental Housing Crawler - A Playwright-based web scraper for Taiwan's largest rental platform (rent.591.com.tw) that syncs listings to Google Sheets via GitHub Actions.

## Commands

```bash
# Install dependencies
npm install
npx playwright install chromium

# Run crawler (requires env vars)
npm run crawl

# Local test (outputs JSON/CSV, no Google Sheets)
npm run test
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
7. `writeListingsToSheet()` - Batch writes with deduplication, marks removed listings as "Inactive"

### Data Extraction

591.com.tw embeds listing data in `window.__NUXT__.data[key].data.items`. The crawler evaluates this in browser context after waiting for `networkidle` state.

### Google Sheets Structure

**Config Sheet**: URL | Description | Status (Active/Inactive)

**Data Sheet**:
- Columns A-C: User columns (★ Mark, ★ Rating, ★ Remarks) - **always preserved**
- Column D: Property ID (unique key)
- Columns E-T: Crawler-managed data (Title, Price, Status, etc.)

### Deduplication Logic

- New listings: Insert at row 2 (after header)
- Existing listings: Update only if data changed (preserve user columns A-C)
- Missing listings: Mark as "Inactive" (data preserved for reference)

## Configuration

```typescript
const CONFIG = {
  MAX_PAGES_PER_URL: 10,    // Max pages per URL (30 items/page)
  MAX_ITEMS_PER_URL: 30,    // Max items to fetch
  REQUEST_DELAY_MS: 2000,   // Base delay + 0-4000ms random
  SHEET_DATA: "Data",
  SHEET_CONFIG: "Config",
};
```

## GitHub Actions

Workflow: `.github/workflows/crawl.yml`
- Schedule: 4x daily (06:00, 12:00, 16:00, 22:00 UTC+8)
- Manual trigger via workflow_dispatch
- Requires 3 secrets: `GOOGLE_SHEETS_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`
- Multiple sheets: Add `GOOGLE_SHEETS_ID_<NAME>` secrets (auto-discovered, no workflow changes needed)
