"""One-off: parse existing output/*.md and emit matching .json so the dashboard
has historical data on first open. Safe to re-run; skips dates that already
have a .json file."""

import json
import re
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

CST = timezone(timedelta(hours=8))
OUT = Path(__file__).parent.parent / "output"

# Header: "> 共收录 **N** 篇，来自 **M** 个源（A / B / C）"
HEADER_RE   = re.compile(r"共收录 \*\*(\d+)\*\* 篇，来自 \*\*(\d+)\*\* 个源（([^）]+)）")
GENTIME_RE  = re.compile(r"生成时间：([0-9/ :]+)")
TITLE_RE    = re.compile(r"^### \[(.+?)\]\((.+?)\)\s*$")
META_RE     = re.compile(r"^\*\*(\d{2})/(\d{2}) (\d{2}):(\d{2})\*\* · (.+?)\s*$")
SUMMARY_RE  = re.compile(r"^> (.+?)\s*$")


def parse_md(path: Path) -> Optional[dict]:
    date_str = path.stem  # YYYY-MM-DD
    try:
        year = int(date_str.split("-")[0])
    except ValueError:
        return None

    text = path.read_text(encoding="utf-8")
    m = HEADER_RE.search(text)
    sources = []
    if m:
        sources = [s.strip() for s in m.group(3).split("/")]

    gm = GENTIME_RE.search(text)
    generated_at = gm.group(1).strip().replace("/", "-") if gm else f"{date_str} 00:00:00"

    articles = []
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        tm = TITLE_RE.match(lines[i])
        if not tm:
            i += 1
            continue
        title, link = tm.group(1), tm.group(2)

        # find meta line within next few lines
        meta = None
        j = i + 1
        while j < min(i + 4, len(lines)):
            mm = META_RE.match(lines[j])
            if mm:
                meta = mm
                break
            j += 1
        if not meta:
            i += 1
            continue
        month, day, hour, minute, source = meta.groups()
        dt = datetime(year, int(month), int(day), int(hour), int(minute), tzinfo=CST)

        # find summary within next few lines
        summary = ""
        k = j + 1
        while k < min(j + 4, len(lines)):
            sm = SUMMARY_RE.match(lines[k])
            if sm:
                summary = sm.group(1)
                break
            k += 1

        articles.append({
            "title":        title,
            "link":         link,
            "source":       source,
            "summary":      summary,
            "published_at": dt.strftime("%Y-%m-%d %H:%M"),
            "timestamp":    int(dt.timestamp()),
        })
        i = k + 1

    if not sources:
        sources = sorted({a["source"] for a in articles})

    return {
        "date":          date_str,
        "generated_at":  generated_at,
        "sources":       sources,
        "articles":      articles,
    }


def main():
    force = "--force" in sys.argv
    created = 0
    for md in sorted(OUT.glob("*.md")):
        jp = OUT / f"{md.stem}.json"
        if jp.exists() and not force:
            continue
        data = parse_md(md)
        if not data:
            continue
        jp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"✓ {md.stem}: {len(data['articles'])} 篇")
        created += 1
    print(f"\n完成，共生成 {created} 个 .json 文件")


if __name__ == "__main__":
    main()
