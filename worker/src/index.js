// Cloudflare Worker: News Hub with auth + D1 + static asset data
const BUILD = "v6";
// Routes:
//   GET  /                 hub page (auth required) or redirect to /login
//   GET  /login            login page
//   GET  /register         register page
//   POST /api/register     create user
//   POST /api/login        issue session
//   POST /api/logout       revoke session
//   GET  /api/dates        list available digest dates (auth)
//   GET  /api/news?date=X  one day's articles (auth)
//   GET  /api/me           current user (auth)

const SESSION_COOKIE = "hub_session";
const SESSION_TTL_SEC = 60 * 60 * 24 * 30; // 30 days
const PASSWORD_PBKDF2_ITERATIONS = 25000;

// ─── Entry ───────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/")                   return handleHome(request, env);
      if (path === "/login")              return htmlResponse(loginPage());
      if (path === "/register")           return htmlResponse(registerPage());
      if (path === "/api/register" && request.method === "POST") return handleRegister(request, env);
      if (path === "/api/login"    && request.method === "POST") return handleLogin(request, env);
      if (path === "/api/logout"   && request.method === "POST") return handleLogout(request, env);
      if (path === "/api/change-password" && request.method === "POST") return handleChangePassword(request, env);
      if (path === "/api/me")             return handleMe(request, env);
      if (path === "/api/dates")          return handleDates(request, env);
      if (path === "/api/news")           return handleNews(request, env, url);
      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error(err);
      return new Response("Server error: " + err.message, { status: 500 });
    }
  },
};

// ─── Route handlers ──────────────────────────────────────────────────────────
async function handleHome(request, env) {
  const user = await currentUser(request, env);
  if (!user) return Response.redirect(new URL("/login", request.url).toString(), 302);
  return htmlResponse(hubPage(user));
}

async function handleRegister(request, env) {
  const { username, password } = await readJson(request);
  if (!username || !password) return jsonErr(400, "用户名和密码不能为空");
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return jsonErr(400, "用户名 3-20 位，仅允许字母数字下划线");
  if (password.length < 6) return jsonErr(400, "密码至少 6 位");

  const existing = await env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(username).first();
  if (existing) return jsonErr(409, "用户名已被占用");

  const hash = await hashPassword(password);
  const now = Math.floor(Date.now() / 1000);
  const res = await env.DB.prepare("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)")
    .bind(username, hash, now).run();
  const userId = res.meta.last_row_id;

  const token = await createSession(env, userId);
  return new Response(JSON.stringify({ ok: true, username }), {
    status: 200,
    headers: { "content-type": "application/json", "set-cookie": buildCookie(token) },
  });
}

async function handleLogin(request, env) {
  const { username, password } = await readJson(request);
  if (!username || !password) return jsonErr(400, "用户名和密码不能为空");

  const user = await env.DB.prepare("SELECT id, username, password_hash FROM users WHERE username = ?")
    .bind(username).first();
  if (!user) return jsonErr(401, "用户名或密码错误");

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return jsonErr(401, "用户名或密码错误");

  const token = await createSession(env, user.id);
  return new Response(JSON.stringify({ ok: true, username: user.username }), {
    status: 200,
    headers: { "content-type": "application/json", "set-cookie": buildCookie(token) },
  });
}

async function handleLogout(request, env) {
  const token = getSessionToken(request);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json", "set-cookie": buildCookie("", 0) },
  });
}

async function handleMe(request, env) {
  const user = await currentUser(request, env);
  if (!user) return jsonErr(401, "未登录");
  return Response.json({ username: user.username });
}

async function handleChangePassword(request, env) {
  const user = await currentUser(request, env);
  if (!user) return jsonErr(401, "未登录");

  const { current_password, new_password } = await readJson(request);
  if (!current_password || !new_password) return jsonErr(400, "请填写当前密码和新密码");
  if (new_password.length < 6) return jsonErr(400, "新密码至少 6 位");
  if (current_password === new_password) return jsonErr(400, "新密码不能与当前密码相同");

  const row = await env.DB.prepare("SELECT password_hash FROM users WHERE id = ?")
    .bind(user.id).first();
  if (!row) return jsonErr(404, "用户不存在");

  const ok = await verifyPassword(current_password, row.password_hash);
  if (!ok) return jsonErr(401, "当前密码不正确");

  const newHash = await hashPassword(new_password);
  await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
    .bind(newHash, user.id).run();

  // Revoke all other sessions for safety; keep the current one.
  const currentToken = getSessionToken(request);
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND token != ?")
    .bind(user.id, currentToken).run();

  return Response.json({ ok: true });
}

async function handleDates(request, env) {
  const user = await currentUser(request, env);
  if (!user) return jsonErr(401, "未登录");

  // Load a generated manifest from ASSETS; if absent, scan via a fallback list.
  const manifest = await fetchAsset(env, "/manifest.json");
  if (manifest) return new Response(manifest, { headers: { "content-type": "application/json" } });
  return Response.json({ dates: [] });
}

async function handleNews(request, env, url) {
  const user = await currentUser(request, env);
  if (!user) return jsonErr(401, "未登录");

  const date = url.searchParams.get("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return jsonErr(400, "日期无效");

  const data = await fetchAsset(env, `/${date}.json`);
  if (!data) return jsonErr(404, "当日无数据");
  return new Response(data, { headers: { "content-type": "application/json" } });
}

// ─── Auth helpers ────────────────────────────────────────────────────────────
async function currentUser(request, env) {
  const token = getSessionToken(request);
  if (!token) return null;
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    "SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?"
  ).bind(token, now).first();
  return row || null;
}

function getSessionToken(request) {
  const cookie = request.headers.get("cookie") || "";
  for (const part of cookie.split(/;\s*/)) {
    const [k, v] = part.split("=");
    if (k === SESSION_COOKIE) return v;
  }
  return null;
}

function buildCookie(value, maxAge = SESSION_TTL_SEC) {
  const attrs = [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  return attrs.join("; ");
}

async function createSession(env, userId) {
  const token = randomToken();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
  ).bind(token, userId, now + SESSION_TTL_SEC, now).run();
  return token;
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password, saltBytes) {
  const salt = saltBytes || crypto.getRandomValues(new Uint8Array(16));
  const km = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), { name: "PBKDF2" }, false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PASSWORD_PBKDF2_ITERATIONS, hash: "SHA-256" }, km, 256
  );
  const hashB64 = b64encode(new Uint8Array(bits));
  const saltB64 = b64encode(salt);
  return `pbkdf2$${PASSWORD_PBKDF2_ITERATIONS}$${saltB64}$${hashB64}`;
}

async function verifyPassword(password, stored) {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iters = parseInt(parts[1], 10);
  const salt = b64decode(parts[2]);
  const km = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), { name: "PBKDF2" }, false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: iters, hash: "SHA-256" }, km, 256
  );
  return constantTimeEq(b64encode(new Uint8Array(bits)), parts[3]);
}

function constantTimeEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function b64encode(bytes) { return btoa(String.fromCharCode(...bytes)); }
function b64decode(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ─── Misc helpers ────────────────────────────────────────────────────────────
async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}
function jsonErr(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status, headers: { "content-type": "application/json" },
  });
}
function htmlResponse(html) {
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
async function fetchAsset(env, path) {
  // Use the ASSETS binding to read files from the static output/ directory.
  const url = "https://assets.local" + path;
  const resp = await env.ASSETS.fetch(url);
  if (!resp.ok) return null;
  return await resp.text();
}

// ─── View templates (Bloomberg-style) ────────────────────────────────────────
function layout(title, body, extraHead = "") {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${FAVICON}">
<style>${BASE_CSS}</style>
${extraHead}
</head>
<body>${body}</body>
</html>`;
}

// Inline SVG favicon: dark rounded square + amber diamond. Single quotes
// inside the SVG so the whole thing fits in an HTML href attribute, and
// `#` chars are %23-escaped because data: URIs treat `#` as a fragment.
const FAVICON =
  "%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2032%2032'%3E" +
  "%3Crect%20width='32'%20height='32'%20rx='7'%20fill='%230a0a0a'/%3E" +
  "%3Crect%20x='0.75'%20y='0.75'%20width='30.5'%20height='30.5'%20rx='6.25'%20fill='none'%20stroke='%23ff9f0a'%20stroke-width='1.5'/%3E" +
  "%3Cpath%20d='M16%207L25%2016L16%2025L7%2016Z'%20fill='%23ff9f0a'/%3E" +
  "%3Cpath%20d='M16%2012L20%2016L16%2020L12%2016Z'%20fill='%230a0a0a'/%3E" +
  "%3C/svg%3E";

const BASE_CSS = `
  :root {
    --bg: #050505;
    --bg-1: #0c0c0c;
    --bg-2: #141414;
    --line: #1f1f1f;
    --line-2: #2a2a2a;
    --text: #e8e8e8;
    --dim: #8a8a8a;
    --dim-2: #5a5a5a;
    --amber: #ff9f0a;
    --amber-2: #ffb73d;
    --green: #3cde7c;
    --red: #ff5555;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Inter", "PingFang SC", "Helvetica Neue", Arial, sans-serif;
    font-size: 14px; line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  a { color: var(--text); text-decoration: none; }
  a:hover { color: var(--amber); }
  button { font-family: inherit; cursor: pointer; }
  .mono { font-family: var(--mono); }
  .amber { color: var(--amber); }
  .dim { color: var(--dim); }
  mark { background: rgba(255,159,10,0.25); color: var(--amber-2); padding: 0 2px; }
`;

// ─── Login page ──────────────────────────────────────────────────────────────
function loginPage() {
  return layout("NEWS HUB · LOGIN", `
  <style>
    .auth-wrap { min-height: 100vh; display: grid; place-items: center; padding: 20px; }
    .auth-card { width: 100%; max-width: 380px; background: var(--bg-1); border: 1px solid var(--line); padding: 32px; }
    .brand { font-family: var(--mono); color: var(--amber); letter-spacing: 2px; font-size: 12px; margin-bottom: 24px; }
    .brand b { font-size: 20px; letter-spacing: 4px; display: block; color: var(--text); margin-top: 4px; }
    h1 { font-size: 22px; margin: 0 0 4px; font-weight: 700; }
    .sub { color: var(--dim); font-size: 13px; margin-bottom: 24px; }
    label { display: block; color: var(--dim); font-size: 11px; font-family: var(--mono); letter-spacing: 1px; margin-bottom: 6px; text-transform: uppercase; }
    input {
      width: 100%; background: var(--bg); color: var(--text);
      border: 1px solid var(--line-2); padding: 10px 12px;
      font-family: inherit; font-size: 14px; outline: none; margin-bottom: 16px;
    }
    input:focus { border-color: var(--amber); }
    button.primary {
      width: 100%; background: var(--amber); color: #000;
      border: none; padding: 11px; font-weight: 700; font-size: 14px;
      letter-spacing: 1px; margin-top: 8px;
    }
    button.primary:hover { background: var(--amber-2); }
    .alt { text-align: center; margin-top: 18px; color: var(--dim); font-size: 13px; }
    .err { color: var(--red); font-size: 13px; min-height: 18px; margin-bottom: 6px; }
    .ticker {
      font-family: var(--mono); font-size: 10px; color: var(--dim-2);
      letter-spacing: 1px; margin-top: 22px; border-top: 1px solid var(--line); padding-top: 14px;
      display: flex; justify-content: space-between;
    }
  </style>
  <div class="auth-wrap">
    <div class="auth-card">
      <div class="brand">TERMINAL ${BUILD}<b>NEWS HUB</b></div>
      <h1>登录</h1>
      <div class="sub">访问每日新闻聚合终端</div>
      <div class="err" id="err"></div>
      <form id="f">
        <label>用户名</label>
        <input name="username" autocomplete="username" required>
        <label>密码</label>
        <input name="password" type="password" autocomplete="current-password" required>
        <button class="primary" type="submit">进入终端</button>
      </form>
      <div class="alt">还没有账号？<a href="/register" class="amber">注册</a></div>
      <div class="ticker"><span>SECURE CONNECTION</span><span id="clock"></span></div>
    </div>
  </div>
  <script>
    const clock = () => document.getElementById('clock').textContent = new Date().toISOString().slice(0,19).replace('T',' ') + ' UTC';
    clock(); setInterval(clock, 1000);
    document.getElementById('f').addEventListener('submit', async e => {
      e.preventDefault();
      const errEl = document.getElementById('err');
      errEl.textContent = '';
      const fd = new FormData(e.target);
      try {
        const res = await fetch('/api/login', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(Object.fromEntries(fd))
        });
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch {}
        if (res.ok) { location.href = '/'; return; }
        errEl.textContent = (data && data.error) ? data.error : ('['+res.status+'] '+text.slice(0,160));
      } catch (err) {
        errEl.textContent = '网络错误：' + err.message;
      }
    });
  </script>`);
}

// ─── Register page ───────────────────────────────────────────────────────────
function registerPage() {
  return layout("NEWS HUB · REGISTER", `
  <style>
    .auth-wrap { min-height: 100vh; display: grid; place-items: center; padding: 20px; }
    .auth-card { width: 100%; max-width: 380px; background: var(--bg-1); border: 1px solid var(--line); padding: 32px; }
    .brand { font-family: var(--mono); color: var(--amber); letter-spacing: 2px; font-size: 12px; margin-bottom: 24px; }
    .brand b { font-size: 20px; letter-spacing: 4px; display: block; color: var(--text); margin-top: 4px; }
    h1 { font-size: 22px; margin: 0 0 4px; }
    .sub { color: var(--dim); font-size: 13px; margin-bottom: 24px; }
    label { display: block; color: var(--dim); font-size: 11px; font-family: var(--mono); letter-spacing: 1px; margin-bottom: 6px; text-transform: uppercase; }
    input {
      width: 100%; background: var(--bg); color: var(--text);
      border: 1px solid var(--line-2); padding: 10px 12px;
      font-family: inherit; font-size: 14px; outline: none; margin-bottom: 16px;
    }
    input:focus { border-color: var(--amber); }
    button.primary {
      width: 100%; background: var(--amber); color: #000;
      border: none; padding: 11px; font-weight: 700; font-size: 14px;
      letter-spacing: 1px; margin-top: 8px;
    }
    button.primary:hover { background: var(--amber-2); }
    .alt { text-align: center; margin-top: 18px; color: var(--dim); font-size: 13px; }
    .err { color: var(--red); font-size: 13px; min-height: 18px; margin-bottom: 6px; }
    .hint { font-size: 11px; color: var(--dim-2); margin-top: -10px; margin-bottom: 14px; font-family: var(--mono); }
  </style>
  <div class="auth-wrap">
    <div class="auth-card">
      <div class="brand">TERMINAL ${BUILD}<b>NEWS HUB</b></div>
      <h1>注册</h1>
      <div class="sub">创建一个账号即可访问</div>
      <div class="err" id="err"></div>
      <form id="f">
        <label>用户名</label>
        <input name="username" autocomplete="username" required pattern="[a-zA-Z0-9_]{3,20}">
        <div class="hint">3-20 位，字母/数字/下划线</div>
        <label>密码</label>
        <input name="password" type="password" autocomplete="new-password" required minlength="6">
        <div class="hint">至少 6 位</div>
        <button class="primary" type="submit" id="submitBtn">创建账号</button>
      </form>
      <div class="alt">已有账号？<a href="/login" class="amber">登录</a></div>
    </div>
  </div>
  <script>
    const form = document.getElementById('f');
    const errEl = document.getElementById('err');
    const btn = document.getElementById('submitBtn');
    form.addEventListener('submit', async e => {
      e.preventDefault();
      errEl.textContent = '';
      btn.disabled = true; btn.textContent = '提交中...';
      const fd = new FormData(e.target);
      try {
        const res = await fetch('/api/register', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(Object.fromEntries(fd))
        });
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch {}
        if (res.ok) { location.href = '/'; return; }
        errEl.textContent = (data && data.error) ? data.error : ('['+res.status+'] '+(text||'empty body').slice(0,160));
      } catch (err) {
        errEl.textContent = '网络错误：' + err.message;
      } finally {
        btn.disabled = false; btn.textContent = '创建账号';
      }
    });
  </script>`);
}

// ─── Hub page ────────────────────────────────────────────────────────────────
function hubPage(user) {
  return layout("NEWS HUB", `
    <header class="hub-top">
      <div class="hub-top-inner">
        <div class="hub-brand">
          <span class="hub-brand-mark">◆</span>
          <span class="hub-brand-name">NEWS&nbsp;HUB</span>
          <span class="hub-brand-ver mono">${BUILD}</span>
        </div>
        <nav class="hub-nav">
          <a href="#all" data-src="" id="allNav">全部</a>
          <span class="hub-nav-dyn" id="srcNav"></span>
        </nav>
        <div class="hub-user">
          <span class="hub-user-name">👤 ${escapeHtml(user.username)}</span>
          <button class="hub-btn-ghost" id="btnChangePw">改密码</button>
          <button class="hub-btn-ghost" id="btnLogout">退出</button>
        </div>
      </div>
      <div class="hub-subbar">
        <select id="dateSel" class="hub-select"></select>
        <input id="search" class="hub-input" placeholder="搜索标题 / 摘要…"
               type="search" name="news-query" autocomplete="off"
               autocorrect="off" autocapitalize="off" spellcheck="false">
        <select id="sortSel" class="hub-select">
          <option value="newest">最新优先</option>
          <option value="oldest">最早优先</option>
        </select>
        <span id="countInfo" class="hub-count mono dim"></span>
      </div>
    </header>

    <main class="hub-main">
      <section class="hub-hero" id="hero"></section>
      <section class="hub-layout">
        <div class="hub-grid" id="grid"></div>
        <aside class="hub-aside">
          <div class="hub-aside-title">最新动态</div>
          <ol class="hub-ticker" id="ticker"></ol>
        </aside>
      </section>
      <div class="hub-empty" id="emptyMsg" hidden>没有匹配的新闻。</div>
    </main>

    <div id="pwModal" class="modal" hidden>
      <div class="modal-card">
        <div class="modal-title">修改密码</div>
        <label>当前密码<input id="pwOld" type="password" autocomplete="current-password"></label>
        <label>新密码（≥6 位）<input id="pwNew" type="password" autocomplete="new-password"></label>
        <label>确认新密码<input id="pwNew2" type="password" autocomplete="new-password"></label>
        <div class="modal-err" id="pwErr"></div>
        <div class="modal-actions">
          <button class="hub-btn-ghost" id="pwCancel">取消</button>
          <button class="hub-btn-primary" id="pwSubmit">确认</button>
        </div>
      </div>
    </div>

    <style>
      .hub-top {
        position: sticky; top: 0; z-index: 10;
        background: rgba(5,5,5,0.92);
        backdrop-filter: blur(8px);
        border-bottom: 1px solid var(--line);
      }
      .hub-top-inner {
        display: flex; align-items: center; gap: 24px;
        padding: 12px 24px;
        max-width: 1400px; margin: 0 auto;
      }
      .hub-brand { display: flex; align-items: center; gap: 8px; }
      .hub-brand-mark { color: var(--amber); font-size: 14px; }
      .hub-brand-name { font-weight: 700; letter-spacing: 1px; font-size: 15px; }
      .hub-brand-ver { color: var(--dim-2); font-size: 11px; }
      .hub-nav {
        flex: 1; display: flex; gap: 4px; overflow-x: auto;
        scrollbar-width: none;
      }
      .hub-nav::-webkit-scrollbar { display: none; }
      .hub-nav a, .hub-nav button {
        padding: 6px 12px; border-radius: 999px;
        font-size: 12px; color: var(--dim);
        border: 1px solid transparent;
        background: transparent; white-space: nowrap;
      }
      .hub-nav a:hover, .hub-nav button:hover {
        color: var(--text); border-color: var(--line-2);
      }
      .hub-nav a.active, .hub-nav button.active {
        color: var(--amber); border-color: var(--amber);
      }
      .hub-user { display: flex; align-items: center; gap: 10px; }
      .hub-user-name { color: var(--dim); font-size: 12px; }
      .hub-btn-ghost {
        background: transparent; color: var(--text);
        border: 1px solid var(--line-2); border-radius: 4px;
        padding: 5px 10px; font-size: 12px;
      }
      .hub-btn-ghost:hover { border-color: var(--amber); color: var(--amber); }
      .hub-btn-primary {
        background: var(--amber); color: #000; border: 0;
        border-radius: 4px; padding: 6px 14px; font-weight: 600; font-size: 12px;
      }
      .hub-btn-primary:hover { background: var(--amber-2); }

      .hub-subbar {
        display: flex; align-items: center; gap: 12px;
        padding: 10px 24px;
        max-width: 1400px; margin: 0 auto;
        border-top: 1px solid var(--line);
      }
      .hub-select, .hub-input {
        background: var(--bg-1); color: var(--text);
        border: 1px solid var(--line-2); border-radius: 4px;
        padding: 6px 10px; font-size: 12px; font-family: inherit;
      }
      .hub-input { flex: 1; min-width: 160px; }
      .hub-select:focus, .hub-input:focus {
        outline: none; border-color: var(--amber);
      }
      .hub-count { font-size: 11px; white-space: nowrap; }

      .hub-main {
        max-width: 1400px; margin: 0 auto;
        padding: 24px;
      }
      .hub-hero {
        display: grid; grid-template-columns: 2fr 1fr; gap: 16px;
        margin-bottom: 32px;
      }
      @media (max-width: 900px) {
        .hub-hero { grid-template-columns: 1fr; }
      }
      .hero-main, .hero-side {
        display: block; position: relative; overflow: hidden;
        border: 1px solid var(--line); background: var(--bg-1);
        transition: border-color .15s;
      }
      .hero-main:hover, .hero-side:hover { border-color: var(--amber); }
      .hero-main {
        aspect-ratio: 16/9;
      }
      .hero-main .img, .hero-side .img {
        position: absolute; inset: 0;
        background-size: cover; background-position: center;
        transition: transform .4s;
      }
      .hero-main:hover .img, .hero-side:hover .img { transform: scale(1.03); }
      .hero-main .img::after, .hero-side .img::after {
        content: ""; position: absolute; inset: 0;
        background: linear-gradient(to top, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.3) 60%, transparent 100%);
      }
      .hero-main .no-img, .hero-side .no-img {
        position: absolute; inset: 0;
        background: linear-gradient(135deg, #1a1a1a, #0a0a0a);
        display: flex; align-items: center; justify-content: center;
        color: var(--dim-2); font-size: 48px;
      }
      .hero-main .meta, .hero-side .meta {
        position: absolute; left: 0; right: 0; bottom: 0;
        padding: 20px; z-index: 1;
      }
      .hero-side .meta { padding: 14px; }
      .hero-tag {
        display: inline-block; background: var(--amber); color: #000;
        font-size: 10px; font-weight: 700; letter-spacing: 1px;
        padding: 2px 8px; margin-bottom: 8px;
      }
      .hero-main h2 {
        font-size: 24px; margin: 0 0 6px; line-height: 1.25;
        font-weight: 700;
      }
      .hero-side h3 {
        font-size: 15px; margin: 0 0 4px; line-height: 1.3;
        font-weight: 600;
      }
      .hero-main .sub { color: #d0d0d0; font-size: 13px; margin: 0 0 6px; }
      .hero-main .time, .hero-side .time {
        color: var(--dim); font-size: 11px;
      }
      .hero-aside-stack {
        display: flex; flex-direction: column; gap: 16px;
      }
      .hero-side { aspect-ratio: 16/10; }

      .hub-layout {
        display: grid; grid-template-columns: 1fr 320px; gap: 32px;
      }
      @media (max-width: 1000px) {
        .hub-layout { grid-template-columns: 1fr; }
        .hub-aside { order: -1; }
      }
      .hub-grid {
        display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: 20px;
      }
      .card {
        display: block; border: 1px solid var(--line);
        background: var(--bg-1);
        transition: border-color .15s, transform .15s;
      }
      .card:hover { border-color: var(--amber); transform: translateY(-2px); }
      .card-img {
        aspect-ratio: 16/9;
        background-size: cover; background-position: center;
        background-color: #0a0a0a;
        border-bottom: 1px solid var(--line);
        position: relative;
      }
      .card-img.no-img {
        background: linear-gradient(135deg, #1a1a1a, #0a0a0a);
        display: flex; align-items: center; justify-content: center;
        color: var(--dim-2); font-size: 32px;
      }
      .card-body { padding: 14px 16px 16px; }
      .card-src {
        display: inline-block; font-size: 10px; letter-spacing: 1px;
        color: var(--amber); font-weight: 600; margin-bottom: 6px;
      }
      .card-title {
        font-size: 15px; font-weight: 600; line-height: 1.35;
        margin: 0 0 6px; color: var(--text);
      }
      .card-sum {
        font-size: 12px; color: var(--dim); line-height: 1.5;
        margin: 0 0 8px;
        display: -webkit-box; -webkit-line-clamp: 2;
        -webkit-box-orient: vertical; overflow: hidden;
      }
      .card-time { font-size: 11px; color: var(--dim-2); }

      .hub-aside {
        border-left: 1px solid var(--line);
        padding-left: 24px;
      }
      @media (max-width: 1000px) {
        .hub-aside { border-left: 0; padding-left: 0;
          border-top: 1px solid var(--line); padding-top: 16px; }
      }
      .hub-aside-title {
        font-size: 11px; letter-spacing: 2px; color: var(--amber);
        font-weight: 700; margin-bottom: 14px;
        padding-bottom: 8px; border-bottom: 1px solid var(--line);
      }
      .hub-ticker { list-style: none; margin: 0; padding: 0; }
      .hub-ticker li {
        padding: 10px 0; border-bottom: 1px solid var(--line);
        display: flex; gap: 10px; align-items: flex-start;
      }
      .hub-ticker li:last-child { border-bottom: 0; }
      .hub-ticker .num {
        color: var(--amber); font-family: var(--mono);
        font-size: 11px; font-weight: 700;
        min-width: 20px;
      }
      .hub-ticker .t-body { flex: 1; min-width: 0; }
      .hub-ticker .t-title {
        font-size: 13px; line-height: 1.35; font-weight: 500;
        margin-bottom: 3px;
        display: -webkit-box; -webkit-line-clamp: 2;
        -webkit-box-orient: vertical; overflow: hidden;
      }
      .hub-ticker .t-meta {
        font-size: 10px; color: var(--dim-2);
      }
      .hub-ticker a { color: var(--text); }
      .hub-ticker a:hover .t-title { color: var(--amber); }

      .hub-empty {
        text-align: center; padding: 60px; color: var(--dim);
        border: 1px dashed var(--line-2);
      }

      .modal {
        position: fixed; inset: 0; background: rgba(0,0,0,0.8);
        display: flex; align-items: center; justify-content: center;
        z-index: 100;
      }
      .modal[hidden] { display: none; }
      .modal-card {
        background: var(--bg-1); border: 1px solid var(--line-2);
        padding: 24px; width: 360px; max-width: 90vw;
      }
      .modal-title {
        font-size: 16px; font-weight: 700; margin-bottom: 16px;
        color: var(--amber);
      }
      .modal-card label {
        display: block; font-size: 12px; color: var(--dim);
        margin-bottom: 12px;
      }
      .modal-card input {
        display: block; width: 100%; margin-top: 4px;
        background: var(--bg-2); color: var(--text);
        border: 1px solid var(--line-2); border-radius: 3px;
        padding: 8px 10px; font-size: 13px; font-family: inherit;
      }
      .modal-card input:focus { outline: none; border-color: var(--amber); }
      .modal-err { color: var(--red); font-size: 12px; min-height: 16px; margin: 4px 0 8px; }
      .modal-actions {
        display: flex; gap: 8px; justify-content: flex-end;
      }

      mark { background: rgba(255,159,10,0.25); color: var(--amber-2); padding: 0 2px; }
    </style>

    <script>
      const grid = document.getElementById('grid');
      const hero = document.getElementById('hero');
      const ticker = document.getElementById('ticker');
      const allNav = document.getElementById('allNav');
      const srcNav = document.getElementById('srcNav');
      const dateSel = document.getElementById('dateSel');
      const sortSel = document.getElementById('sortSel');
      const search = document.getElementById('search');
      const countInfo = document.getElementById('countInfo');
      const emptyMsg = document.getElementById('emptyMsg');

      // Defeat Chrome/Safari autofill: they ignore autocomplete=off and stuff
      // the saved username into any text input on this domain. Clear the
      // search box immediately and again after the autofill pass (~50–200ms).
      search.value = '';
      setTimeout(() => { search.value = ''; }, 50);
      setTimeout(() => { search.value = ''; }, 250);
      setTimeout(() => { search.value = ''; }, 600);

      let state = { articles: [], source: '', q: '', sort: 'newest' };

      async function loadDates() {
        try {
          const r = await fetch('/api/dates');
          const { dates } = await r.json();
          if (!dates || !dates.length) {
            dateSel.innerHTML = '<option>暂无数据</option>';
            return;
          }
          dateSel.innerHTML = dates.map(d =>
            '<option value="'+d.date+'">'+d.date+' · '+d.count+' 篇</option>'
          ).join('');
          dateSel.onchange = () => loadDate(dateSel.value);
          loadDate(dates[0].date);
        } catch (e) {
          dateSel.innerHTML = '<option>加载失败</option>';
        }
      }

      async function loadDate(date) {
        try {
          const r = await fetch('/api/news?date='+encodeURIComponent(date));
          const data = await r.json();
          state.articles = data.articles || [];
          buildSourceNav();
          render();
        } catch (e) {
          state.articles = []; render();
        }
      }

      function buildSourceNav() {
        const sources = Array.from(new Set(state.articles.map(a => a.source))).sort();
        if (state.source && !sources.includes(state.source)) state.source = '';
        srcNav.innerHTML = sources.map(s =>
          '<button data-src="'+escAttr(s)+'">'+escHtml(s)+'</button>'
        ).join('');
        srcNav.querySelectorAll('button').forEach(b => {
          b.onclick = () => {
            state.source = b.dataset.src === state.source ? '' : b.dataset.src;
            render();
          };
        });
      }

      function render() {
        const q = state.q.trim().toLowerCase();
        let list = state.articles.filter(a => {
          if (state.source && a.source !== state.source) return false;
          if (q && !(a.title.toLowerCase().includes(q) ||
                     (a.summary||'').toLowerCase().includes(q))) return false;
          return true;
        });
        list.sort((x,y) => state.sort === 'oldest' ? x.timestamp - y.timestamp : y.timestamp - x.timestamp);

        // update source nav active state
        allNav.classList.toggle('active', !state.source);
        srcNav.querySelectorAll('button').forEach(b => {
          b.classList.toggle('active', b.dataset.src === state.source);
        });

        countInfo.textContent = list.length + ' 篇';

        if (!list.length) {
          hero.innerHTML = ''; grid.innerHTML = ''; ticker.innerHTML = '';
          emptyMsg.hidden = false;
          return;
        }
        emptyMsg.hidden = true;

        // Hero: first with image if available, else first
        const heroMain = list.find(a => a.image) || list[0];
        const heroSides = list.filter(a => a !== heroMain).slice(0, 2);
        hero.innerHTML = renderHero(heroMain, heroSides, q);

        // Grid: remaining
        const gridItems = list.filter(a => a !== heroMain && !heroSides.includes(a)).slice(0, 24);
        grid.innerHTML = gridItems.map(a => renderCard(a, q)).join('');

        // Ticker: latest 10 (by time, newest)
        const tickList = [...state.articles]
          .filter(a => !state.source || a.source === state.source)
          .sort((x,y) => y.timestamp - x.timestamp)
          .slice(0, 10);
        ticker.innerHTML = tickList.map((a, i) =>
          '<li><span class="num">'+String(i+1).padStart(2,'0')+'</span>'+
          '<div class="t-body"><a href="'+escAttr(a.link)+'" target="_blank" rel="noopener">'+
          '<div class="t-title">'+hl(escHtml(a.title), q)+'</div>'+
          '<div class="t-meta">'+escHtml(a.source)+' · '+escHtml(a.published_at)+'</div>'+
          '</a></div></li>'
        ).join('');
      }

      function renderHero(main, sides, q) {
        return (
          '<a class="hero-main" href="'+escAttr(main.link)+'" target="_blank" rel="noopener">'+
            imgBg(main.image, 'img', '头条', main) +
            '<div class="meta">'+
              '<span class="hero-tag">'+escHtml(main.source)+'</span>'+
              '<h2>'+hl(escHtml(main.title), q)+'</h2>'+
              (main.summary ? '<p class="sub">'+hl(escHtml(main.summary), q)+'</p>' : '') +
              '<div class="time mono">'+escHtml(main.published_at)+'</div>'+
            '</div>'+
          '</a>'+
          '<div class="hero-aside-stack">'+
            sides.map(s =>
              '<a class="hero-side" href="'+escAttr(s.link)+'" target="_blank" rel="noopener">'+
                imgBg(s.image, 'img', '', s) +
                '<div class="meta">'+
                  '<span class="hero-tag">'+escHtml(s.source)+'</span>'+
                  '<h3>'+hl(escHtml(s.title), q)+'</h3>'+
                  '<div class="time mono">'+escHtml(s.published_at)+'</div>'+
                '</div>'+
              '</a>'
            ).join('')+
          '</div>'
        );
      }

      function renderCard(a, q) {
        const img = a.image || genCover(a);
        return (
          '<a class="card" href="'+escAttr(a.link)+'" target="_blank" rel="noopener">'+
            '<div class="card-img" style="background-image:url(\\''+escAttr(img)+'\\')"></div>'+
            '<div class="card-body">'+
              '<div class="card-src">'+escHtml(a.source)+'</div>'+
              '<div class="card-title">'+hl(escHtml(a.title), q)+'</div>'+
              (a.summary ? '<div class="card-sum">'+hl(escHtml(a.summary), q)+'</div>' : '') +
              '<div class="card-time mono">'+escHtml(a.published_at)+'</div>'+
            '</div>'+
          '</a>'
        );
      }

      function imgBg(url, cls, placeholder, article) {
        const finalUrl = url || (article ? genCover(article) : '');
        if (finalUrl) return '<div class="'+cls+'" style="background-image:url(\\''+escAttr(finalUrl)+'\\')"></div>';
        return '<div class="no-img">◆</div>';
      }

      // Build a unique procedural cover for an article that lacks one.
      // Deterministic: same article always gets the same look. The hue,
      // glyph and accent colour are derived from a hash of the link, so a
      // grid of generated covers feels varied rather than templated.
      function genCover(a) {
        const seed = hash32((a && a.link) || (a && a.title) || '');
        const hue1   = seed % 360;
        const hue2   = (hue1 + 28) % 360;
        const glyphs = ['◆','▲','●','◼','◐','◇','■','▼'];
        const glyph  = glyphs[(seed >>> 7) % glyphs.length];
        const src    = String((a && a.source) || '').slice(0, 14);
        const title  = String((a && a.title)  || '').slice(0, 32);
        const svg =
          "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 480 300' preserveAspectRatio='xMidYMid slice'>" +
            "<defs>" +
              "<linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>" +
                "<stop offset='0' stop-color='hsl("+hue1+",55%,22%)'/>" +
                "<stop offset='1' stop-color='hsl("+hue2+",65%,7%)'/>" +
              "</linearGradient>" +
            "</defs>" +
            "<rect width='480' height='300' fill='url(%23g)'/>" +
            "<rect x='0' y='0' width='4' height='300' fill='%23ff9f0a'/>" +
            "<text x='340' y='200' font-family=\"ui-monospace,Menlo,monospace\" font-size='220' font-weight='800' fill='hsl("+hue1+",85%,70%)' fill-opacity='0.16' text-anchor='middle' dominant-baseline='middle'>"+glyph+"</text>" +
            "<text x='28' y='44' font-family=\"ui-monospace,Menlo,monospace\" font-size='15' font-weight='700' fill='%23ff9f0a' letter-spacing='2.5'>"+escXml(src.toUpperCase())+"</text>" +
            "<text x='28' y='268' font-family=\"system-ui,'PingFang SC','Microsoft YaHei',sans-serif\" font-size='14' font-weight='500' fill='%23eaeaea' fill-opacity='0.88'>"+escXml(title)+"</text>" +
          "</svg>";
        // encodeURIComponent leaves ' alone, but our SVG uses ' as the
        // attribute delimiter. When the URI ends up inside CSS url('…'),
        // those raw quotes terminate the CSS string early and break the
        // entire stylesheet. Manually escape them.
        return "data:image/svg+xml;utf8," +
               encodeURIComponent(svg).replace(/'/g, "%27");
      }

      // Cheap, stable 32-bit string hash (FNV-1a-ish). Doesn't need to be
      // cryptographic — only used to spread covers across the colour wheel.
      function hash32(s) {
        let h = 2166136261 >>> 0;
        for (let i = 0; i < s.length; i++) {
          h ^= s.charCodeAt(i);
          h = Math.imul(h, 16777619) >>> 0;
        }
        return h;
      }

      function escXml(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));}

      function escHtml(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
      function escAttr(s){return escHtml(s);}
      function hl(html, q){
        if (!q) return html;
        try {
          const re = new RegExp('('+q.replace(/[.*+?^\${}()|[\\]\\\\]/g,'\\\\$&')+')','gi');
          return html.replace(re, '<mark>$1</mark>');
        } catch(e){ return html; }
      }

      sortSel.onchange = () => { state.sort = sortSel.value; render(); };
      search.oninput  = () => { state.q = search.value; render(); };
      allNav.onclick = e => {
        e.preventDefault();
        state.source = '';
        render();
      };

      // Card / hero click → open article. Defensive delegate: works even if
      // some browser config blocks <a target="_blank">. Honors modifier keys
      // (Cmd/Ctrl/middle-click → background tab), default click → new tab.
      document.addEventListener('click', e => {
        const link = e.target.closest('.card, .hero-main, .hero-side, .hub-ticker a');
        if (!link || !link.href) return;
        // Let modifier-key clicks fall through to native browser behaviour.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
        e.preventDefault();
        window.open(link.href, '_blank', 'noopener,noreferrer');
      });

      // logout
      document.getElementById('btnLogout').onclick = async () => {
        await fetch('/api/logout', { method: 'POST' });
        location.href = '/login';
      };

      // change password modal
      const pwModal = document.getElementById('pwModal');
      const pwOld = document.getElementById('pwOld');
      const pwNew = document.getElementById('pwNew');
      const pwNew2 = document.getElementById('pwNew2');
      const pwErr = document.getElementById('pwErr');
      document.getElementById('btnChangePw').onclick = () => {
        pwOld.value = pwNew.value = pwNew2.value = ''; pwErr.textContent = '';
        pwModal.hidden = false; pwOld.focus();
      };
      document.getElementById('pwCancel').onclick = () => { pwModal.hidden = true; };
      document.getElementById('pwSubmit').onclick = async () => {
        pwErr.textContent = '';
        if (pwNew.value.length < 6) { pwErr.textContent = '新密码至少 6 位'; return; }
        if (pwNew.value !== pwNew2.value) { pwErr.textContent = '两次新密码不一致'; return; }
        try {
          const r = await fetch('/api/change-password', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ current_password: pwOld.value, new_password: pwNew.value })
          });
          const data = await r.json();
          if (!r.ok) { pwErr.textContent = data.error || '修改失败'; return; }
          pwModal.hidden = true;
          alert('密码已修改，其他设备已自动下线');
        } catch (e) { pwErr.textContent = '网络错误'; }
      };

      loadDates();
    </script>
  `);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
