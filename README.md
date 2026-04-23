# AI 新闻日报

每天抓取 6 个中英文新闻源过去 24 小时的新闻，英文文章本地离线翻译成中文，输出成 Markdown 日报和可视化网页。

## 运行

```bash
# 立即生成一次
python3 src/main.py

# 定时模式（每天 08:00 CST）
python3 src/main.py -cron
```

## 产物

- `output/YYYY-MM-DD.md` — 当日日报（Markdown）
- `output/YYYY-MM-DD.json` — 结构化数据
- `output/index.html` — 聚合网页（所有历史日报，可切换日期、筛选来源、搜索）

## 在线地址

网站由 Cloudflare Pages 自动部署自 `output/` 目录，每天定时任务推送后自动刷新。
