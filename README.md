# AI 新闻日报 (News Hub)

一个每天自动抓取多家中英文新闻、翻译成中文、做成精美网页给你看的小项目。

**线上地址**：https://ainews.fntymc.com （需要注册账号登录）

---

## 它能干什么

每天早上自动做这几件事，**全程零人工**：

1. **抓新闻** —— 从 6 个新闻源拉过去 24 小时的文章
   - BBC 中文 · 纽约时报中文 · 美国之音中文 · 法广中文 · 半岛电视台 · Odaily 星球日报
2. **翻译** —— 英文标题和摘要本地翻译成中文（用 Argos 离线模型，不调任何 API、不花钱）
3. **配图** —— RSS 没带图的文章，自动打开网页抓 `og:image` 当封面
4. **去重** —— 把"全站默认 logo"那种敷衍图清掉，避免一片相同图标
5. **发布** —— 生成 Markdown 日报 + JSON 数据 + 静态网页，推到 GitHub
6. **上线** —— Cloudflare 检测到 push 自动重新部署，几分钟后线上就能看到新的一天

成品长这样：彭博终端风格的暗色界面，带登录、搜索、按来源筛选、按日期切换。

---

## 项目结构（小白版）

```
Claude-First-Project/
├── src/main.py              ← Python 抓取脚本（核心逻辑）
├── worker/
│   ├── src/index.js         ← 网站后端（登录、API、HTML 渲染）
│   └── migrations/          ← 数据库表结构（用户表、session 表）
├── output/                  ← 每天生成的日报存这里
│   ├── 2026-05-03.json      ← 当天结构化数据
│   ├── 2026-05-03.md        ← 当天 Markdown 日报
│   └── manifest.json        ← 所有可用日期的索引
├── .github/workflows/
│   └── daily-digest.yml     ← 定时任务配置（每天自动跑）
├── wrangler.toml            ← Cloudflare 部署配置
├── requirements.txt         ← Python 依赖列表
└── README.md                ← 你正在看的这个
```

---

## 整套系统怎么运转的（一图看懂）

```
  GitHub Actions (每天北京时间 7:00 自动触发)
            │
            ▼
  ┌──────────────────────┐
  │  python src/main.py  │  ① 跑 Python 脚本抓 6 个 RSS
  │                      │  ② 翻译英文文章
  │                      │  ③ 抓封面、去重
  │                      │  ④ 生成 .json / .md / index.html
  └──────────┬───────────┘
             │ 自动 git commit & push
             ▼
        GitHub 仓库
             │ Cloudflare 检测到 push
             ▼
  ┌──────────────────────┐
  │  Cloudflare Worker   │  Worker 代码（登录、API、HTML）+
  │  + D1 数据库         │  把 output/ 当静态资源服务出去
  │  + 自定义域名         │
  └──────────┬───────────┘
             │
             ▼
   ainews.fntymc.com  ← 用户访问这里看新闻
```

**关键点**：你电脑就算关机，每天到点也会照常更新。所有事情都在云端跑。

---

## 用到的技术（每个都简单解释一下）

| 技术 | 干什么用的 | 一句话解释 |
|------|----------|-----------|
| **Python** | 抓新闻、翻译、生成数据 | 跑爬虫 + 解析 RSS 最方便的语言 |
| **feedparser** | 解析 RSS feed | 一个 Python 库，能把各种 RSS/Atom 格式吃进来变成对象 |
| **argostranslate** | 离线英译中 | 把 100MB 的翻译模型下到本地跑，**不调任何收费 API** |
| **GitHub Actions** | 每天定时执行 | GitHub 给你的"免费云服务器"，按 cron 跑脚本 |
| **Cloudflare Worker** | 跑网站后端 | 边缘计算，免费配额很大，全球 CDN |
| **Cloudflare D1** | 存数据库 | Cloudflare 的轻量 SQLite，存用户和 session |
| **Wrangler** | Cloudflare 部署工具 | 把 Worker 代码 + 配置上传到 Cloudflare 的 CLI |

---

## 本地试跑（如果你想自己玩玩）

### 准备

只需要 Python 3.10+ 和 git。

```bash
git clone https://github.com/<你的用户名>/<这个仓库>.git
cd Claude-First-Project
pip install -r requirements.txt
```

### 跑一次抓取

```bash
python3 src/main.py
```

第一次跑会下载 100MB 的翻译模型（约 1-2 分钟），之后每次只要 30-60 秒。

跑完后看 `output/2026-XX-XX.md`，就是当天的新闻日报。

> ⚠️ **如果你在中国大陆**：BBC、VOA、半岛电视台是被屏蔽的，本机直连抓不到。要么开代理：
> ```bash
> export HTTPS_PROXY=http://127.0.0.1:7890   # 改成你代理端口
> python3 src/main.py
> ```
> 要么直接让 GitHub Actions 跑（GitHub 服务器在境外，无墙）。

### 定时模式（本地常驻）

```bash
python3 src/main.py -cron
```

会一直挂在前台，每天 8:00（北京时间）自动跑一次。`Ctrl+C` 停止。

> 实际上**推荐用 GitHub Actions 而不是这个**——电脑关了就没了。

---

## 部署到 Cloudflare（如果想做自己的版本）

### 1. 准备好 Cloudflare 账号

- 注册 cloudflare.com 免费账号
- 把你的域名加进 Cloudflare（改 nameservers，等状态变 Active）

### 2. 改 `wrangler.toml`

把里面的 `ainews.fntymc.com` 改成你自己的子域名，把 `database_id` 换成你自己的（用 `wrangler d1 create xxx` 生成）。

### 3. 安装并登录 wrangler

```bash
npm install -g wrangler
wrangler login
```

### 4. 建数据库表

```bash
wrangler d1 migrations apply ai-news-db
```

### 5. 推到 GitHub，Cloudflare 自动部署

仓库里 `wrangler.toml` 配好后，**推到 GitHub 就会触发 Cloudflare Workers 自动部署**——不需要本地跑 `wrangler deploy`。

### 6. 启用 GitHub Actions 自动抓取

仓库 → Settings → Actions → General → 把 "Workflow permissions" 改成 **Read and write** 即可。之后每天 23:00 UTC（次日 7:00 北京）自动跑。

---

## 可能遇到的问题

<details>
<summary><b>Q：我跑 <code>python src/main.py</code>，抓到的新闻很少 / 报错</b></summary>

国内网络墙了 BBC / VOA / 半岛电视台。开代理（`HTTPS_PROXY` 环境变量）或者直接让 GitHub Actions 跑。
</details>

<details>
<summary><b>Q：网页打开是空白 / "没有匹配的新闻"</b></summary>

99% 是浏览器把你登录用户名 autofill 进了搜索框。把搜索框清空就行。如果还不行，看浏览器控制台报什么错。
</details>

<details>
<summary><b>Q：Cloudflare 部署报错 "Can't infer zone from route"</b></summary>

`wrangler.toml` 里 `[[routes]]` 缺 `zone_name`。补上你的主域名，比如：

```toml
[[routes]]
pattern = "ainews.example.com"
zone_name = "example.com"
custom_domain = true
```
</details>

<details>
<summary><b>Q：所有文章都是同一张图</b></summary>

那个 source 没给每篇文章配图，全部回退到了网站默认 logo。代码里 `strip_duplicate_images` 已经处理这种情况——同一 source 出现 3 次以上的图会被自动清空。
</details>

<details>
<summary><b>Q：我想加一个新的新闻源</b></summary>

`src/main.py` 顶部 `FEEDS` 列表里加一行：

```python
{"name": "你的新闻源名字", "url": "https://example.com/rss"},
```

推到 GitHub，下一次 cron 自动会抓。
</details>

---

## 谁适合用这个项目

- **想看新闻又懒得跑十个网站的人** —— 一个站点就能浏览所有源
- **学习者** —— 这套架构涵盖了爬虫、翻译、定时任务、Worker、数据库、CI/CD，是一个完整的小型全栈项目
- **想做类似聚合站的人** —— 直接 fork 改 FEEDS 就能用

---

## License

MIT。随便用。
