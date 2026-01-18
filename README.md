# 591 Rental Housing Crawler

Playwright-based crawler for rent.591.com.tw that syncs rental listings to Google Sheets via GitHub Actions.

## Features

- Crawls multiple 591 search URLs via headless Chromium
- **Configure URLs directly in Google Sheets** (no code editing needed)
- Automatic sync 4x daily (06:00, 12:00, 16:00, 22:00 UTC+8)
- Deduplication by Property ID, tracks Active/Inactive status
- Preserves user columns (Mark, Rating, Remarks)

## Quick Start

### 1. Google Cloud Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create project → Enable **Google Sheets API**
3. Create **Service Account** → Download JSON key

### 2. Share Google Sheet

1. Create/open a Google Sheet, copy the **Sheet ID** from URL:
   ```
   https://docs.google.com/spreadsheets/d/[SHEET_ID]/edit
   ```
2. **Share** with service account email (`client_email` from JSON) as **Editor**

### 3. GitHub Secrets

Add to repo **Settings** → **Secrets** → **Actions**:

| Secret | Value |
|--------|-------|
| `GOOGLE_SHEETS_ID` | Sheet ID from URL |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `client_email` from JSON |
| `GOOGLE_PRIVATE_KEY` | `private_key` from JSON |

### 4. First Run

```bash
git push  # or Actions → Run workflow
```

On first run, the crawler creates a **Config** sheet with instructions. Add your URLs there:

| URL | Description | Status |
|-----|-------------|--------|
| `https://rent.591.com.tw/list?region=1&...` | Taipei search | Active |

Set **Status** to `Active` to crawl, `Inactive` to skip.

## Local Development

```bash
npm install
npx playwright install chromium

# Set environment variables
export GOOGLE_SHEETS_ID="your-sheet-id"
export GOOGLE_SERVICE_ACCOUNT_EMAIL="...@...iam.gserviceaccount.com"
export GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"

npm run crawl
```

## URL Parameters

Build URLs at [rent.591.com.tw](https://rent.591.com.tw) using filters, then copy the URL.

| Parameter | Example | Description |
|-----------|---------|-------------|
| `region` | `1` | City (1=台北, 3=新北, 8=台中) |
| `kind` | `1` | Type (1=整層, 2=獨立套房, 3=分租套房) |
| `price` | `10000$_30000$` | Price range |
| `section` | `1,5,10` | District codes |
| `other` | `near_subway,pet` | Filters (近捷運, 可養寵物) |

**Example:**
```
https://rent.591.com.tw/list?region=1&kind=1&price=15000$_40000$&sort=posttime_desc
```

## Sheet Structure

### Config Sheet
| Column | Purpose |
|--------|---------|
| URL | 591 search URL |
| Description | Your label |
| Status | Active / Inactive |

### Data Sheet
| Columns A-C | User columns (preserved) |
|-------------|--------------------------|
| ★ Mark | Your flags |
| ★ Rating | Your ratings |
| ★ Remarks | Your notes |

Remaining columns: Property ID, Title, Price, Type, Size, Floor, Location, Metro, Tags, Agent, URL, Status, etc.

## Schedule

Default: **4 times daily** at 06:00, 12:00, 16:00, 22:00 (UTC+8 Taiwan time)

To change the schedule, edit `.github/workflows/crawl.yml`:
```yaml
# Local Time (UTC+8)  →  UTC Time  →  Cron
- cron: '0 22 * * *'   # 06:00 UTC+8 → 22:00 UTC
- cron: '0 4 * * *'    # 12:00 UTC+8 → 04:00 UTC
```

**Note:** GitHub Actions uses UTC. Subtract 8 hours from your desired UTC+8 time.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Missing environment variables" | Check all 3 GitHub secrets |
| "NO URLS CONFIGURED" | Add URLs to Config sheet with Status=Active |
| "Could not extract __NUXT__" | Page structure changed; run locally to debug |

## License

For educational purposes only. Respect 591's terms of service.
