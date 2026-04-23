// Cloudflare Worker: News Hub with auth + D1 + static asset data
const BUILD = "v5";
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

// PBKDF2-SHA256 password hashing, 150k iterations
async function hashPassword(password, saltBytes) {
  const salt = saltBytes || crypto.getRandomValues(new Uint8Array(16));
  const km = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), { name: "PBKDF2" }, false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 25000, hash: "SHA-256" }, km, 256
  );
  const hashB64 = b64encode(new Uint8Array(bits));
  const saltB64 = b64encode(salt);
  return `pbkdf2$25000$${saltB64}$${hashB64}`;
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
<style>${BASE_CSS}</style>
${extraHead}
</head>
<body>${body}</body>
</html>`;
}

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
    console.log('[news-hub] register page loaded, build=${BUILD}');
    const form = document.getElementById('f');
    const errEl = document.getElementById('err');
    const btn = document.getElementById('submitBtn');
    form.addEventListener('submit', async e => {
      e.preventDefault();
      console.log('[news-hub] submit fired');
      errEl.textContent = '';
      btn.disabled = true; btn.textContent = '提交中...';
      const fd = new FormData(e.target);
      try {
        const res = await fetch('/api/register', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(Object.fromEntries(fd))
        });
        const text = await res.text();
        console.log('[news-hub] response', res.status, text);
        let data = null;
        try { data = JSON.parse(text); } catch {}
        if (res.ok) { location.href = '/'; return; }
        errEl.textContent = (data && data.error) ? data.error : ('['+res.status+'] '+(text||'empty body').slice(0,160));
      } catch (err) {
        console.error('[news-hub] fetch error', err);
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
  <style>
    .topbar {
      display: flex; align-items: center; gap: 14px;
      background: var(--bg-1); border-bottom: 1px solid var(--line);
      padding: 10px 18px; position: sticky; top: 0; z-index: 10;
    }
    .topbar .logo {
      font-family: var(--mono); letter-spacing: 2px; color: var(--amber);
      font-weight: 700; font-size: 13px;
    }
    .topbar .logo b { color: var(--text); letter-spacing: 3px; }
    .topbar .sep { width: 1px; height: 20px; background: var(--line-2); }
    .topbar select, .topbar input {
      background: var(--bg); color: var(--text); border: 1px solid var(--line-2);
      padding: 6px 10px; font-family: var(--mono); font-size: 12px; outline: none;
    }
    .topbar select:focus, .topbar input:focus { border-color: var(--amber); }
    .topbar .grow { flex: 1; }
    .topbar .clock { font-family: var(--mono); color: var(--dim); font-size: 12px; letter-spacing: 1px; }
    .topbar .user { font-family: var(--mono); font-size: 12px; color: var(--dim); }
    .topbar .user b { color: var(--amber); }
    .topbar button.bar-btn {
      background: transparent; color: var(--dim); border: 1px solid var(--line-2);
      padding: 5px 10px; font-family: var(--mono); font-size: 11px;
    }
    .topbar button.bar-btn:hover { color: var(--amber); border-color: var(--amber); }
    .topbar button.logout:hover { color: var(--red); border-color: var(--red); }

    /* Modal */
    .modal-bg {
      position: fixed; inset: 0; background: rgba(0,0,0,0.7);
      display: none; align-items: center; justify-content: center; z-index: 100;
    }
    .modal-bg.show { display: flex; }
    .modal {
      background: var(--bg-1); border: 1px solid var(--line); padding: 28px;
      width: 360px; max-width: calc(100vw - 32px);
    }
    .modal h2 { margin: 0 0 4px; font-size: 18px; }
    .modal .sub { color: var(--dim); font-size: 12px; margin-bottom: 18px; }
    .modal label { display: block; color: var(--dim); font-size: 11px; font-family: var(--mono); letter-spacing: 1px; margin-bottom: 6px; text-transform: uppercase; }
    .modal input {
      width: 100%; background: var(--bg); color: var(--text);
      border: 1px solid var(--line-2); padding: 9px 11px;
      font-family: inherit; font-size: 14px; outline: none; margin-bottom: 14px;
    }
    .modal input:focus { border-color: var(--amber); }
    .modal .actions { display: flex; gap: 8px; margin-top: 6px; }
    .modal .actions button { flex: 1; padding: 10px; font-family: inherit; font-size: 13px; letter-spacing: 1px; border: none; font-weight: 700; }
    .modal .actions .cancel { background: var(--bg-2); color: var(--dim); border: 1px solid var(--line-2); font-weight: 500; }
    .modal .actions .cancel:hover { color: var(--text); }
    .modal .actions .confirm { background: var(--amber); color: #000; }
    .modal .actions .confirm:hover { background: var(--amber-2); }
    .modal .actions .confirm:disabled { opacity: 0.5; cursor: not-allowed; }
    .modal .msg { min-height: 18px; font-size: 12px; margin-bottom: 6px; }
    .modal .msg.err { color: var(--red); }
    .modal .msg.ok { color: var(--green); }

    .ticker {
      background: var(--bg-1); border-bottom: 1px solid var(--line);
      padding: 6px 18px; font-family: var(--mono); font-size: 11px;
      color: var(--dim); display: flex; gap: 28px; overflow: hidden; white-space: nowrap;
    }
    .ticker b { color: var(--amber); }
    .ticker .sep { color: var(--dim-2); }

    .layout { display: grid; grid-template-columns: 220px 1fr; min-height: calc(100vh - 82px); }
    @media (max-width: 720px) { .layout { grid-template-columns: 1fr; } .rail { display: none; } }

    .rail {
      border-right: 1px solid var(--line); padding: 18px 0; background: var(--bg-1);
    }
    .rail h3 {
      font-family: var(--mono); font-size: 10px; color: var(--dim-2);
      letter-spacing: 2px; margin: 0 18px 10px; text-transform: uppercase;
    }
    .rail .src {
      display: flex; align-items: center; justify-content: space-between;
      padding: 7px 18px; cursor: pointer; border-left: 2px solid transparent;
      font-size: 13px; user-select: none;
    }
    .rail .src:hover { background: var(--bg-2); color: var(--amber); }
    .rail .src.active { background: var(--bg-2); color: var(--amber); border-left-color: var(--amber); }
    .rail .src .cnt { font-family: var(--mono); font-size: 11px; color: var(--dim); }
    .rail .src.active .cnt { color: var(--amber); }
    .rail .divider { height: 1px; background: var(--line); margin: 14px 0; }

    .main { padding: 18px 24px 60px; }
    .stats {
      display: flex; gap: 24px; margin-bottom: 16px; font-family: var(--mono); font-size: 11px;
      color: var(--dim); letter-spacing: 1px; text-transform: uppercase;
    }
    .stats b { color: var(--amber); font-size: 14px; font-weight: 700; }

    .grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); }
    .card {
      background: var(--bg-1); border: 1px solid var(--line);
      padding: 14px 16px 14px; transition: border-color .1s, background .1s;
      display: flex; flex-direction: column; gap: 8px;
    }
    .card:hover { border-color: var(--amber); background: var(--bg-2); }
    .card .meta {
      display: flex; gap: 10px; align-items: center;
      font-family: var(--mono); font-size: 10px; letter-spacing: 1px; color: var(--dim);
      text-transform: uppercase;
    }
    .card .src-tag { color: var(--amber); font-weight: 700; }
    .card h2 { margin: 0; font-size: 15px; line-height: 1.35; font-weight: 600; }
    .card h2 a { color: var(--text); }
    .card h2 a:hover { color: var(--amber); }
    .card p { margin: 0; color: var(--dim); font-size: 13px; line-height: 1.5; }

    .empty { padding: 60px; text-align: center; color: var(--dim); font-family: var(--mono); }
    .kbd { font-family: var(--mono); background: var(--bg-2); border: 1px solid var(--line-2); padding: 1px 5px; border-radius: 2px; font-size: 10px; color: var(--amber); }
  </style>

  <div class="topbar">
    <div class="logo">▲<b> NEWS HUB</b></div>
    <div class="sep"></div>
    <select id="dateSel"></select>
    <select id="sortSel">
      <option value="time-desc">最新</option>
      <option value="time-asc">最早</option>
      <option value="source">按来源</option>
    </select>
    <input id="search" type="search" placeholder="搜索 (/) ..." />
    <div class="grow"></div>
    <div class="clock mono" id="clock"></div>
    <div class="sep"></div>
    <div class="user">USER <b id="user">${escapeHtml(user.username)}</b></div>
    <button class="bar-btn" id="pwBtn">改密码</button>
    <button class="bar-btn logout" id="logoutBtn">登出</button>
  </div>

  <div class="modal-bg" id="pwModal">
    <div class="modal">
      <h2>修改密码</h2>
      <div class="sub">修改后，其他设备上的会话会被注销</div>
      <div class="msg" id="pwMsg"></div>
      <form id="pwForm">
        <label>当前密码</label>
        <input name="current_password" type="password" autocomplete="current-password" required>
        <label>新密码</label>
        <input name="new_password" type="password" autocomplete="new-password" minlength="6" required>
        <label>确认新密码</label>
        <input name="confirm_password" type="password" minlength="6" required>
        <div class="actions">
          <button type="button" class="cancel" id="pwCancel">取消</button>
          <button type="submit" class="confirm" id="pwSubmit">保存</button>
        </div>
      </form>
    </div>
  </div>

  <div class="ticker" id="ticker"></div>

  <div class="layout">
    <aside class="rail">
      <h3>来源</h3>
      <div id="rail"></div>
    </aside>
    <main class="main">
      <div class="stats" id="stats"></div>
      <div id="list"></div>
    </main>
  </div>

  <script>
    const dateSel = document.getElementById('dateSel');
    const sortSel = document.getElementById('sortSel');
    const search = document.getElementById('search');
    const rail = document.getElementById('rail');
    const list = document.getElementById('list');
    const stats = document.getElementById('stats');
    const tickerEl = document.getElementById('ticker');

    let activeSources = new Set();
    let currentData = null;

    // Live clock (UTC HH:MM:SS)
    function tickClock() {
      const d = new Date();
      const pad = n => String(n).padStart(2,'0');
      document.getElementById('clock').textContent =
        pad(d.getUTCHours())+':'+pad(d.getUTCMinutes())+':'+pad(d.getUTCSeconds())+' UTC';
    }
    tickClock(); setInterval(tickClock, 1000);

    document.getElementById('logoutBtn').onclick = async () => {
      await fetch('/api/logout', { method: 'POST' });
      location.href = '/login';
    };

    // Change-password modal
    const pwModal = document.getElementById('pwModal');
    const pwForm  = document.getElementById('pwForm');
    const pwMsg   = document.getElementById('pwMsg');
    const pwSubmit = document.getElementById('pwSubmit');
    const openModal  = () => { pwMsg.textContent = ''; pwMsg.className = 'msg'; pwForm.reset(); pwModal.classList.add('show'); };
    const closeModal = () => pwModal.classList.remove('show');
    document.getElementById('pwBtn').onclick = openModal;
    document.getElementById('pwCancel').onclick = closeModal;
    pwModal.addEventListener('click', e => { if (e.target === pwModal) closeModal(); });
    pwForm.addEventListener('submit', async e => {
      e.preventDefault();
      pwMsg.className = 'msg'; pwMsg.textContent = '';
      const fd = new FormData(pwForm);
      const obj = Object.fromEntries(fd);
      if (obj.new_password !== obj.confirm_password) {
        pwMsg.className = 'msg err'; pwMsg.textContent = '两次输入的新密码不一致';
        return;
      }
      pwSubmit.disabled = true; pwSubmit.textContent = '保存中...';
      try {
        const res = await fetch('/api/change-password', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ current_password: obj.current_password, new_password: obj.new_password })
        });
        const text = await res.text();
        let data = null; try { data = JSON.parse(text); } catch {}
        if (res.ok) {
          pwMsg.className = 'msg ok'; pwMsg.textContent = '✓ 密码已更新';
          setTimeout(closeModal, 1200);
        } else {
          pwMsg.className = 'msg err';
          pwMsg.textContent = (data && data.error) ? data.error : ('['+res.status+'] '+text.slice(0,120));
        }
      } catch (err) {
        pwMsg.className = 'msg err'; pwMsg.textContent = '网络错误：' + err.message;
      } finally {
        pwSubmit.disabled = false; pwSubmit.textContent = '保存';
      }
    });

    // Keyboard: "/" focuses search
    document.addEventListener('keydown', e => {
      if (e.key === '/' && document.activeElement !== search) { e.preventDefault(); search.focus(); }
      if (e.key === 'Escape') search.blur();
    });

    async function loadDates() {
      const res = await fetch('/api/dates');
      if (!res.ok) return;
      const data = await res.json();
      const dates = (data.dates || []).sort().reverse();
      dateSel.innerHTML = dates.map(d => '<option value="'+d.date+'">'+d.date+' ('+d.count+')</option>').join('');
      if (dates.length) loadDay(dates[0].date);
      else list.innerHTML = '<div class="empty">暂无数据</div>';
    }

    async function loadDay(date) {
      const res = await fetch('/api/news?date=' + date);
      if (!res.ok) { list.innerHTML = '<div class="empty">加载失败</div>'; return; }
      currentData = await res.json();
      activeSources.clear();
      render();
    }

    function render() {
      if (!currentData) return;
      const { articles = [], sources = [], generated_at } = currentData;

      // Rail
      const counts = {};
      articles.forEach(a => counts[a.source] = (counts[a.source]||0) + 1);
      rail.innerHTML = ['<div class="src '+(activeSources.size===0?'active':'')+'" data-src="__all__">'+
          '<span>全部</span><span class="cnt">'+articles.length+'</span></div>']
        .concat(sources.map(s => {
          const on = activeSources.has(s);
          return '<div class="src '+(on?'active':'')+'" data-src="'+escapeAttr(s)+'">'+
            '<span>'+escapeHtml(s)+'</span><span class="cnt">'+(counts[s]||0)+'</span></div>';
        })).join('') +
        '<div class="divider"></div>'+
        '<h3 style="padding: 0 18px">快捷键</h3>'+
        '<div style="padding: 0 18px; font-family: var(--mono); font-size: 11px; color: var(--dim); line-height: 1.9">'+
          '<span class="kbd">/</span> 搜索<br>'+
          '<span class="kbd">Esc</span> 取消'+
        '</div>';
      rail.querySelectorAll('.src').forEach(el => {
        el.onclick = () => {
          const s = el.dataset.src;
          if (s === '__all__') activeSources.clear();
          else if (activeSources.has(s)) activeSources.delete(s);
          else activeSources.add(s);
          render();
        };
      });

      // Filter
      const kw = search.value.trim().toLowerCase();
      let items = articles.filter(a => {
        if (activeSources.size && !activeSources.has(a.source)) return false;
        if (kw && !(a.title.toLowerCase().includes(kw) || (a.summary||'').toLowerCase().includes(kw))) return false;
        return true;
      });
      const mode = sortSel.value;
      if (mode === 'time-desc') items.sort((a,b)=>b.timestamp-a.timestamp);
      else if (mode === 'time-asc') items.sort((a,b)=>a.timestamp-b.timestamp);
      else items.sort((a,b)=>a.source.localeCompare(b.source) || b.timestamp-a.timestamp);

      // Ticker (top 6 headlines scrolling-style, static for now)
      const headlines = articles.slice(0, 6);
      tickerEl.innerHTML = headlines.map(h =>
        '<span><b>'+escapeHtml(h.source)+'</b> <span class="sep">·</span> '+escapeHtml(h.title.slice(0,40))+(h.title.length>40?'...':'')+'</span>'
      ).join('<span class="sep">│</span>');

      // Stats
      stats.innerHTML =
        '<span>显示 <b>'+items.length+'</b> / '+articles.length+'</span>' +
        '<span>来源 <b>'+sources.length+'</b></span>' +
        '<span>生成于 <b>'+escapeHtml(generated_at||'')+'</b></span>';

      if (!items.length) { list.innerHTML = '<div class="empty">没有匹配的文章</div>'; return; }

      list.innerHTML = '<div class="grid">' + items.map(a => (
        '<article class="card">'+
          '<div class="meta">'+
            '<span class="src-tag">'+escapeHtml(a.source)+'</span>'+
            '<span>'+escapeHtml(a.published_at||'')+'</span>'+
          '</div>'+
          '<h2><a href="'+escapeAttr(a.link)+'" target="_blank" rel="noopener">'+hl(a.title,kw)+'</a></h2>'+
          (a.summary ? '<p>'+hl(a.summary,kw)+'</p>' : '')+
        '</article>'
      )).join('') + '</div>';
    }

    function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
    function escapeAttr(s){return escapeHtml(s);}
    function hl(s,kw){const e=escapeHtml(s); if(!kw) return e; const re=new RegExp('('+kw.replace(/[.*+?^\${}()|[\\]\\\\]/g,'\\\\$&')+')','gi'); return e.replace(re,'<mark>$1</mark>');}

    dateSel.onchange = () => loadDay(dateSel.value);
    sortSel.onchange = render;
    search.oninput = render;

    loadDates();
  </script>`);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
