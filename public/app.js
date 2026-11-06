const $ = (s) => document.querySelector(s);
const state = { user: null, items: [], categories: [], accounts: [], page: "search" };
const loading = $("#loading");

function toast(message) {
  const el = $("#toast"); el.textContent = message; el.classList.add("show");
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove("show"), 3200);
}
function showLoading(message = "Processando...") {
  $("#loading-message").textContent = message;
  loading.classList.add("show");
  document.body.classList.add("is-busy");
}
function hideLoading() {
  loading.classList.remove("show");
  document.body.classList.remove("is-busy");
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function withLoader(task, message = "Processando...") {
  showLoading(message);
  const started = Date.now();
  try { return await task(); }
  finally {
    const remaining = 1500 - (Date.now() - started);
    if (remaining > 0) await wait(remaining);
    hideLoading();
  }
}
function resultModal(success, message) {
  const modal = $("#result-modal");
  $("#result-icon").textContent = success ? "✓" : "×";
  $("#result-icon").className = "result-icon " + (success ? "result-success" : "result-error");
  $("#result-title").textContent = success ? "Sucesso!" : "Erro!";
  $("#result-message").textContent = message;
  modal.classList.add("show");
  $("#result-ok").focus();
}
async function performAction(message, task, successMessage, onSuccess) {
  try {
    const result = await withLoader(task, message);
    if (onSuccess) await onSuccess(result);
    resultModal(true, typeof successMessage === "function" ? successMessage(result) : successMessage);
    return result;
  } catch (error) {
    resultModal(false, error.message || "Não foi possível concluir a operação. Tente novamente.");
    return null;
  }
}
async function api(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", headers: { ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...(options.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Ocorreu um erro.");
  return data;
}
function openModal(id) { closeModals(); $(id).classList.add("show"); }
function closeModals() { document.querySelectorAll(".modal-backdrop").forEach(m => m.classList.remove("show")); }

function navigate(page) {
  if (!state.user && page !== "search") return openModal("#login-modal");
  if (page === "accounts" && !canManageAccounts()) return toast("Acesso exclusivo de administradores.");
  if (page === "categories" && !canManageCategories()) return toast("Acesso restrito a servidores e administradores.");
  if (page === "create") { if (canCreate()) openModal("#item-modal"); else toast("Seu perfil não pode cadastrar anúncios."); return; }
  if (page === "profile") { $("#profile-form").elements.telefone.value = state.user.telefone || ""; openModal("#profile-modal"); return; }
  state.page = page;
  if (page === "accounts") loadAccounts();
  document.querySelectorAll("[data-page]").forEach(b => b.classList.toggle("active", b.dataset.page === page));
  $("#page-title").textContent = page === "mine" ? "Meus anúncios" : page === "categories" ? "Gerenciar categorias" : state.page === "accounts" ? "Gerenciar contas" : "Pesquisar itens";
  $("#page-subtitle").textContent = page === "mine" ? "Gerencie os anúncios que você cadastrou." : page === "categories" ? "Organize as categorias dos anúncios." : page === "accounts" ? "Consulte e gerencie as contas cadastradas." : "Encontre objetos perdidos e encontrados no campus.";
  $("#search-panel").hidden = page !== "search";
  $("#categories-panel").hidden = page !== "categories";
  $("#accounts-panel").hidden = page !== "accounts";
  $("#items").hidden = ["categories", "accounts"].includes(page);
  $("#my-items-head").hidden = page !== "mine";
  renderItems(visibleItems());
  document.querySelector("#anuncios").scrollIntoView({behavior:"smooth",block:"start"});
}
function visibleItems() {
  if (state.page === "mine" && state.user) return state.items.filter(i => String(i.usuario_matricula) === String(state.user.matricula));
  return state.items;
}
function applyDashboard() {
  const logged = !!state.user;
  $("#dashboard-sidebar").hidden = !logged;
  $("#dashboard-heading").hidden = !logged;
  document.body.classList.toggle("is-logged", logged);
  document.querySelectorAll("[data-can-create]").forEach(el => el.hidden = logged && !canCreate());
  if (!logged || (state.page === "categories" && !canManageCategories()) || (state.page === "accounts" && !canManageAccounts())) state.page = "search";
  $("#categories-nav").hidden = !canManageCategories();
  $("#accounts-nav").hidden = !canManageAccounts();
  $("#categories-panel").hidden = state.page !== "categories";
  $("#accounts-panel").hidden = state.page !== "accounts";
  $("#items").hidden = ["categories", "accounts"].includes(state.page);
  $("#search-panel").hidden = state.page !== "search";
  $("#my-items-head").hidden = !logged || state.page !== "mine";
  $("#page-title").textContent = state.page === "mine" ? "Meus anúncios" : state.page === "categories" ? "Gerenciar categorias" : state.page === "accounts" ? "Gerenciar contas" : "Pesquisar itens";
  document.querySelectorAll("[data-page]").forEach(b => b.classList.toggle("active", b.dataset.page === state.page));
}
function renderNav() {
  applyDashboard();
  const box = $("#nav-user");
  if (!state.user) { box.innerHTML = '<button class="btn outline" data-open-login>Entrar</button>'; return; }
  const roleNames = { administrador: "Administrador", servidor: "Servidor", aluno: "Aluno" };
  const userName = escapeHtml(state.user.nome);
  const userRole = roleNames[state.user.role] || "Aluno";
  box.innerHTML = `<div class="account-menu"><button class="account-trigger" id="account-trigger" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="account-options"><span class="account-avatar" aria-hidden="true">👤</span><span class="account-identity"><strong>${userName}</strong><small>${userRole}</small></span><span class="account-chevron" aria-hidden="true">⌄</span></button><div class="account-options" id="account-options" hidden><button type="button" data-open-profile>⚙ Editar conta</button><button type="button" id="logout-btn">↪ Sair da conta</button></div></div>`;
  $("#logout-btn").addEventListener("click", logout);
  $("#account-trigger").addEventListener("click", () => {
    const menu = $("#account-options");
    menu.hidden = !menu.hidden;
    $("#account-trigger").setAttribute("aria-expanded", String(!menu.hidden));
  });
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}
function canManageAccounts() { return !!state.user && state.user.role === "administrador"; }
function canManageCategories() { return !!state.user && ["administrador", "servidor"].includes(state.user.role); }
function canEdit() { return state.user && ["administrador", "servidor"].includes(state.user.role); }
function canCreate() { return state.user && ["administrador", "aluno"].includes(state.user.role); }
function canDelete(item) { return state.user && (state.user.role !== "aluno" || String(item.usuario_matricula) === String(state.user.matricula)); }
function itemEmoji(category) {
  const map = { "Eletrônicos":"🎧", "Material escolar":"📒", "Acessórios":"🔑", "Documentos":"🪪", "Vestuário":"🧥" };
  return map[category] || "📦";
}
function renderItems(items) {
  const grid = $("#items");
  if (!items.length) { grid.innerHTML = '<div class="empty">Nenhum anúncio encontrado. Seja o primeiro a cadastrar um objeto!</div>'; return; }
  grid.innerHTML = items.map(item => {
    const image = item.imagem_url ? `<img src="${escapeHtml(item.imagem_url)}" alt="${escapeHtml(item.titulo)}" onerror="this.remove()">` : itemEmoji(item.categoria);
    const tag = item.status === "entregue" ? "Entregue" : item.tipo === "perdido" ? "Perdido" : "Achado";
    const tagClass = item.status === "entregue" ? "delivered" : item.tipo === "perdido" ? "lost" : "found";
    const actions = [
      `<button class="details-btn" data-view="${item.id}">Ver detalhes</button>`,
      ...(canEdit() ? [`<button class="link-btn" data-edit="${item.id}">Editar</button>`] : []),
      ...(canDelete(item) ? [`<button class="link-btn danger" data-delete="${item.id}">Excluir</button>`] : [])
    ].join("");
    return `<article class="item-card"><div class="item-art"><span class="tag ${tagClass}">${tag}</span>${image}</div><div class="item-body"><div class="meta"><span>${escapeHtml(item.categoria)}</span><span>${new Date(item.criado_em).toLocaleDateString("pt-BR")}</span></div><h3>${escapeHtml(item.titulo)}</h3><p>${escapeHtml(item.descricao)}</p><div class="item-foot"><span>⌖ ${escapeHtml(item.local)} · ${item.status === "entregue" ? "Entregue" : "Em aberto"}</span><div class="item-actions">${actions}</div></div></div></article>`;
  }).join("");
  grid.querySelectorAll("[data-view]").forEach(b => b.addEventListener("click", () => {
    const item = items.find(i => String(i.id) === b.dataset.view);
    if (item) showItemDetails(item);
  }));
  grid.querySelectorAll("[data-delete]").forEach(b => b.addEventListener("click", () => deleteItem(b.dataset.delete)));
  grid.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => editItem(b.dataset.edit)));
}
function formatItemDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Não informada" : date.toLocaleString("pt-BR", { dateStyle: "long", timeStyle: "short" });
}
function showItemDetails(item) {
  const content = $("#details-content");
  const safeImage = item.imagem_url && (/^https?:\/\//i.test(item.imagem_url) || /^\/uploads\/[a-z0-9.-]+$/i.test(item.imagem_url));
  const visual = safeImage
    ? `<img class="details-photo" src="${escapeHtml(item.imagem_url)}" alt="Foto de ${escapeHtml(item.titulo)}" onerror="this.style.display='none'">`
    : `<div class="details-placeholder" aria-hidden="true">${itemEmoji(item.categoria)}</div>`;
  const situation = item.status === "entregue" ? "Entregue ao dono" : "Em aberto";
  const type = item.tipo === "perdido" ? "Objeto perdido" : "Objeto encontrado";
  const digits = String(item.contato_telefone || "").replace(/\D/g, "");
  const hasContact = /^[1-9][0-9]{9,10}$/.test(digits);
  const contactUrl = hasContact ? `https://wa.me/55${digits}?text=${encodeURIComponent(`Olá! Vi seu anúncio "${item.titulo}" (#${item.id}) no Achados & Perdidos IFRN Lajes. Gostaria de combinar um local seguro no campus para a entrega ou retirada do objeto.`)}` : "";
  const contactBlock = hasContact
    ? `<div class="details-contact"><h3>Entre em contato</h3><p>Responsável: <strong>${escapeHtml(item.contato_nome || "Anunciante")}</strong></p><p>WhatsApp: ${escapeHtml(digits)}</p><a class="btn primary whatsapp-btn" href="${escapeHtml(contactUrl)}" target="_blank" rel="noopener noreferrer">Conversar pelo WhatsApp ↗</a><small>Combine a entrega em um local público do campus. Nunca compartilhe senhas ou códigos de verificação.</small></div>`
    : `<p class="details-note">Este anúncio ainda não tem WhatsApp de contato. O responsável deve adicionar um número em Editar perfil.</p>`;
  content.innerHTML = `
    ${visual}
    <div class="details-heading"><div><span class="details-kicker">${type}</span><h2 id="details-title">${escapeHtml(item.titulo)}</h2></div><span class="details-status ${item.status === "entregue" ? "delivered" : item.tipo === "perdido" ? "lost" : "found"}">${situation}</span></div>
    <div class="details-fields">
      <div><span>Categoria</span><strong>${escapeHtml(item.categoria)}</strong></div>
      <div><span>Local</span><strong>${escapeHtml(item.local)}</strong></div>
      <div><span>Data do anúncio</span><strong>${escapeHtml(formatItemDate(item.criado_em))}</strong></div>
      <div><span>Número do anúncio</span><strong>#${escapeHtml(item.id)}</strong></div>
    </div>
    <div class="details-description"><h3>Descrição do objeto</h3><p>${escapeHtml(item.descricao)}</p></div>
    ${contactBlock}
  `;
  openModal("#details-modal");
}
async function loadItems() {
  const params = new URLSearchParams();
  if ($("#search").value.trim()) params.set("busca", $("#search").value.trim());
  if ($("#category").value) params.set("categoria", $("#category").value);
  if ($("#type").value) params.set("tipo", $("#type").value);
  try {
    const data = await api(`/api/items?${params}`);
    state.items = data.items.filter(i => { const days = Number($("#date-filter").value); const status = $("#status-filter").value; return (!status || i.status === status) && (!days || (Date.now() - new Date(i.criado_em).getTime()) <= days * 86400000); }); $("#delivered-count").textContent = data.delivered;
    renderItems(visibleItems());
  } catch (error) {
    $("#items").innerHTML = `<div class="empty">${escapeHtml(error.message)} Verifique se o banco está conectado e se a tabela itens foi criada.</div>`;
  }
}
async function login(event) {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  await performAction("Entrando na conta...", () => api("/api/auth/login", { method: "POST", body: JSON.stringify({ matricula: form.get("matricula"), senha: form.get("senha") }) }), "Login realizado com sucesso!", async data => {
    state.user = data.user; closeModals(); formElement.reset(); renderNav(); await loadCategories(); await loadItems(); navigate("search");
  });
}
async function register(event) {
  event.preventDefault();
  const formElement = event.currentTarget;
  const data = Object.fromEntries(new FormData(formElement).entries());
  await performAction("Criando sua conta...", () => api("/api/auth/register", { method: "POST", body: JSON.stringify(data) }), "Conta criada com sucesso! Agora você pode entrar.", async () => {
    formElement.reset(); openModal("#login-modal"); $("#login-form").elements.matricula.value = data.matricula;
  });
}
async function saveProfile(event) {
  event.preventDefault();
  const telefone = new FormData(event.currentTarget).get("telefone");
  await performAction("Salvando seu número...", () => api("/api/profile", { method: "PUT", body: JSON.stringify({ telefone }) }), "Número atualizado com sucesso!", async data => {
    state.user = data.user; renderNav(); await loadItems(); closeModals();
  });
}
async function changePassword(event) {
  event.preventDefault();
  const formElement = event.currentTarget;
  const data = Object.fromEntries(new FormData(formElement).entries());
  if (data.nova_senha !== data.confirmacao) return resultModal(false, "As novas senhas não coincidem.");
  await performAction("Alterando sua senha...", () => api("/api/profile/password", { method: "PUT", body: JSON.stringify(data) }), "Senha alterada com sucesso!", () => { formElement.reset(); closeModals(); });
}
async function logout() {
  await performAction("Saindo da conta...", () => api("/api/auth/logout", { method: "POST" }), "Você saiu da sua conta com sucesso!", async () => {
    state.user = null; renderNav(); await loadItems();
  });
}
async function loadCategories() {
  try {
    const data = await api("/api/categories");
    state.categories = data.categories;
    const options = state.categories.map(c => `<option value="${escapeHtml(c.nome)}">${escapeHtml(c.nome)}</option>`).join("");
    const filter = $("#category"), old = filter.value;
    filter.innerHTML = '<option value="">Todas</option>' + options;
    if (state.categories.some(c => c.nome === old)) filter.value = old;
    [$("#item-form").elements.categoria, $("#edit-form").elements.categoria].forEach(select => {
      const previous = select.value;
      select.innerHTML = '<option value="">Selecione uma categoria</option>' + options;
      if (state.categories.some(c => c.nome === previous)) select.value = previous;
    });
    const list = $("#categories-list");
    list.innerHTML = state.categories.map(c => `<div class="category-row"><strong>${escapeHtml(c.nome)}</strong>${canManageCategories() ? `<button type="button" class="category-delete" data-category-delete="${c.id}" aria-label="Excluir categoria ${escapeHtml(c.nome)}">Excluir</button>` : ""}</div>`).join("");
  } catch (error) { toast(error.message); }
}
async function loadAccounts() {
  if (!canManageAccounts()) return;
  try {
    const data = await api("/api/admin/users");
    state.accounts = data.users;
    const body = $("#accounts-list");
    body.innerHTML = state.accounts.length ? state.accounts.map(user => `<tr><td>${escapeHtml(user.nome)}</td><td>${escapeHtml(user.matricula)}</td><td>${escapeHtml(user.telefone || "Não informado")}</td><td>${escapeHtml(({ admin: "Administrador", administrador: "Administrador", servidor: "Servidor", aluno: "Aluno" })[String(user.role || "").toLowerCase()] || "Não definido")}</td><td><div class="account-actions"><button type="button" data-account-edit="${escapeHtml(user.matricula)}" ${["admin", "administrador"].includes(String(user.role).toLowerCase()) ? "disabled title=\"Contas administradoras não podem ser editadas aqui\"" : ""}>Editar</button><button type="button" class="danger" data-account-delete="${escapeHtml(user.matricula)}" ${String(user.matricula) === String(state.user.matricula) ? "disabled title=\"Você não pode excluir sua conta\"" : ""}>Excluir</button></div></td></tr>`).join("") : '<tr><td colspan="5">Nenhuma conta cadastrada.</td></tr>';
  } catch (error) { resultModal(false, error.message); }
}
function editAccount(matricula) {
  const user = state.accounts.find(u => String(u.matricula) === String(matricula));
  if (!user) return;
  const form = $("#account-edit-form");
  form.elements.matricula_original.value = user.matricula;
  form.elements.matricula.value = user.matricula;
  form.elements.nome.value = user.nome;
  form.elements.telefone.value = user.telefone || "";
  if (!["aluno", "servidor"].includes(String(user.role).toLowerCase())) return resultModal(false, "Contas administradoras não podem ser editadas nesta tela.");
  form.elements.role.value = String(user.role).toLowerCase();
  openModal("#account-edit-modal");
}
async function saveAccount(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const old = form.elements.matricula_original.value;
  const payload = { nome: form.elements.nome.value, matricula: form.elements.matricula.value, telefone: form.elements.telefone.value, role: form.elements.role.value };
  await performAction("Atualizando conta...", () => api(`/api/admin/users/${encodeURIComponent(old)}`, { method: "PUT", body: JSON.stringify(payload) }), "Conta atualizada com sucesso!", async () => { closeModals(); await loadAccounts(); await loadItems(); if (old === String(state.user.matricula)) { const data = await api("/api/auth/me"); state.user = data.user; renderNav(); } });
}
async function deleteAccount(matricula) {
  const user = state.accounts.find(u => String(u.matricula) === String(matricula));
  if (!user) return;
  if (!confirm(`Excluir a conta de ${user.nome} (${user.matricula})? Todos os anúncios desta conta também serão excluídos. Esta ação não pode ser desfeita.`)) return;
  await performAction("Excluindo conta...", () => api(`/api/admin/users/${encodeURIComponent(matricula)}`, { method: "DELETE" }), result => `Conta excluída com sucesso! ${result.deletedItems} anúncio(s) removido(s).`, async () => { await loadAccounts(); await loadItems(); });
}
async function createCategory(event) {
  event.preventDefault();
  const form = event.currentTarget;
  await performAction("Criando categoria...", () => api("/api/categories", { method: "POST", body: JSON.stringify({ nome: form.elements.nome.value }) }), "Categoria criada com sucesso!", async () => { form.reset(); await loadCategories(); });
}
async function deleteCategory(id) {
  if (!confirm("Excluir esta categoria?")) return;
  await performAction("Excluindo categoria...", () => api(`/api/categories/${id}`, { method: "DELETE" }), "Categoria excluída com sucesso!", loadCategories);
}
async function createItem(event) {
  event.preventDefault();
  if (!state.user) { openModal("#login-modal"); return resultModal(false, "Entre na sua conta para anunciar."); }
  const formElement = event.currentTarget;
  const data = new FormData(formElement);
  await performAction("Criando anúncio...", () => api("/api/items", { method: "POST", body: data }), "Anúncio criado com sucesso!", async () => {
    formElement.reset(); closeModals(); await loadItems(); navigate("mine");
  });
}
async function deleteItem(id) {
  if (!confirm("Tem certeza de que deseja excluir este anúncio?")) return;
  await performAction("Excluindo anúncio...", () => api(`/api/items/${id}`, { method: "DELETE" }), "Anúncio excluído com sucesso!", loadItems);
}
function editItem(id) {
  const item = state.items.find(i => String(i.id) === String(id)); if (!item) return;
  const form = $("#edit-form");
  Object.entries({ ...item, id: item.id }).forEach(([key, value]) => { if (form.elements[key]) form.elements[key].value = value ?? ""; });
  openModal("#edit-modal");
}
async function saveEdit(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget), id = data.get("id"); data.delete("id");
  await performAction("Salvando alterações...", () => api(`/api/items/${id}`, { method: "PUT", body: data }), "Anúncio atualizado com sucesso!", async () => { closeModals(); await loadItems(); });
}
async function init() {
  $("#result-ok").addEventListener("click", () => $("#result-modal").classList.remove("show"));
  $("#result-modal").addEventListener("click", e => { if (e.target.id === "result-modal") $("#result-modal").classList.remove("show"); });
  $("#category-form").addEventListener("submit", createCategory);
  $("#account-edit-form").addEventListener("submit", saveAccount);
  $("#accounts-list").addEventListener("click", e => { const edit = e.target.closest("[data-account-edit]"); const del = e.target.closest("[data-account-delete]"); if (edit) editAccount(edit.dataset.accountEdit); if (del) deleteAccount(del.dataset.accountDelete); });
  $("#categories-list").addEventListener("click", e => { const b = e.target.closest("[data-category-delete]"); if (b) deleteCategory(b.dataset.categoryDelete); });
  document.querySelectorAll("[data-page]").forEach(b => b.addEventListener("click", () => navigate(b.dataset.page)));
  document.addEventListener("click", e => {
    if (!e.target.closest(".account-menu")) {
      const menu = $("#account-options");
      if (menu) { menu.hidden = true; $("#account-trigger").setAttribute("aria-expanded", "false"); }
    }
    if (e.target.closest("[data-open-login]")) openModal("#login-modal");
    if (e.target.closest("[data-open-register]")) openModal("#register-modal");
    if (e.target.closest("[data-open-profile]")) { if (state.user) { $("#profile-form").elements.telefone.value = state.user.telefone || ""; openModal("#profile-modal"); } }
    if (e.target.closest("[data-open-item]")) {
      if (state.user) openModal("#item-modal");
      else { openModal("#login-modal"); toast("Faça login para cadastrar um objeto."); }
    }
    if (e.target.closest("[data-close]")) closeModals();
    if (e.target.classList.contains("modal-backdrop")) closeModals();
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      if ($("#result-modal").classList.contains("show")) { $("#result-modal").classList.remove("show"); return; }
      const menu = $("#account-options");
      if (menu && !menu.hidden) { menu.hidden = true; $("#account-trigger").setAttribute("aria-expanded", "false"); $("#account-trigger").focus(); }
      else closeModals();
    }
  });
  $("#login-form").addEventListener("submit", login);
  $("#register-form").addEventListener("submit", register);
  $("#profile-form").addEventListener("submit", saveProfile);
  $("#password-form").addEventListener("submit", changePassword);
  $("#item-form").addEventListener("submit", createItem);
  $("#edit-form").addEventListener("submit", saveEdit);
  $("#search-btn").addEventListener("click", loadItems);
  $("#search").addEventListener("keydown", e => { if (e.key === "Enter") loadItems(); });
  $("#category").addEventListener("change", loadItems); $("#type").addEventListener("change", loadItems); $("#status-filter").addEventListener("change", loadItems); $("#date-filter").addEventListener("change", loadItems);
  try { const data = await api("/api/auth/me"); state.user = data.user; } catch {}
  renderNav(); await loadCategories(); await loadItems();
}
init();
