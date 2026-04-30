import json
import re
import subprocess
import sys
import time
import warnings
warnings.filterwarnings("ignore")
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.parse import urljoin
from urllib.request import Request, urlopen

import argostranslate.package
import argostranslate.translate
import feedparser
import schedule

# ─── Config ──────────────────────────────────────────────────────────────────

FEEDS = [
    {"name": "BBC 中文",        "url": "https://feeds.bbci.co.uk/zhongwen/simp/rss.xml"},
    {"name": "纽约时报中文",    "url": "https://cn.nytimes.com/rss/"},
    {"name": "美国之音中文",    "url": "https://www.voachinese.com/api/"},
    {"name": "法广中文",        "url": "https://www.rfi.fr/cn/rss"},
    {"name": "半岛电视台",      "url": "https://www.aljazeera.com/xml/rss/all.xml"},
    {"name": "Odaily 星球日报", "url": "https://rss.app/feeds/w0bs1AROlovDfGdJ.xml"},
]

TWENTY_FOUR_HOURS = timedelta(hours=24)
SUMMARY_MAX_LEN = 100   # chars shown as excerpt
FETCH_TIMEOUT = 8       # seconds

# ─── Feed Fetching ───────────────────────────────────────────────────────────

def fetch_feed(source: dict) -> list[dict]:
    """Fetch and parse a single RSS/Atom feed, return articles from last 24 h."""
    feed = feedparser.parse(source["url"], request_headers={"User-Agent": "ai-news-digest/1.0"})

    if feed.bozo and not feed.entries:
        raise ValueError(f"解析失败: {feed.bozo_exception}")

    now = datetime.now(timezone.utc)
    articles = []

    for entry in feed.entries:
        title = (entry.get("title") or "").strip()
        link  = (entry.get("link")  or "").strip()
        if not title or not link:
            continue

        # feedparser normalises dates into 9-tuple; convert to aware datetime
        pub = entry.get("published_parsed") or entry.get("updated_parsed")
        if not pub:
            continue
        published_at = datetime(*pub[:6], tzinfo=timezone.utc)

        if now - published_at > TWENTY_FOUR_HOURS:
            continue

        # feedparser already strips most HTML from summary / description
        raw_desc = (
            entry.get("summary")
            or entry.get("description")
            or entry.get("content", [{}])[0].get("value", "")
        )
        text = _clean_text(raw_desc)
        summary = text[:SUMMARY_MAX_LEN] + "…" if len(text) > SUMMARY_MAX_LEN else text
        image = _extract_image(entry, raw_desc)

        articles.append({
            "title":        title,
            "link":         link,
            "published_at": published_at,
            "source":       source["name"],
            "summary":      summary,
            "image":        image,
        })

    return articles


def _extract_image(entry, raw_html: str) -> str:
    """Pull a cover image URL from an RSS entry, trying common fields."""
    # 1) media_thumbnail / media_content (MRSS)
    for key in ("media_thumbnail", "media_content"):
        items = entry.get(key) or []
        if isinstance(items, list):
            for it in items:
                url = (it or {}).get("url")
                if url:
                    return url
    # 2) enclosures
    for enc in entry.get("enclosures", []) or []:
        if (enc.get("type") or "").startswith("image/"):
            href = enc.get("href") or enc.get("url")
            if href:
                return href
    # 3) embedded <img> inside description/summary/content
    if raw_html:
        m = re.search(r'<img[^>]+src=["\']([^"\']+)["\']', raw_html)
        if m:
            return m.group(1)
    return ""


# Matches <meta property="og:image" content="…"> (and twitter:image), tolerant to
# attribute order and quoting. Only used as a network-fallback when the RSS entry
# itself has no image.
_OG_RE = re.compile(
    r'<meta[^>]+(?:property|name)=["\'](?:og:image(?::url)?|twitter:image)["\']'
    r'[^>]*content=["\']([^"\']+)["\']',
    re.IGNORECASE,
)
_OG_RE_REV = re.compile(
    r'<meta[^>]+content=["\']([^"\']+)["\'][^>]*'
    r'(?:property|name)=["\'](?:og:image(?::url)?|twitter:image)["\']',
    re.IGNORECASE,
)


def fetch_og_image(page_url: str, timeout: float = FETCH_TIMEOUT) -> str:
    """Download a page and return its og:image / twitter:image URL, or ''."""
    try:
        req = Request(page_url, headers={
            "User-Agent": "Mozilla/5.0 (compatible; ai-news-digest/1.0)",
            "Accept":     "text/html,application/xhtml+xml",
        })
        with urlopen(req, timeout=timeout) as resp:
            # Only read the <head> portion — og tags are always near the top.
            raw = resp.read(65536)
        try:
            html = raw.decode("utf-8", errors="ignore")
        except Exception:
            return ""
        # Cut at </head> to avoid matching inline content further down
        head_end = html.lower().find("</head>")
        if head_end > 0:
            html = html[:head_end]
        m = _OG_RE.search(html) or _OG_RE_REV.search(html)
        if not m:
            return ""
        return urljoin(page_url, m.group(1).strip())
    except Exception:
        return ""


def backfill_images(articles: list[dict], max_workers: int = 10) -> None:
    """For articles without an image, fetch the page and extract og:image.

    Runs in parallel threads. Any failure just leaves the image empty.
    """
    targets = [a for a in articles if not a.get("image")]
    if not targets:
        return
    print(f"\n正在为 {len(targets)} 篇无图文章抓取 og:image...")
    done = 0
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        future_to_art = {pool.submit(fetch_og_image, a["link"]): a for a in targets}
        for fut in as_completed(future_to_art):
            a = future_to_art[fut]
            try:
                url = fut.result()
            except Exception:
                url = ""
            if url:
                a["image"] = url
            done += 1
    filled = sum(1 for a in targets if a.get("image"))
    print(f"✓ og:image 补齐 {filled}/{len(targets)} 篇")


def _clean_text(html: str) -> str:
    """Strip residual HTML tags and collapse whitespace."""
    text = re.sub(r"<[^>]+>", " ", html)
    text = re.sub(r"&amp;",  "&",  text)
    text = re.sub(r"&lt;",   "<",  text)
    text = re.sub(r"&gt;",   ">",  text)
    text = re.sub(r"&quot;", '"',  text)
    text = re.sub(r"&#39;",  "'",  text)
    text = re.sub(r"&nbsp;", " ",  text)
    text = re.sub(r"\s+",    " ",  text)
    return text.strip()


# ─── Translation (English → Chinese, offline via argostranslate) ─────────────

def _is_english(text: str) -> bool:
    """Return True if text is predominantly English (>80% ASCII letters)."""
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return False
    ascii_count = sum(1 for c in letters if ord(c) < 128)
    return ascii_count / len(letters) > 0.8


def _ensure_model() -> bool:
    """Ensure en→zh model is installed. Downloads once on first run."""
    installed = argostranslate.translate.get_installed_languages()
    codes = {lang.code for lang in installed}
    if "en" in codes and "zh" in codes:
        return True
    print("首次运行，正在下载英译中离线模型（约 100MB）...")
    try:
        argostranslate.package.update_package_index()
        available = argostranslate.package.get_available_packages()
        pkg = next((p for p in available if p.from_code == "en" and p.to_code == "zh"), None)
        if not pkg:
            print("⚠ 未找到英译中模型包")
            return False
        argostranslate.package.install_from_path(pkg.download())
        print("✓ 模型安装完成")
        return True
    except Exception as e:
        print(f"⚠ 模型下载失败：{e}")
        return False


def translate_english_articles(articles: list[dict]) -> None:
    """Translate English titles and summaries to Chinese in-place (fully offline)."""
    english_idx = [i for i, a in enumerate(articles) if _is_english(a["title"])]
    if not english_idx:
        return

    if not _ensure_model():
        print(f"⚠ 跳过翻译，{len(english_idx)} 篇英文文章将保留原文。")
        return

    print(f"\n正在本地翻译 {len(english_idx)} 篇英文文章...")
    for n, i in enumerate(english_idx, 1):
        print(f"  {n}/{len(english_idx)} ... ", end="", flush=True)
        a = articles[i]
        a["title"] = argostranslate.translate.translate(a["title"], "en", "zh")
        if a["summary"]:
            a["summary"] = argostranslate.translate.translate(a["summary"], "en", "zh")
        print("✓")
    print(f"✓ 翻译完成（{len(english_idx)} 篇）")

# ─── Markdown Renderer ───────────────────────────────────────────────────────

CST = timezone(timedelta(hours=8))

def _fmt_dt(dt: datetime) -> str:
    local = dt.astimezone(CST)
    return local.strftime("%m/%d %H:%M")


def render_markdown(articles: list[dict], successful_sources: set[str]) -> str:
    today = datetime.now(CST).strftime("%Y/%m/%d")
    now_str = datetime.now(CST).strftime("%Y/%m/%d %H:%M:%S")
    source_list = " / ".join(successful_sources)

    lines = [
        f"# AI 新闻日报 · {today}",
        "",
        f"> 共收录 **{len(articles)}** 篇，来自 **{len(successful_sources)}** 个源（{source_list}）",
        f"> 时间范围：过去 24 小时 | 生成时间：{now_str}",
        "",
        "---",
        "",
    ]

    for article in articles:
        lines += [
            f"### [{article['title']}]({article['link']})",
            "",
            f"**{_fmt_dt(article['published_at'])}** · {article['source']}",
        ]
        if article["summary"]:
            lines += ["", f"> {article['summary']}"]
        lines += ["", "---", ""]

    return "\n".join(lines)

# ─── JSON + HTML Renderer ────────────────────────────────────────────────────

def render_json(articles: list[dict], successful_sources: set[str]) -> str:
    """Serialize today's digest to JSON (used by the web dashboard)."""
    now_str = datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S")
    data = {
        "date":        datetime.now(CST).strftime("%Y-%m-%d"),
        "generated_at": now_str,
        "sources":     sorted(successful_sources),
        "articles": [
            {
                "title":        a["title"],
                "link":         a["link"],
                "source":       a["source"],
                "summary":      a["summary"],
                "image":        a.get("image", ""),
                "published_at": a["published_at"].astimezone(CST).strftime("%Y-%m-%d %H:%M"),
                "timestamp":    int(a["published_at"].timestamp()),
            }
            for a in articles
        ],
    }
    return json.dumps(data, ensure_ascii=False, indent=2)


def render_index_html(output_dir: Path) -> None:
    """Regenerate output/manifest.json listing every available digest date.

    The previous versions of this function built a single self-contained
    index.html. The Worker now renders the UI server-side, so all we need is
    a small manifest of (date, article_count) pairs for the date selector."""
    manifest = {"dates": []}
    for p in sorted(output_dir.glob("*.json")):
        if p.name == "manifest.json":
            continue
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            manifest["dates"].append({
                "date":  p.stem,
                "count": len(data.get("articles", [])),
            })
        except Exception as e:
            print(f"⚠ 跳过损坏的 JSON：{p.name} ({e})")
    manifest["dates"].sort(key=lambda x: x["date"], reverse=True)
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )


# ─── Main ────────────────────────────────────────────────────────────────────

def main() -> None:
    print("正在抓取 RSS 源...\n")

    all_articles: list[dict] = []
    successful_sources: set[str] = set()

    for source in FEEDS:
        try:
            articles = fetch_feed(source)
            successful_sources.add(source["name"])
            print(f"✓ {source['name']}: {len(articles)} 篇")
            all_articles.extend(articles)
        except Exception as e:
            print(f"✗ {source['name']}: {e}")

    all_articles.sort(key=lambda a: a["published_at"], reverse=True)
    print(f"\n共收录 {len(all_articles)} 篇文章，来自 {len(successful_sources)} 个源")

    if not all_articles:
        print("没有符合条件的文章，日报未生成。")
        return

    backfill_images(all_articles)
    translate_english_articles(all_articles)

    output_dir = Path(__file__).parent.parent / "output"
    output_dir.mkdir(exist_ok=True)

    date_str  = datetime.now(CST).strftime("%Y-%m-%d")
    out_path  = output_dir / f"{date_str}.md"
    markdown  = render_markdown(all_articles, successful_sources)
    out_path.write_text(markdown, encoding="utf-8")

    json_path = output_dir / f"{date_str}.json"
    json_path.write_text(render_json(all_articles, successful_sources), encoding="utf-8")

    render_index_html(output_dir)

    print(f"\n日报已生成：")
    print(f"  · Markdown：{out_path}")
    print(f"  · 数据：    {json_path}")
    print(f"  · 索引：    {output_dir / 'manifest.json'}")

    auto_publish(output_dir.parent, date_str)


# ─── Git auto-publish ────────────────────────────────────────────────────────

def auto_publish(repo_root: Path, date_str: str) -> None:
    """Commit output/ and push to origin. Silent no-op if not a git repo or
    no remote is configured. Failures are logged but do not abort the run."""
    if not (repo_root / ".git").exists():
        return
    try:
        has_remote = subprocess.run(
            ["git", "-C", str(repo_root), "remote"],
            capture_output=True, text=True, check=True
        ).stdout.strip()
        if not has_remote:
            return

        # Only stage and commit generated output artifacts.
        subprocess.run(
            ["git", "-C", str(repo_root), "add", "output/"],
            check=True,
        )
        diff = subprocess.run(
            ["git", "-C", str(repo_root), "diff", "--cached", "--quiet", "--", "output/"],
            capture_output=True, text=True,
        )
        if diff.returncode == 0:
            print("（无内容变化，跳过推送）")
            return
        if diff.returncode != 1:
            raise RuntimeError(diff.stderr.strip() or "git diff failed")

        subprocess.run(
            ["git", "-C", str(repo_root), "commit", "-m", f"update digest {date_str}", "--", "output/"],
            check=True, capture_output=True,
        )
        push = subprocess.run(
            ["git", "-C", str(repo_root), "push"],
            capture_output=True, text=True,
        )
        if push.returncode == 0:
            print("✓ 已推送到 GitHub（Cloudflare Pages 将自动部署）")
        else:
            print(f"⚠ 推送失败：{push.stderr.strip()}")
    except Exception as e:
        print(f"⚠ 自动发布出错：{e}")


# ─── Entry Point ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if "-cron" in sys.argv:
        print("定时模式已启动，每天 08:00 (Asia/Shanghai) 自动生成日报")
        print("按 Ctrl+C 退出\n")

        # Run immediately on start
        main()

        schedule.every().day.at("08:00").do(main)

        while True:
            schedule.run_pending()
            time.sleep(30)
    else:
        main()
