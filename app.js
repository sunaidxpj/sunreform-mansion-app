// サンリフォーム マンション検索 SPA
// Microsoft Entra ID (MSAL.js) でログイン → Cloud Run API でデータ取得

const CONFIG = {
  AZURE_TENANT_ID: "45878bb2-84d5-46e8-b4c2-d50f6b61e4a9",
  AZURE_CLIENT_ID: "eef6d57e-fbbd-4d81-a5bd-26299819a205",
  REDIRECT_URI: "https://sunaidxpj.github.io/sunreform-mansion-app/",
  API_BASE: "https://sunbo-v2-504595374043.asia-northeast1.run.app",
};

const msalConfig = {
  auth: {
    clientId: CONFIG.AZURE_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${CONFIG.AZURE_TENANT_ID}`,
    redirectUri: CONFIG.REDIRECT_URI,
  },
  cache: {
    cacheLocation: "localStorage",
    storeAuthStateInCookie: false,
  },
};

const loginRequest = { scopes: ["openid", "profile", "email"] };
const tokenRequest = { scopes: [`${CONFIG.AZURE_CLIENT_ID}/.default`] };

const msalClient = new window.msal.PublicClientApplication(msalConfig);

const STATE = {
  account: null,
  idToken: null,
  mansions: [],
  filtered: [],
  selected: null,
  detail: null,
  lastError: null,
};

// ===== 認証 =====

async function ensureToken() {
  const account = msalClient.getAllAccounts()[0];
  if (!account) return null;
  try {
    const res = await msalClient.acquireTokenSilent({
      ...loginRequest,
      account,
    });
    STATE.idToken = res.idToken;
    STATE.account = account;
    return res.idToken;
  } catch (e) {
    console.warn("Silent token failed, redirecting:", e);
    await msalClient.loginRedirect(loginRequest);
    return null;
  }
}

async function startLogin() {
  await msalClient.loginRedirect(loginRequest);
}

function logout() {
  msalClient.logoutRedirect({ postLogoutRedirectUri: CONFIG.REDIRECT_URI });
}

// ===== API =====

async function api(action, params = {}) {
  const url = new URL(CONFIG.API_BASE);
  url.searchParams.set("action", action);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${STATE.idToken}` },
  });
  if (res.status === 401) {
    STATE.idToken = null;
    STATE.account = null;
    render();
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
  return (s || "").replace(/[\s　]/g, "").toLowerCase();
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
        <p>Microsoftアカウント（@sunreform.jp）でログインしてください。</p>
        <button onclick="startLogin()">
          <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true">
            <rect x="1" y="1" width="9" height="9" fill="#f25022"/>
            <rect x="11" y="1" width="9" height="9" fill="#7fba00"/>
            <rect x="1" y="11" width="9" height="9" fill="#00a4ef"/>
            <rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
          </svg>
          Microsoftでサインイン
        </button>
      </div>
    </div>
  `;
}

function renderHeader() {
  const email = STATE.account?.username || "";
  return `
    <header>
      <h1>サンリフォーム マンション検索</h1>
      <span class="user">${escHtml(email)}</span>
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
    <div class="card" onclick='showDetail(${JSON.stringify(m.key)})'>
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
        <div id="results-area">${renderList()}</div>
      `}
    </div>
  `;
  const q = document.getElementById("q");
  if (q) {
    q.focus();
    q.addEventListener("input", e => {
      filterMansions(e.target.value);
      const area = document.getElementById("results-area");
      if (area) area.innerHTML = renderList();
    });
  }
}

function render() {
  if (!STATE.idToken) {
    renderLogin();
  } else {
    renderMain();
  }
}

window.startLogin = startLogin;
window.logout = logout;
window.showDetail = showDetail;
window.goBack = goBack;

// ===== 初期化 =====

(async function init() {
  // Redirect コールバック処理
  try {
    const res = await msalClient.handleRedirectPromise();
    if (res) {
      STATE.idToken = res.idToken;
      STATE.account = res.account;
    }
  } catch (e) {
    console.error("handleRedirectPromise error:", e);
    STATE.lastError = `サインインに失敗しました: ${e.errorMessage || e.message}`;
    render();
    return;
  }

  // 既存セッション復元
  if (!STATE.idToken) {
    const account = msalClient.getAllAccounts()[0];
    if (account) {
      try {
        const r = await msalClient.acquireTokenSilent({ ...loginRequest, account });
        STATE.idToken = r.idToken;
        STATE.account = account;
      } catch (e) {
        // silent 失敗なら未ログインとして扱う
      }
    }
  }

  render();
  if (STATE.idToken) loadMansions();
})();
