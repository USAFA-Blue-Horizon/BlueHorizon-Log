"""
Lookup relay for BlueHorizon Log (runs in GitHub Actions).

The browser app can't reach some APIs directly (CORS, or campus network
filtering of public proxies), so it commits request files here:

    data/lookups/requests/<id>.json   {"kind": "889"|"product", "query": "..."}

This script answers each one into:

    data/lookups/responses/<id>.json  {"ok": true, "kind": ..., "data": {...}}

kinds:
  889      query = vendor name  -> raw JSON from the GSA 889 SmartPay API
  product  query = product URL  -> {"title", "price", "qtyDesc"} best-effort
"""

import html as htmllib
import json
import os
import re
from pathlib import Path

import requests

REQ_DIR = Path("data/lookups/requests")
RES_DIR = Path("data/lookups/responses")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0 Safari/537.36")


def lookup_889(vendor: str) -> dict:
    r = requests.get(
        "https://889.smartpay.gsa.gov/api/entity-information/v3/entities",
        params={"samToolsSearch": vendor, "page": 0},
        headers={"Accept": "application/json"},
        timeout=30,
    )
    r.raise_for_status()
    data = r.json()
    # trim to what the app needs (keep response files small)
    out = {"totalRecords": data.get("totalRecords", 0), "entityData": []}
    for e in (data.get("entityData") or [])[:6]:
        out["entityData"].append({
            "entityRegistration": {
                "legalBusinessName": (e.get("entityRegistration") or {}).get("legalBusinessName")
            },
            "samToolsData": {
                "eightEightNine": {
                    "statusText": ((e.get("samToolsData") or {}).get("eightEightNine") or {}).get("statusText")
                }
            },
        })
    return out


def lookup_product(url: str) -> dict:
    r = requests.get(url, headers={"User-Agent": UA, "Accept-Language": "en-US"}, timeout=30)
    text = r.text
    title = None
    m = (re.search(r'<meta[^>]*(?:og:title|twitter:title)[^>]*content=["\']([^"\']+)', text, re.I)
         or re.search(r"<title[^>]*>([^<]+)<", text, re.I))
    if m:
        title = htmllib.unescape(m.group(1)).strip()
        title = re.sub(r"\s*[|–-]\s*(Amazon|McMaster|DigiKey|eBay).*$", "", title, flags=re.I)[:100]
    price = None
    for pat in (r'og:price:amount["\'][^>]*content=["\']([\d.,]+)',
                r'"price"\s*:\s*"?\$?([\d,]+\.?\d{0,2})"?',
                r"\$\s?([\d,]+\.\d{2})"):
        pm = re.search(pat, text, re.I)
        if pm:
            try:
                price = float(pm.group(1).replace(",", ""))
                break
            except ValueError:
                continue
    qty_desc = None
    if title:
        qm = re.search(r"(?:pack|box|bag|set) of (\d+)|(\d+)\s?[- ]?(?:pack|pcs|pieces|count|ct)\b", title, re.I)
        if qm:
            qty_desc = f"pack of {qm.group(1) or qm.group(2)}"
    return {"title": title, "price": price, "qtyDesc": qty_desc}


def main():
    RES_DIR.mkdir(parents=True, exist_ok=True)
    if not REQ_DIR.exists():
        print("no requests dir")
        return
    for req_file in sorted(REQ_DIR.glob("*.json")):
        rid = req_file.stem
        try:
            req = json.loads(req_file.read_text())
            kind = req.get("kind")
            query = str(req.get("query", ""))[:500]
            if kind == "889":
                data = lookup_889(query)
            elif kind == "product":
                data = lookup_product(query)
            else:
                raise ValueError(f"unknown kind {kind!r}")
            resp = {"ok": True, "kind": kind, "data": data}
        except Exception as e:  # answer with the error so the app can show it
            resp = {"ok": False, "error": str(e)[:300]}
        (RES_DIR / f"{rid}.json").write_text(json.dumps(resp, indent=1))
        req_file.unlink()
        print(f"answered {rid}: ok={resp['ok']}")


if __name__ == "__main__":
    main()
