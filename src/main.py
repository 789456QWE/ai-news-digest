import json
import re
import subprocess
import sys
import time
import warnings
warnings.filterwarnings("ignore")
from datetime import datetime, timezone, timedelta
from pathlib import Path

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

        articles.append({
            "title":        title,
            "link":         link,
            "published_at": published_at,
            "source":       source["name"],
            "summary":      summary,
        })

    return articles


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
                "published_at": a["published_at"].astimezone(CST).strftime("%Y-%m-%d %H:%M"),
                "timestamp":    int(a["published_at"].timestamp()),
            }
            for a in articles
        ],
    }
    return json.dumps(data, ensure_ascii=False, indent=2)


HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI 新闻日报</title>
<style>
  :root {
    --bg: #0f1115;
    --panel: #171a21;
    --panel-2: #1f232c;
    --border: #2a2f3a;
    --text: #e6e8ec;
    --text-2: #9aa3b2;
    --accent: #6ea8fe;
    --accent-2: #a78bfa;
    --chip: #242833;
    --chip-active: #2e5eaa;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f6f7f9;
      --panel: #ffffff;
      --panel-2: #f1f3f7;
      --border: #e2e6ee;
      --text: #1a1d24;
      --text-2: #5a6474;
      --accent: #2563eb;
      --accent-2: #7c3aed;
      --chip: #eef1f6;
      --chip-active: #2563eb;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
  }
  .container { max-width: 960px; margin: 0 auto; padding: 32px 20px 64px; }
  header { margin-bottom: 28px; }
  h1 {
    margin: 0 0 8px;
    font-size: 28px;
    font-weight: 700;
    letter-spacing: -0.5px;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }
  .meta { color: var(--text-2); font-size: 14px; }
  .meta strong { color: var(--text); }
  .controls {
    display: flex; flex-wrap: wrap; gap: 12px;
    margin: 20px 0 8px;
    padding: 14px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
  }
  .controls label { font-size: 13px; color: var(--text-2); display: flex; align-items: center; gap: 6px; }
  .controls select, .controls input {
    background: var(--panel-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px 10px;
    font-size: 14px;
    font-family: inherit;
    outline: none;
  }
  .controls input:focus, .controls select:focus { border-color: var(--accent); }
  .controls input { flex: 1; min-width: 160px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 14px 0 20px; }
  .chip {
    background: var(--chip);
    color: var(--text-2);
    border: 1px solid var(--border);
    padding: 4px 12px;
    border-radius: 999px;
    cursor: pointer;
    font-size: 13px;
    transition: all .15s ease;
    user-select: none;
  }
  .chip:hover { color: var(--text); }
  .chip.active {
    background: var(--chip-active);
    border-color: var(--chip-active);
    color: #fff;
  }
  .stats {
    display: flex; gap: 18px; flex-wrap: wrap;
    color: var(--text-2); font-size: 13px;
    margin-bottom: 18px;
  }
  .stats b { color: var(--text); font-weight: 600; }
  .article {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 18px 20px;
    margin-bottom: 12px;
    transition: border-color .15s ease, transform .15s ease;
  }
  .article:hover { border-color: var(--accent); }
  .article h2 {
    margin: 0 0 8px;
    font-size: 17px;
    font-weight: 600;
    line-height: 1.4;
  }
  .article h2 a { color: var(--text); text-decoration: none; }
  .article h2 a:hover { color: var(--accent); }
  .article-meta {
    display: flex; flex-wrap: wrap; gap: 10px;
    font-size: 12px; color: var(--text-2);
    margin-bottom: 10px;
  }
  .source-tag {
    background: var(--panel-2);
    border: 1px solid var(--border);
    padding: 2px 8px;
    border-radius: 4px;
    color: var(--accent);
    font-weight: 500;
  }
  .summary { color: var(--text-2); font-size: 14px; margin: 0; }
  .empty { text-align: center; padding: 60px 20px; color: var(--text-2); }
  mark { background: rgba(110, 168, 254, 0.3); color: inherit; padding: 0 2px; border-radius: 2px; }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>AI 新闻日报</h1>
    <div class="meta" id="meta"></div>
  </header>

  <div class="controls">
    <label>日期
      <select id="dateSel"></select>
    </label>
    <label>排序
      <select id="sortSel">
        <option value="time-desc">最新优先</option>
        <option value="time-asc">最早优先</option>
        <option value="source">按来源</option>
      </select>
    </label>
    <input id="search" type="search" placeholder="搜索标题或摘要...">
  </div>

  <div class="chips" id="chips"></div>

  <div class="stats" id="stats"></div>

  <div id="list"></div>
</div>

<script id="data" type="application/json">__DATA_JSON__</script>
<script>
const ALL = JSON.parse(document.getElementById('data').textContent);
const dates = Object.keys(ALL).sort().reverse();
const dateSel = document.getElementById('dateSel');
const sortSel = document.getElementById('sortSel');
const search = document.getElementById('search');
const chipsEl = document.getElementById('chips');
const listEl = document.getElementById('list');
const statsEl = document.getElementById('stats');
const metaEl = document.getElementById('meta');

let activeSources = new Set();

dates.forEach(d => {
  const opt = document.createElement('option');
  opt.value = d; opt.textContent = d + ' (' + ALL[d].articles.length + ')';
  dateSel.appendChild(opt);
});

function render() {
  const day = ALL[dateSel.value];
  if (!day) return;

  metaEl.innerHTML = '生成于 <strong>' + day.generated_at + '</strong> · 来自 <strong>' + day.sources.length + '</strong> 个源';

  // source chips
  chipsEl.innerHTML = '';
  const srcCounts = {};
  day.articles.forEach(a => srcCounts[a.source] = (srcCounts[a.source] || 0) + 1);
  const allChip = mkChip('全部 ' + day.articles.length, activeSources.size === 0);
  allChip.onclick = () => { activeSources.clear(); render(); };
  chipsEl.appendChild(allChip);
  day.sources.forEach(s => {
    const chip = mkChip(s + ' ' + (srcCounts[s] || 0), activeSources.has(s));
    chip.onclick = () => {
      if (activeSources.has(s)) activeSources.delete(s); else activeSources.add(s);
      render();
    };
    chipsEl.appendChild(chip);
  });

  // filter + sort
  const kw = search.value.trim().toLowerCase();
  let items = day.articles.filter(a => {
    if (activeSources.size && !activeSources.has(a.source)) return false;
    if (kw && !(a.title.toLowerCase().includes(kw) || (a.summary || '').toLowerCase().includes(kw))) return false;
    return true;
  });
  const sortMode = sortSel.value;
  if (sortMode === 'time-desc') items.sort((a, b) => b.timestamp - a.timestamp);
  else if (sortMode === 'time-asc') items.sort((a, b) => a.timestamp - b.timestamp);
  else items.sort((a, b) => a.source.localeCompare(b.source) || b.timestamp - a.timestamp);

  statsEl.innerHTML = '显示 <b>' + items.length + '</b> / ' + day.articles.length + ' 篇';

  if (!items.length) {
    listEl.innerHTML = '<div class="empty">没有匹配的文章</div>';
    return;
  }

  listEl.innerHTML = items.map(a => `
    <article class="article">
      <h2><a href="${escapeHtml(a.link)}" target="_blank" rel="noopener">${highlight(a.title, kw)}</a></h2>
      <div class="article-meta">
        <span class="source-tag">${escapeHtml(a.source)}</span>
        <span>${escapeHtml(a.published_at)}</span>
      </div>
      ${a.summary ? `<p class="summary">${highlight(a.summary, kw)}</p>` : ''}
    </article>
  `).join('');
}

function mkChip(text, active) {
  const el = document.createElement('span');
  el.className = 'chip' + (active ? ' active' : '');
  el.textContent = text;
  return el;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function highlight(s, kw) {
  const esc = escapeHtml(s);
  if (!kw) return esc;
  const re = new RegExp('(' + kw.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&') + ')', 'gi');
  return esc.replace(re, '<mark>$1</mark>');
}

dateSel.onchange = render;
sortSel.onchange = render;
search.oninput = render;
render();
</script>
</body>
</html>
"""


def render_index_html(output_dir: Path) -> None:
    """Regenerate output/index.html from every *.json file in output_dir."""
    data_by_date: dict[str, dict] = {}
    for p in sorted(output_dir.glob("*.json")):
        try:
            data_by_date[p.stem] = json.loads(p.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"⚠ 跳过损坏的 JSON：{p.name} ({e})")
    if not data_by_date:
        return
    payload = json.dumps(data_by_date, ensure_ascii=False)
    # Guard against </script> injection inside the embedded JSON
    payload = payload.replace("</", "<\\/")
    html = HTML_TEMPLATE.replace("__DATA_JSON__", payload)
    (output_dir / "index.html").write_text(html, encoding="utf-8")


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
    html_path = output_dir / "index.html"

    print(f"\n日报已生成：")
    print(f"  · Markdown：{out_path}")
    print(f"  · 数据：    {json_path}")
    print(f"  · 网页：    {html_path}")

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

        # Only stage output artifacts we care about
        subprocess.run(
            ["git", "-C", str(repo_root), "add", "output/"],
            check=True,
        )
        status = subprocess.run(
            ["git", "-C", str(repo_root), "status", "--porcelain"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        if not status:
            print("（无内容变化，跳过推送）")
            return

        subprocess.run(
            ["git", "-C", str(repo_root), "commit", "-m", f"update digest {date_str}"],
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
