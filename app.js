// サンリフォーム マンション検索 SPA
// GitHub OAuth でログイン → Cloud Run API でマンション一覧＋詳細を取得

const CONFIG = {
  GITHUB_CLIENT_ID: "Ov23liBbSJD8bpsaslLX",
  API_BASE: "https://sunbo-v2-504595374043.asia-northeast1.run.app",
  CALLBACK_URL: "https://sunbo-v2-504595374043.asia-northeast1.run.app/?action=auth-github-callback",
};

const STATE = {
  token: null,
  user: null,
  mansions: [],
  filtered: [],
  selected: null,
  detail: null,
  lastError: null,
};

// ===== 認証 =====

function getStoredToken() {
  return localStorage.getItem("mansion_app_token");
}

function storeToken(token) {
  localStorage.setItem("mansion_app_token", token);
}

function clearToken() {
  localStorage.removeItem("mansion_app_token");
}

function parseJwt(token) {
  try {
    const payload = token.split(".")[1];
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(decodeURIComponent(escape(json)));
  } catch (e) {
    return null;
  }
}

function isTokenValid(token) {
  const p = parseJwt(token);
  return p && p.exp && p.exp > Math.floor(Date.now() / 1000);
}

function startLogin() {
  const state = Math.random().toString(36).slice(2);
  sessionStorage.setItem("oauth_state", state);
  const params = new URLSearchParams({
    client_id: CONFIG.GITHUB_CLIENT_ID,
    redirect_uri: CONFIG.CALLBACK_URL,
    scope: "read:org",
    state,
  });
  location.href = `https://github.com/login/oauth/authorize?${params}`;
}

function logout() {
  clearToken();
  STATE.token = null;
  STATE.user = null;
  render();
}

// ===== API =====

async function api(action, params = {}) {
  const url = new URL(CONFIG.API_BASE);
  url.searchParams.set("action", action);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${STATE.token}` },
  });
  if (res.status === 401) {
    logout();
    throw new Error("認証が切れました。再ログインしてください。");
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`API error ${res.status}: ${t}`);
  }
  return res.json();
}

async function loadMansions() {
  STATE.lastError = null;
  try {
    const data = await api("mansion-list");
    STATE.mansions = data.items || [];
    STATE.filtered = [];
    render();
  } catch (e) {
    STATE.lastError = e.message;
    render();
  }
}

async function showDetail(key) {
  STATE.selected = key;
  STATE.detail = null;
  STATE.lastError = null;
  render();
  try {
    const data = await api("mansion-detail", { key });
    STATE.detail = data;
    render();
  } catch (e) {
    STATE.lastError = e.message;
    render();
  }
}

function goBack() {
  STATE.selected = null;
  STATE.detail = null;
  render();
}

// ===== 検索 =====

function normalize(s) {
  return (s || "").replace(/\s　/g, "").toLowerCase();
}

function filterMansions(query) {
  const q = normalize(query);
  if (!q) {
    STATE.filtered = [];
    return;
  }
  STATE.filtered = STATE.mansions
    .filter(m => normalize(m.name).includes(q) || normalize(m.city).includes(q))
    .slice(0, 100);
}

// ===== レンダリング =====

const app = document.getElementById("app");

function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function renderLogin() {
  app.innerHTML = `
    <div class="login-screen">
      <div class="login-box">
        <h2>サンリフォーム マンション検索</h2>
        <p>GitHubアカウントでログインしてください。<br>
           sunaidxpj org のメンバー限定です。</p>
        <button onclick="startLogin()">
          <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
          </svg>
          GitHubでログイン
        </button>
      </div>
    </div>
  `;
}

function renderHeader() {
  return `
    <header>
      <h1>サンリフォーム マンション検索</h1>
      <span class="user">@${escHtml(STATE.user)}</span>
      <button class="logout" onclick="logout()">ログアウト</button>
    </header>
  `;
}

function renderList() {
  if (STATE.lastError) {
    return `<div class="error">${escHtml(STATE.lastError)}</div>`;
  }
  if (!STATE.mansions.length) {
    return `<div class="loading">マンション一覧を読み込み中…</div>`;
  }
  const q = document.getElementById("q")?.value || "";
  if (!q.trim()) {
    return `<div class="empty-state">マンション名または市名で絞り込んでください（${STATE.mansions.length.toLocaleString()}件）</div>`;
  }
  if (!STATE.filtered.length) {
    return `<div class="empty-state">該当するマンションが見つかりませんでした。</div>`;
  }
  const cards = STATE.filtered.map(m => `
    <div class="card" onclick="showDetail(${JSON.stringify(m.key).replace(/"/g, "&quot;")})">
      <div class="name">${escHtml(m.name)}</div>
      <div class="city">${escHtml(m.city || "（市未登録）")}</div>
    </div>
  `).join("");
  return `
    <div class="meta">${STATE.filtered.length}件${STATE.filtered.length >= 100 ? " 以上（先頭100件を表示）" : ""}</div>
    <div class="results">${cards}</div>
  `;
}

function renderDetail() {
  if (!STATE.detail) {
    return `
      <button class="back" onclick="goBack()">← 一覧に戻る</button>
      ${STATE.lastError ? `<div class="error">${escHtml(STATE.lastError)}</div>` : `<div class="loading">読み込み中…</div>`}
    `;
  }
  const m = STATE.detail.mansion || {};
  const sites = STATE.detail.sites || [];
  const 申し送り = (m["申し送り"] || "").trim();
  const sitesRows = sites.length
    ? sites.map(s => `
        <tr>
          <td>${escHtml(s.id)}</td>
          <td>${escHtml(s.address || s.address_line || "")}</td>
          <td>${escHtml(s.construction_status || s.status || "")}</td>
          <td>${escHtml(s.main_staff || "")}</td>
          <td>${escHtml(s.complete_date || s.synced_at || "")}</td>
        </tr>
      `).join("")
    : `<tr><td colspan="5" style="text-align:center;color:#6e6e73;padding:24px">紐付く工事履歴がありません</td></tr>`;
  return `
    <button class="back" onclick="goBack()">← 一覧に戻る</button>
    <div class="detail">
      <h2>${escHtml(m.name)}</h2>
      <div class="sub">${escHtml(m.city || "")}　/　現場履歴 ${sites.length}件</div>
      <div class="section">
        <h3>申し送り事項</h3>
        <div class="申し送り${申し送り ? "" : " empty"}">${申し送り ? escHtml(申し送り) : "（未登録）"}</div>
      </div>
      <div class="section sites">
        <h3>関連する現場</h3>
        <table>
          <thead><tr><th>現場ID</th><th>住所</th><th>工事状況</th><th>担当</th><th>日付</th></tr></thead>
          <tbody>${sitesRows}</tbody>
        </table>
      </div>
    </div>
  `;
}

function renderMain() {
  app.innerHTML = `
    ${renderHeader()}
    <div class="container">
      ${STATE.selected ? renderDetail() : `
        <div class="search">
          <input id="q" type="search" placeholder="マンション名で検索…" autocomplete="off">
        </div>
        ${renderList()}
      `}
    </div>
  `;
  const q = document.getElementById("q");
  if (q) {
    q.focus();
    q.addEventListener("input", e => {
      filterMansions(e.target.value);
      // 結果エリアだけ再描画
      const area = document.querySelector(".results, .empty-state, .meta, .loading, .error");
      if (area) {
        const parent = area.closest(".container");
        const searchDiv = parent.querySelector(".search");
        parent.innerHTML = "";
        parent.appendChild(searchDiv);
        parent.insertAdjacentHTML("beforeend", renderList());
      }
    });
  }
}

function render() {
  if (!STATE.token) {
    renderLogin();
  } else {
    renderMain();
  }
}

// ===== 初期化 =====

window.startLogin = startLogin;
window.logout = logout;
window.showDetail = showDetail;
window.goBack = goBack;

(function init() {
  const token = getStoredToken();
  if (token && isTokenValid(token)) {
    STATE.token = token;
    const p = parseJwt(token);
    STATE.user = p.sub;
    render();
    loadMansions();
  } else {
    clearToken();
    render();
  }
})();
