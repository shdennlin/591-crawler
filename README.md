# 591 Rental Housing Crawler

A Playwright-based crawler for rent.591.com.tw that collects rental property listings and syncs them to Google Sheets via GitHub Actions.

## Features

- Crawls multiple 591 search URLs using headless Chromium
- Extracts detailed property information from `__NUXT__` data
- Automatic sync to Google Sheets via API
- Scheduled execution via GitHub Actions (every 6 hours)
- Automatic deduplication based on Property ID
- Tracks property status (Active/Inactive)
- Preserves user columns (Mark, Rating, Remarks)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  GitHub Actions (scheduled every 6 hours)                   │
│       │                                                     │
│       ▼                                                     │
│  ┌──────────────┐    Google Sheets API    ┌──────────────┐ │
│  │  Playwright  │ ───────────────────────►│ Google Sheet │ │
│  │  Crawler     │    (Service Account)    │   (Data)     │ │
│  └──────────────┘                         └──────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Create Google Cloud Service Account

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select existing)
3. Enable **Google Sheets API**:
   - **APIs & Services** → **Library** → Search "Google Sheets API" → **Enable**
4. Create Service Account:
   - **APIs & Services** → **Credentials** → **Create Credentials** → **Service Account**
   - Name: `591-crawler`
   - **Skip** the "Grant this service account access" step (no roles needed)
   - **Skip** the "Grant users access" step
   - Click **Done**
5. Create Key:
   - Click on your new service account → **Keys** tab → **Add Key** → **Create new key** → **JSON**
   - Save the downloaded JSON file

> **Note**: No IAM roles are needed because we grant access by sharing the Google Sheet directly with the service account email (Step 2).

### 2. Share Google Sheet with Service Account

1. Open your Google Sheet (or create a new one)
2. Copy the **Sheet ID** from URL:
   ```
   https://docs.google.com/spreadsheets/d/[SHEET_ID]/edit
   ```
3. Click **Share** → Add the service account email (from JSON: `client_email`)
4. Give it **Editor** access

### 3. Add GitHub Secrets

Go to your GitHub repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

| Secret Name | Value |
|-------------|-------|
| `GOOGLE_SHEETS_ID` | Sheet ID from URL |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `client_email` from JSON |
| `GOOGLE_PRIVATE_KEY` | `private_key` from JSON (include BEGIN/END lines) |

### 4. Configure Search URLs

Edit `crawler.ts` and modify the `URLS` array:

```typescript
const CONFIG = {
  URLS: [
    'https://rent.591.com.tw/list?region=3&kind=3&other=near_subway,rental-subsidy',
    'https://rent.591.com.tw/list?region=1&kind=1&section=8,9&price=10000$_30000$',
    // Add more URLs...
  ],
  MAX_PAGES_PER_URL: 10,
  REQUEST_DELAY_MS: 2000,
};
```

### 5. Deploy

```bash
git add .
git commit -m "Configure crawler"
git push
```

Then go to **Actions** → **Run workflow** to test!

## Local Development

### Prerequisites

```bash
npm install
npx playwright install chromium
```

### Test without Google Sheets

```bash
npm test
# Outputs: test-output.json, test-output.csv
```

### Test with Google Sheets

```bash
export GOOGLE_SHEETS_ID="your-sheet-id"
export GOOGLE_SERVICE_ACCOUNT_EMAIL="service-account@project.iam.gserviceaccount.com"
export GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"

npm run crawl
```

## URL Parameters Reference

### How to Build Your Search URL

1. Go to [rent.591.com.tw](https://rent.591.com.tw)
2. Set your search filters (region, price, type, etc.)
3. Copy the URL from your browser

### Common Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| `region` | City/County code | `region=1` (台北市) |
| `kind` | Property type | `kind=3` (分租套房) |
| `section` | District codes | `section=1,5,10` |
| `price` | Price range | `price=10000$_30000$` |
| `layout` | Room count | `layout=2,3` |
| `other` | Special filters | `other=near_subway,pet` |
| `area` | Size range (坪) | `area=10$_20$` |

### Region Codes

| Code | City | Code | City |
|------|------|------|------|
| 1 | 台北市 | 3 | 新北市 |
| 6 | 桃園市 | 8 | 台中市 |
| 15 | 台南市 | 17 | 高雄市 |

### Property Types (kind)

| Code | Type |
|------|------|
| 1 | 整層住家 |
| 2 | 獨立套房 |
| 3 | 分租套房 |
| 4 | 雅房 |

### Special Filters (other)

| Value | Description |
|-------|-------------|
| `near_subway` | 近捷運 |
| `rental-subsidy` | 租金補貼 |
| `pet` | 可養寵物 |
| `cook` | 可開伙 |
| `balcony` | 有陽台 |
| `lift` | 有電梯 |

### Example URLs

```bash
# 新北市分租套房，近捷運，租金補貼
https://rent.591.com.tw/list?region=3&kind=3&other=near_subway,rental-subsidy

# 台北市大安區/信義區，整層住家，1-3萬
https://rent.591.com.tw/list?region=1&kind=1&section=8,9&price=10000$_30000$

# 高雄市獨立套房，可養寵物
https://rent.591.com.tw/list?region=17&kind=2&other=pet
```

## Google Sheet Structure

The first 3 columns are **user columns** (preserved during updates):

| Column | Field | Description |
|--------|-------|-------------|
| A | ★ Mark | Your flags (✓, ✗, ⭐) |
| B | ★ Rating | Your ratings |
| C | ★ Remarks | Your notes |
| D | Property ID | Unique ID from 591 |
| E | Title | Listing title |
| F | Price | Monthly rent |
| G | Price (Number) | Numeric price |
| H | Property Type | 整層/套房/雅房 |
| I | Size (坪) | Size in 坪 |
| J | Floor | Floor info |
| K | Location | District & street |
| L | Metro Distance | Distance to metro |
| M | Tags | Features |
| N | Agent Type | 仲介/屋主 |
| O | Agent Name | Contact name |
| P | Update Info | Last update from 591 |
| Q | Views | View count |
| R | URL | Property URL |
| S | Source URL | Search URL |
| T | First Seen | Date first crawled |
| U | Last Updated | Date last updated |
| V | Status | Active/Inactive |

## Files

```
591_crawler/
├── crawler.ts           # Main crawler with Google Sheets sync
├── test-crawler.ts      # Local test (outputs to files)
├── package.json         # Dependencies
├── .github/
│   └── workflows/
│       └── crawl.yml    # GitHub Actions workflow
├── Code.gs              # (Deprecated) Google Apps Script version
└── README.md
```

## Troubleshooting

### "Missing environment variables"
- Ensure all 3 GitHub secrets are set correctly
- Check that `GOOGLE_PRIVATE_KEY` includes the full key with newlines

### "Could not extract __NUXT__ data"
- The page structure may have changed
- Try running locally to debug: `npm test`

### GitHub Actions not running
- Check **Actions** tab for errors
- Verify secrets are in **Settings** → **Secrets and variables** → **Actions**

## Notes

### Why Not Google Apps Script?

The original `Code.gs` used Google Apps Script with `UrlFetchApp`, but 591's CloudFront CDN blocks Google's server IPs. The Playwright approach works because:
1. GitHub Actions uses different IP ranges
2. Playwright executes JavaScript to decode the obfuscated `__NUXT__` data

### Rate Limiting

The crawler includes a 2-second delay between requests (`REQUEST_DELAY_MS`). Adjust if needed to avoid being blocked.

## License

For educational purposes only. Please respect 591's terms of service.
