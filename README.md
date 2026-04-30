# AI 新闻日报

每天抓取 6 个中英文新闻源过去 24 小时的新闻，英文文章本地离线翻译成中文，输出 Markdown 日报、结构化 JSON，并通过 Cloudflare Worker 提供带登录的新闻网页。

## 运行

```bash
# 安装 Python 依赖
python3 -m pip install -r requirements.txt

# 立即生成一次
python3 src/main.py

# 定时模式（每天 08:00 CST）
python3 src/main.py -cron
```

## 产物

- `output/YYYY-MM-DD.md` — 当日日报（Markdown）
- `output/YYYY-MM-DD.json` — 结构化数据
- `output/manifest.json` — 可用日报日期索引，供 Worker 页面读取

## 部署

Cloudflare Worker 入口在 `worker/src/index.js`，D1 migration 在 `worker/migrations/`。Worker 通过 `wrangler.toml` 的 `ASSETS` 绑定读取 `output/`，并用 D1 保存用户和 session。

```bash
wrangler d1 migrations apply ai-news-db
wrangler deploy
```

`python3 src/main.py` 生成日报后会只暂存并提交 `output/` 下的产物，然后推送到远端，让 Cloudflare 自动刷新静态数据。
