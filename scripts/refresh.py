#!/usr/bin/env python3
"""
Weekly data refresh for the housing-market-dashboard GitHub Pages site.

Re-downloads every source and regenerates the 8 JSON files in data/:
  zips.json, metro.json, weekly.json, rates.json,
  national_sales.json, case_shiller.json, seasonality.json, meta.json

Design rules:
  * Idempotent: same inputs -> byte-identical outputs.
  * All-or-nothing: every source is fetched and processed in memory first;
    files are written only if ALL sources succeed. A failed download leaves
    data/ untouched and the script exits nonzero with a clear message.
  * Schemas match the existing files exactly (the dashboard JS depends on them).

Usage:
  python3 scripts/refresh.py                 # refresh data/ in place
  python3 scripts/refresh.py --check         # dry run: verify downloads parse, write nothing
  python3 scripts/refresh.py --local=DIR     # use cached CSVs from DIR (see LOCAL_NAMES)

Sources (all free, keyless):
  Zillow ZHVI by ZIP, Redfin market tracker (monthly + weekly, metro),
  Redfin property types, Redfin price drops (monthly + weekly),
  Redfin buyers/sellers balance, FRED MORTGAGE30US, FRED CSUSHPINSA.
"""

import calendar
import json
import statistics
import sys
import tempfile
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

try:
    import pandas as pd
except ImportError:
    print("ERROR: pandas is required (pip install pandas)", file=sys.stderr)
    sys.exit(2)

SITE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = SITE_DIR / "data"
# temp downloads go here (NOT /tmp: the CSVs total ~400MB, more than tmpfs)
TMP_DIR = SITE_DIR / ".refresh_tmp"
TMP_DIR.mkdir(exist_ok=True)

MARKET = "San Jose-Sunnyvale-Santa Clara, CA"
REGION = "San Jose, CA metro area"
BAY_COUNTIES = ["Santa Clara", "San Mateo", "Alameda", "Contra Costa",
                "San Francisco", "Marin", "Sonoma", "Napa", "Solano"]

URLS = {
    "zips": "https://files.zillowstatic.com/research/public_csvs/zhvi/Zip_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv",
    "metro": "https://redfin-public-data.s3.us-west-2.amazonaws.com/redfin_data_center/housing_market/monthly/all_metros.csv",
    "weekly": "https://redfin-public-data.s3.us-west-2.amazonaws.com/redfin_data_center/housing_market/weekly/all_metros.csv",
    "property_types": "https://redfin-public-data.s3.us-west-2.amazonaws.com/redfin_data_center/property_types/monthly/all_metros.csv",
    "price_drops_m": "https://redfin-public-data.s3.us-west-2.amazonaws.com/redfin_data_center/price_drops/monthly/top_50_metros.csv",
    "price_drops_w": "https://redfin-public-data.s3.us-west-2.amazonaws.com/redfin_data_center/price_drops/weekly/top_50_metros.csv",
    "balance": "https://redfin-public-data.s3.us-west-2.amazonaws.com/redfin_data_center/buyers_and_sellers/monthly/top_50_metros.csv",
    "rates": "https://fred.stlouisfed.org/graph/fredgraph.csv?id=MORTGAGE30US",
    "case_shiller": "https://fred.stlouisfed.org/graph/fredgraph.csv?id=CSUSHPINSA",
    "national": "https://redfin-public-data.s3.us-west-2.amazonaws.com/redfin_data_center/housing_market/monthly/country.csv",
}

UA = {"User-Agent": "housing-market-dashboard-refresh/1.0 (+https://github.com/AVKP49/housing-market-dashboard)"}


def download(name, url, retries=3):
    """Fetch a URL to a temp file (with resume on truncation); return its path."""
    last_err = None
    for attempt in range(1, retries + 1):
        tmp_path = None
        try:
            tmp = tempfile.NamedTemporaryFile(delete=False, dir=TMP_DIR,
                                              suffix=f"_{name}.csv")
            tmp_path = tmp.name
            got, expected = 0, None
            # resume loop: keep requesting Range bytes=got- until complete
            for _ in range(20):
                headers = dict(UA)
                if got:
                    headers["Range"] = f"bytes={got}-"
                req = urllib.request.Request(url, headers=headers)
                prev = got
                with urllib.request.urlopen(req, timeout=300) as resp:
                    if resp.status == 206:
                        pass  # resumed chunk
                    elif resp.status == 200 and got == 0:
                        pass  # fresh full download
                    elif resp.status == 200:
                        got = 0  # server ignored Range; restart
                        tmp.seek(0)
                        tmp.truncate()
                    else:
                        raise RuntimeError(f"HTTP {resp.status}")
                    if expected is None:
                        cr = resp.headers.get("Content-Range")
                        cl = resp.headers.get("Content-Length")
                        if cr and "/" in cr:
                            expected = int(cr.split("/")[-1])
                        elif cl and resp.status == 200:
                            expected = int(cl)
                    while True:
                        chunk = resp.read(1 << 20)
                        if not chunk:
                            break
                        tmp.write(chunk)
                        got += len(chunk)
                if expected and got >= expected:
                    break
                if got == prev:
                    break  # no progress (e.g. server sent everything already)
            tmp.close()
            if got < 100:
                raise RuntimeError("download suspiciously small")
            if expected and got < expected:
                raise RuntimeError(
                    f"truncated download ({got}/{expected} bytes)")
            return tmp_path
        except Exception as e:  # noqa: BLE001 - retry wrapper
            last_err = e
            if tmp_path:
                Path(tmp_path).unlink(missing_ok=True)
            print(f"  {name}: attempt {attempt} failed ({e}), retrying...",
                  flush=True)
            time.sleep(5 * attempt)
    raise RuntimeError(f"download failed for {name} ({url}): {last_err}")


def f2(x):
    v = pd.to_numeric(x, errors="coerce")
    return None if pd.isna(v) else round(float(v), 2)


def fi(x):
    v = pd.to_numeric(x, errors="coerce")
    return None if pd.isna(v) else int(round(float(v)))


# ---------------------------------------------------------------- zips.json
def build_zips(path):
    df = pd.read_csv(path, low_memory=False)
    date_cols = [c for c in df.columns if len(c) == 10 and c[4] == "-" and c[7] == "-"]
    date_cols.sort()
    keep = df[df["CountyName"].isin([c + " County" for c in BAY_COUNTIES])]
    out = {}
    for _, row in keep.iterrows():
        series = []
        for d in date_cols:
            v = row[d]
            if pd.isna(v):
                continue  # skip missing months (incl. NaN tails)
            series.append([d, int(round(float(v)))])
        if not series:
            continue
        z = str(row["RegionName"]).strip()
        out[z] = {
            "city": str(row["City"]).strip(),
            "county": str(row["CountyName"]).replace(" County", "").strip(),
            "series": series,
        }
    return out  # preserve source CSV order (matches existing file)


# ---------------------------------------------------------------- metro.json
METRO_ORDER = ["date", "homes_sold", "new_listings", "active_listings", "inventory",
               "pending_sales", "dom", "sale_to_list", "pct_above_list",
               "pct_off_market_2wk", "months_supply", "median_sale_price",
               "median_sale_price_psf", "median_new_list_price", "homes_sold_yoy",
               "median_sale_price_yoy", "dom_yoy", "price_drops_pct",
               "price_drop_avg_size", "buyers_index", "sellers_index",
               "buyer_seller_ratio", "seller_buyer_pct_diff",
               "homes_sold_sf", "median_sale_price_sf", "dom_sf", "sale_to_list_sf",
               "pct_above_list_sf", "new_listings_sf", "active_listings_sf",
               "months_supply_sf",
               "homes_sold_condo", "median_sale_price_condo", "dom_condo",
               "sale_to_list_condo", "pct_above_list_condo", "new_listings_condo",
               "active_listings_condo", "months_supply_condo",
               "homes_sold_th", "median_sale_price_th", "dom_th", "sale_to_list_th",
               "pct_above_list_th", "new_listings_th", "active_listings_th",
               "months_supply_th"]

PTYPES = {"sf": "Single Family Residential", "condo": "Condo/Co-op", "th": "Townhouse"}


def build_metro(m_path, pdm_path, bal_path, pt_path):
    m = pd.read_csv(m_path, low_memory=False)
    m = m[m["REGION NAME"] == REGION].sort_values("PERIOD END").reset_index(drop=True)

    pdm = pd.read_csv(pdm_path)
    pdm = pdm[pdm["REGION NAME"] == REGION].set_index("PERIOD END")

    bal = pd.read_csv(bal_path)
    bal = bal[(bal["REGION NAME"] == REGION) &
              (bal["PROPERTY TYPE"] == "All Residential")].set_index("PERIOD END")

    # property-type splits: prefer the seasonally-adjusted row per period/type
    pt_frames = []
    for ch in pd.read_csv(pt_path, chunksize=300000, low_memory=False):
        sub = ch[(ch["REGION NAME"] == REGION) &
                 (ch["PROPERTY TYPE"].isin(PTYPES.values()) &
                  (ch["PERIOD END"] >= m["PERIOD END"].min()))]
        if len(sub):
            pt_frames.append(sub)
    pt = pd.concat(pt_frames, ignore_index=True) if pt_frames else pd.DataFrame()
    if len(pt):
        def _sa(v):
            s = str(v).strip().lower()
            return 0 if s in ("true", "1", "t", "yes") else 1

        pt["sa_rank"] = pt["IS SEASONALLY ADJUSTED"].map(_sa)
        pt = pt.sort_values("sa_rank").drop_duplicates(["PERIOD END", "PROPERTY TYPE"])
        pt = pt.set_index(["PERIOD END", "PROPERTY TYPE"])

    series = []
    for _, r in m.iterrows():
        d = r["PERIOD END"]
        row = {
            "date": d,
            "homes_sold": fi(r["HOMES SOLD"]),
            "new_listings": fi(r["NEW LISTINGS"]),
            "active_listings": fi(r["ACTIVE LISTINGS"]),
            "inventory": fi(r["INVENTORY"]),
            "pending_sales": fi(r["PENDING SALES"]),
            "dom": f2(r["MEDIAN DAYS ON MARKET (DAYS)"]),
            "sale_to_list": f2(r["AVERAGE SALE TO LIST RATIO (%)"]),
            "pct_above_list": f2(r["SHARE SOLD ABOVE ORIGINAL LIST (%)"]),
            "pct_off_market_2wk": f2(r["PERCENT OFF MARKET IN TWO WEEKS (%)"]),
            "months_supply": f2(r["MONTHS OF SUPPLY"]),
            "median_sale_price": fi(r["MEDIAN SALE PRICE NSA ($)"]),
            "median_sale_price_psf": fi(r["MEDIAN SALE PRICE PER SQ.FT. ($)"]),
            "median_new_list_price": fi(r["MEDIAN NEW LISTING PRICE ($)"]),
            "homes_sold_yoy": f2(r["HOMES SOLD YOY (%)"]),
            "median_sale_price_yoy": f2(r["MEDIAN SALE PRICE NSA YOY (%)"]),
            "dom_yoy": f2(r["MEDIAN DAYS ON MARKET YOY (DAYS)"]),
            "price_drops_pct": f2(pdm.loc[d]["PERCENT ACTIVE WITH PRICE DROPS (%)"]) if d in pdm.index else None,
            "price_drop_avg_size": f2(pdm.loc[d]["AVERAGE SIZE OF PRICE DROP (%)"]) if d in pdm.index else None,
            "buyers_index": f2(bal.loc[d]["BUYERS"]) if d in bal.index else None,
            "sellers_index": f2(bal.loc[d]["SELLERS"]) if d in bal.index else None,
            "buyer_seller_ratio": f2(bal.loc[d]["BUYER-SELLER RATIO"]) if d in bal.index else None,
            "seller_buyer_pct_diff": f2(bal.loc[d]["SELLER-BUYER % DIFFERENCE"]) if d in bal.index else None,
        }
        for key, ptype in PTYPES.items():
            if len(pt) and (d, ptype) in pt.index:
                pr = pt.loc[(d, ptype)]
                row[f"homes_sold_{key}"] = fi(pr["HOMES SOLD"])
                row[f"median_sale_price_{key}"] = fi(pr["MEDIAN SALE PRICE NSA ($)"])
                row[f"dom_{key}"] = f2(pr["MEDIAN DAYS ON MARKET (DAYS)"])
                row[f"sale_to_list_{key}"] = f2(pr["AVERAGE SALE TO LIST RATIO (%)"])
                row[f"pct_above_list_{key}"] = f2(pr["SHARE SOLD ABOVE ORIGINAL LIST (%)"])
                row[f"new_listings_{key}"] = fi(pr["NEW LISTINGS"])
                row[f"active_listings_{key}"] = fi(pr["ACTIVE LISTINGS"])
                row[f"months_supply_{key}"] = f2(pr["MONTHS OF SUPPLY"])
            else:
                for f_ in ["homes_sold", "median_sale_price", "dom", "sale_to_list",
                           "pct_above_list", "new_listings", "active_listings",
                           "months_supply"]:
                    row[f"{f_}_{key}"] = None
        series.append({k: row[k] for k in METRO_ORDER})
    return {
        "market": MARKET,
        "region_name": REGION,
        "property_type_splits": PTYPES,
        "series": series,
    }


# ---------------------------------------------------------------- weekly.json
WEEKLY_ORDER = ["week_ending", "homes_sold", "new_listings_sa", "new_listings_nsa",
                "active_listings_sa", "active_listings_nsa", "pending_sales_sa",
                "pending_sales_nsa", "dom", "sale_to_list", "pct_above_list",
                "pct_off_market_2wk", "months_supply", "median_sale_price",
                "median_sale_price_psf", "homes_sold_yoy", "price_drops_pct"]


def build_weekly(w_path, pdw_path):
    w = pd.read_csv(w_path, low_memory=False)
    w = w[w["REGION NAME"] == REGION].sort_values("PERIOD END").reset_index(drop=True)
    pdw = pd.read_csv(pdw_path)
    pdw = pdw[pdw["REGION NAME"] == REGION].set_index("PERIOD END")
    series = []
    for _, r in w.iterrows():
        d = r["PERIOD END"]
        row = {
            "week_ending": d,
            "homes_sold": fi(r["HOMES SOLD NSA"]),
            "new_listings_sa": fi(r["NEW LISTINGS SA"]),
            "new_listings_nsa": fi(r["NEW LISTINGS NSA"]),
            "active_listings_sa": fi(r["ACTIVE LISTINGS SA"]),
            "active_listings_nsa": fi(r["ACTIVE LISTINGS NSA"]),
            "pending_sales_sa": fi(r["PENDING SALES SA"]),
            "pending_sales_nsa": fi(r["PENDING SALES NSA"]),
            "dom": f2(r["MEDIAN DAYS ON MARKET NSA (DAYS)"]),
            "sale_to_list": f2(r["AVERAGE SALE TO LIST RATIO NSA (%)"]),
            "pct_above_list": f2(r["SHARE SOLD ABOVE ORIGINAL LIST NSA (%)"]),
            "pct_off_market_2wk": f2(r["PERCENT OFF MARKET IN TWO WEEKS NSA (%)"]),
            "months_supply": f2(r["MONTHS OF SUPPLY NSA"]),
            "median_sale_price": fi(r["MEDIAN SALE PRICE NSA ($)"]),
            "median_sale_price_psf": fi(r["MEDIAN SALE PRICE PER SQ.FT. NSA ($)"]),
            "homes_sold_yoy": f2(r["HOMES SOLD NSA YOY (%)"]),
            "price_drops_pct": f2(pdw.loc[d]["PERCENT ACTIVE WITH PRICE DROPS (%)"]) if d in pdw.index else None,
        }
        series.append({k: row[k] for k in WEEKLY_ORDER})
    return {
        "market": MARKET,
        "frequency": "four_week_rolling",
        "note": "Each week covers a rolling 4-week period ending week_ending; sold-side metrics are NSA, listing counts given SA and NSA",
        "series": series,
    }


# ---------------------------------------------------------------- rates.json
def build_rates(path):
    f = pd.read_csv(path, parse_dates=["observation_date"])
    f = f.dropna(subset=["MORTGAGE30US"]).sort_values("observation_date")
    f["month"] = f["observation_date"].dt.to_period("M")
    rows = []
    latest_obs = None
    for period, grp in f.groupby("month", sort=True):
        y, mo = period.year, period.month
        month_end = f"{y:04d}-{mo:02d}-{calendar.monthrange(y, mo)[1]:02d}"
        rows.append([month_end, round(statistics.mean(grp["MORTGAGE30US"]), 3)])
        latest_obs = grp["observation_date"].max()
    last_y, last_m = rows[-1][0][:7].split("-")[0], rows[-1][0][5:7]
    last_day = calendar.monthrange(int(last_y), int(last_m))[1]
    partial = latest_obs.date().isoformat() < f"{last_y}-{last_m}-{last_day:02d}"
    note = None
    if partial:
        note = (f"Last month ({last_y}-{last_m}) is a partial-month average "
                f"(weekly data through {latest_obs.date().isoformat()} only)")
    return {
        "series": rows,
        "unit": "percent",
        "source": "FRED MORTGAGE30US, weekly resampled to monthly mean",
        "latest_month_partial": partial,
        "note": note,
    }


# ---------------------------------------------------------------- national_sales.json
def build_national(path):
    c = pd.read_csv(path, low_memory=False)
    c = c[c["REGION NAME"] == "National"].sort_values("PERIOD END")
    series = [{
        "date": r["PERIOD END"],
        "homes_sold": fi(r["HOMES SOLD"]),
        "pending_sales": fi(r["PENDING SALES"]),
        "median_sale_price": fi(r["MEDIAN SALE PRICE NSA ($)"]),
    } for _, r in c.iterrows()]
    return {
        "series": series,
        "note": "US national monthly from Redfin housing_market/monthly/country.csv",
    }


# ---------------------------------------------------------------- case_shiller.json
def build_case_shiller(path):
    f = pd.read_csv(path, parse_dates=["observation_date"])
    f = f.dropna(subset=["CSUSHPINSA"]).sort_values("observation_date")
    return {
        "series": [[d.date().isoformat(), round(float(v), 3)]
                   for d, v in zip(f["observation_date"], f["CSUSHPINSA"])],
        "unit": "index",
        "source": "FRED CSUSHPINSA",
    }


# ---------------------------------------------------------------- seasonality.json
MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July",
               "August", "September", "October", "November", "December"]


def _norm(vals, invert=False):
    mn, mx = min(vals), max(vals)
    out = [(v - mn) / (mx - mn) if mx > mn else 0.5 for v in vals]
    return [1 - x for x in out] if invert else out


def build_seasonality(metro):
    rows = metro["series"]
    by_year = {}
    for r in rows:
        y = int(r["date"][:4])
        by_year.setdefault(y, []).append(r)
    full_years = sorted(y for y, rs in by_year.items() if len(rs) == 12)
    years = full_years[-8:]
    months = []
    for mnum in range(1, 13):
        pool = [r for y in years for r in by_year[y]
                if int(r["date"][5:7]) == mnum
                and r["price_drops_pct"] is not None
                and r["months_supply"] is not None]
        if not pool:
            raise RuntimeError(f"no complete data for month {mnum}")
        months.append({
            "month": mnum,
            "month_name": MONTH_NAMES[mnum - 1],
            "avg_homes_sold": round(sum(r["homes_sold"] for r in pool) / len(pool), 1),
            "avg_sale_to_list": round(sum(r["sale_to_list"] for r in pool) / len(pool), 2),
            "avg_dom": round(sum(r["dom"] for r in pool) / len(pool), 1),
            "avg_price_drops_pct": round(sum(r["price_drops_pct"] for r in pool) / len(pool), 2),
            "avg_months_supply": round(sum(r["months_supply"] for r in pool) / len(pool), 2),
            "avg_median_sale_price": int(round(sum(r["median_sale_price"] for r in pool) / len(pool))),
        })
    scores = [sum(c) / 4 for c in zip(
        _norm([m["avg_sale_to_list"] for m in months]),
        _norm([m["avg_dom"] for m in months], True),
        _norm([m["avg_months_supply"] for m in months], True),
        _norm([m["avg_price_drops_pct"] for m in months], True))]
    for m, s in zip(months, scores):
        m["seller_score"] = round(s * 100, 1)
    ranked = sorted(months, key=lambda m: m["seller_score"], reverse=True)
    return {
        "years_used": years,
        "market": MARKET,
        "note": "seller_score 0-100, higher = better for sellers (high sale-to-list, low DOM, low supply, few price drops)",
        "months": months,
        "best_months_to_sell": [m["month_name"] for m in ranked[:3]],
        "best_months_to_buy": [m["month_name"] for m in ranked[-3:]][::-1],
    }


# ---------------------------------------------------------------- meta.json
def build_meta(files, today):
    def rng(series, key):
        return [series[0][key], series[-1][key]]

    def rng_pairs(series):
        return [series[0][0], series[-1][0]]

    date_range = {
        "zips": [min(v["series"][0][0] for v in files["zips"].values()),
                 max(v["series"][-1][0] for v in files["zips"].values())],
        "metro": rng(files["metro"]["series"], "date"),
        "weekly": rng(files["weekly"]["series"], "week_ending"),
        "rates": rng_pairs(files["rates"]["series"]),
        "national_sales": rng(files["national_sales"]["series"], "date"),
        "case_shiller": rng_pairs(files["case_shiller"]["series"]),
    }
    sources = {}
    for key, (name, url) in {
        "zips": ("Zillow ZHVI (zip, all tiers, smoothed, SA)", URLS["zips"]),
        "metro": ("Redfin Housing Market Tracker, monthly metro", URLS["metro"]),
        "weekly": ("Redfin Housing Market Tracker, 4-week rolling metro", URLS["weekly"]),
        "property_types": ("Redfin Housing Market Tracker by Property Type, monthly metro", URLS["property_types"]),
        "price_drops": ("Redfin Price Drops, monthly + weekly metro (top 50)", URLS["price_drops_m"]),
        "balance_of_power": ("Redfin Balance of Power: Buyers and Sellers, monthly metro (top 50)", URLS["balance"]),
        "rates": ("FRED 30-Yr Fixed Rate Mortgage Average in the US (MORTGAGE30US), weekly -> monthly mean", URLS["rates"]),
        "national_sales": ("Redfin Housing Market Tracker, monthly country (US)", URLS["national"]),
        "case_shiller": ("FRED S&P/Case-Shiller US National Home Price Index (CSUSHPINSA)", URLS["case_shiller"]),
    }.items():
        sources[key] = {"name": name, "url": url, "accessed": today}
    # keep the provenance note for the FRED -> Redfin substitution
    sources["national_sales"]["note"] = (
        "Substituted for FRED EXHOSLUSM495S, whose keyless CSV returned only 13 months")
    return {
        "sources": sources,
        "zip_count": len(files["zips"]),
        "zip_counties": BAY_COUNTIES,
        "market": MARKET,
        "date_range": date_range,
        "granularity_notes": "prices zip-level (Zillow ZHVI, all home tiers, smoothed SA); velocity metro-level (Redfin San Jose metro); buyer/seller balance metro-level monthly (Redfin top-50); rates national (FRED); weekly metrics are rolling 4-week periods",
    }


# ---------------------------------------------------------------- main
LOCAL_NAMES = {
    "zips": "z.csv", "metro": "m.csv", "weekly": "w.csv",
    "property_types": "pt.csv", "price_drops_m": "pdm.csv",
    "price_drops_w": "pdw.csv", "balance": "bs.csv",
    "rates": "fred_rate.csv", "case_shiller": "fred_case_shiller.csv",
    "national": "country.csv",
}


def main():
    dry = "--check" in sys.argv
    local_dir = None
    for a in sys.argv[1:]:
        if a.startswith("--local="):
            local_dir = a.split("=", 1)[1]
    print("Downloading sources..." if not local_dir else
          f"Using local sources from {local_dir} ...", flush=True)
    tmp_paths = {}
    try:
        if local_dir:
            for name in URLS:
                p = Path(local_dir) / LOCAL_NAMES[name]
                if not p.is_file():
                    raise RuntimeError(f"local source missing: {p}")
                tmp_paths[name] = str(p)
        else:
            for name, url in URLS.items():
                print(f"  {name} ...", flush=True)
                tmp_paths[name] = download(name, url)
    except RuntimeError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        print("Keeping existing data/ untouched.", file=sys.stderr)
        return 1

    try:
        print("Processing...", flush=True)
        files = {}
        files["zips"] = build_zips(tmp_paths["zips"])
        files["metro"] = build_metro(tmp_paths["metro"], tmp_paths["price_drops_m"],
                                     tmp_paths["balance"], tmp_paths["property_types"])
        files["weekly"] = build_weekly(tmp_paths["weekly"], tmp_paths["price_drops_w"])
        files["rates"] = build_rates(tmp_paths["rates"])
        files["national_sales"] = build_national(tmp_paths["national"])
        files["case_shiller"] = build_case_shiller(tmp_paths["case_shiller"])
        files["seasonality"] = build_seasonality(files["metro"])
        today = datetime.now(timezone.utc).date().isoformat()
        files["meta"] = build_meta(files, today)
    except Exception as e:  # noqa: BLE001 - report and keep old data
        print(f"ERROR while processing: {e}", file=sys.stderr)
        print("Keeping existing data/ untouched.", file=sys.stderr)
        return 1
    finally:
        if not local_dir:
            for p in tmp_paths.values():
                Path(p).unlink(missing_ok=True)

    # sanity: every file must have data
    counts = {
        "zips": len(files["zips"]),
        "metro": len(files["metro"]["series"]),
        "weekly": len(files["weekly"]["series"]),
        "rates": len(files["rates"]["series"]),
        "national_sales": len(files["national_sales"]["series"]),
        "case_shiller": len(files["case_shiller"]["series"]),
        "seasonality": len(files["seasonality"]["months"]),
        "meta": len(files["meta"]["sources"]),
    }
    for name, n in counts.items():
        print(f"  {name}.json: {n} entries")
        if n == 0:
            print(f"ERROR: {name}.json came out empty; keeping existing data/.", file=sys.stderr)
            return 1

    if dry:
        print("Dry run OK - nothing written.")
        return 0

    for name, obj in files.items():
        text = json.dumps(obj, ensure_ascii=False)
        if name == "meta":
            # meta.json is the one human-readable file (indent=1, no trailing newline)
            text = json.dumps(obj, indent=1, ensure_ascii=False)
        (DATA_DIR / f"{name}.json").write_text(text)
    print("Wrote 8 files to data/.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
