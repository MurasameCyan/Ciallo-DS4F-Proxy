/**
 * login.js —— 登录页。
 *
 * 只做一件事:把凭据 POST 给 /api/login,成功就换到面板。
 * 会话在 HttpOnly cookie 里,前端读不到也不用管 —— 之后的 /api/* 和
 * EventSource('/api/logs') 都靠浏览器自动带上。
 */

const $ = (id) => document.getElementById(id);

$('login-form').onsubmit = async (e) => {
  e.preventDefault();
  const btn = $('btn-login');
  const err = $('login-err');
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = '登录中…';
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: $('f-user').value, pass: $('f-pass').value }),
    });
    if (!r.ok) {
      // 401 是密码不对,429 是失败太多被限速 —— 服务端给的话都能直接显示
      const d = await r.json().catch(() => null);
      throw new Error(d?.error || `HTTP ${r.status}`);
    }
    // replace 而不是 href:登录页不该留在后退历史里
    location.replace('/');
  } catch (e2) {
    err.textContent = e2.message;
    err.hidden = false;
    $('f-pass').select();          // 选中而不是清空,重打一次就覆盖掉
  } finally {
    btn.disabled = false;
    btn.textContent = '登录';
  }
};
