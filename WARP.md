# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Commands

- Environment setup (no requirements.txt provided):

```bash path=null start=null
pip install beautifulsoup4 requests pymysql
```

- Run the CSV scraper (writes housing.csv):

```bash path=null start=null
python ScrapingToCsvFile.py
```

- Run the CSV scraper with Playwright (renders JS; outputs to data/housing.csv):

```bash path=null start=null
pip install playwright && python -m playwright install chromium
python ScrapingToCsvFile.py --engine browser --city Stockton_CA --output data/housing.csv --timeout 45
```

- Run the DB scraper (writes to MySQL and data.txt). Ensure Connexion.py matches your DB settings and the table exists (see Architecture):

```bash path=null start=null
python ScrapingToDB_TextFile.py
```

- Run tests (unittest; the test file has a space in its name, so use discover with an explicit pattern):

```bash path=null start=null
python -m unittest -v discover -s . -p "import unittest.py"
```

- Run a single test method (recommended: first rename the file to test_ScrapingToCsvFile.py):

```bash path=null start=null
python -m unittest -v test_ScrapingToCsvFile.TestScrapingToCsvFile.test_scraping_to_csv
```

Note: No build step or linter is configured in-repo.

## Architecture and data flow

- ScrapingToCsvFile.py
  - CLI: --city <City_State>, --output <path>, --timeout <seconds>, --engine [requests|browser], --headless [true|false].
  - Default requests engine fetches server HTML; browser engine uses Playwright Chromium to render and attempts multiple selectors, scroll, and JSON fallbacks.
  - Selectors target [data-testid] attributes with fallbacks to legacy classes.
  - Extracts fields: location, status, price, owner, bed, bath, sqft, lot; fills gaps with 'Not specified' or 'NoV'.
  - Writes CSV header and rows to the specified output path (directory auto-created).

- ScrapingToDB_TextFile.py
  - Performs the same scraping logic as above.
  - Persists each listing into MySQL via Connexion.Dbconnect with a raw INSERT INTO house(location,status,price,owner,bed,bath,sqft,sqft_lot) ... per row, committing each time.
  - Also writes a human-readable line per listing to data.txt.

- Connexion.py
  - Thin MySQL connector using PyMySQL with hardcoded settings: host=localhost, port=3308, user=root, db=realestate; exposes commit_db() and close_db().
  - Adjust these values to your environment before running the DB scraper.

- Tests
  - "import unittest.py" provides a minimal unittest that mocks HTTP and file I/O and asserts the CSV header for ScrapingToCsvFile.
  - Because of the filename, discovery requires the explicit pattern shown above; per-test invocation works best after renaming to a conventional module name.

## Operational notes

- The HTML selectors use obfuscated class names from the target site and may break if the markup changes.
- For DB usage, ensure a MySQL database realestate with a table house(location,status,price,owner,bed,bath,sqft,sqft_lot) exists and that Connexion.py credentials/port match your setup.
- Outputs are written to the repo root: housing.csv (CSV scraper) and data.txt (DB scraper).
