require("dotenv").config();

const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs/promises");
const crypto = require("crypto");
const multer = require("multer");

const app = express();
const port = Number(process.env.PORT || 3000);
const usersTable = process.env.USERS_TABLE || "usuarios";

// Identificadores SQL não podem ser parâmetros; esta validação evita injeção no nome da tabela.
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(usersTable)) {
  throw new Error("USERS_TABLE contém caracteres inválidos.");
}

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

app.use(session({
  store: new PgSession({ pool, tableName: "session", createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || "desenvolvimento-troque-esta-chave",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 8
  }
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Muitas tentativas. Aguarde alguns minutos e tente novamente." }
});

const publicDir = path.join(__dirname, "public");
const uploadDir = path.join(publicDir, "uploads");
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 }, fileFilter: (_req, file, cb) => {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) return cb(new Error("Envie uma foto JPG, PNG ou WebP."));
  cb(null, true);
}});
function imageExtension(buf) {
  if (buf.length >= 3 && buf.subarray(0,3).equals(Buffer.from([0xff,0xd8,0xff]))) return "jpg";
  if (buf.length >= 8 && buf.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "png";
  if (buf.length >= 12 && buf.toString("ascii",0,4)==="RIFF" && buf.toString("ascii",8,12)==="WEBP") return "webp";
  return null;
}
async function savePhoto(file) {
  if (!file) return null;
  const ext = imageExtension(file.buffer);
  if (!ext) { const err = new Error("O arquivo não é uma imagem JPG, PNG ou WebP válida."); err.status = 400; throw err; }
  await fs.mkdir(uploadDir, { recursive: true });
  const name = `${crypto.randomUUID()}.${ext}`;
  await fs.writeFile(path.join(uploadDir, name), file.buffer, { flag: "wx" });
  return `/uploads/${name}`;
}
function uploadPhoto(req,res,next) {
  upload.single("foto")(req,res,err => {
    if (err) return res.status(400).json({error: err.code === "LIMIT_FILE_SIZE" ? "A foto deve ter no máximo 5 MB." : err.message});
    next();
  });
}

app.use(express.static(publicDir));

function normalizeRole(value) {
  const role = String(value || "").trim().toLowerCase();
  if (["admin", "administrador", "administradora"].includes(role)) return "administrador";
  if (["servidor", "server"].includes(role)) return "servidor";
  return "aluno";
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return /^[1-9][0-9]{9,10}$/.test(digits) ? digits : null;
}

function publicUser(user) {
  return { nome: user.nome, matricula: user.matricula, role: normalizeRole(user.role), telefone: user.telefone || null };
}

// Atualiza a permissão a cada chamada à API: mudanças de cargo passam a valer imediatamente.
app.use("/api", async (req, res, next) => {
  if (!req.session.user) return next();
  try {
    const current = await pool.query(`SELECT nome, matricula, role, telefone FROM "${usersTable}" WHERE matricula=$1`, [req.session.user.matricula]);
    if (!current.rowCount) {
      req.session.user = null;
      return res.status(401).json({ error: "Sua conta não está mais disponível. Faça login novamente." });
    }
    req.session.user = publicUser(current.rows[0]);
    next();
  } catch (error) {
    console.error("Verificar sessão:", error.message);
    res.status(500).json({ error: "Não foi possível verificar a sessão." });
  }
});

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Faça login para continuar." });
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ error: "Faça login para continuar." });
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).json({ error: "Você não tem permissão para esta ação." });
    }
    next();
  };
}

async function findUserByMatricula(matricula) {
  const sql = `SELECT nome, matricula, senha, role, telefone
               FROM "${usersTable}" WHERE matricula = $1 LIMIT 1`;
  const result = await pool.query(sql, [matricula]);
  return result.rows[0] || null;
}

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, database: "connected" });
  } catch {
    res.status(503).json({ ok: false, database: "disconnected" });
  }
});

const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Muitas tentativas de cadastro. Aguarde 15 minutos." }
});

app.post("/api/auth/register", registerLimiter, async (req, res) => {
  const nome = String(req.body.nome || "").trim().replace(/\s+/g, " ");
  const matricula = String(req.body.matricula || "").trim();
  const senha = String(req.body.senha || "");
  const telefone = normalizePhone(req.body.telefone);
  if (!telefone) return res.status(400).json({ error: "Informe um WhatsApp válido com DDD (10 ou 11 dígitos)." });
  if (nome.length < 3 || nome.length > 120) return res.status(400).json({ error: "Informe um nome entre 3 e 120 caracteres." });
  if (!/^[0-9]{5,20}$/.test(matricula)) return res.status(400).json({ error: "A matrícula deve conter de 5 a 20 dígitos." });
  if (senha.length < 8 || Buffer.byteLength(senha, "utf8") > 72) return res.status(400).json({ error: "Use uma senha de 8 a 72 bytes." });
  try {
    // Compatível com a tabela legada, que pode ter a coluna tipo_usuario (inclusive ENUM).
    const columns = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = $1`, [usersTable]
    );
    const names = new Set(columns.rows.map(row => row.column_name));
    if (!["nome", "matricula", "senha", "role", "telefone"].every(name => names.has(name))) {
      return res.status(503).json({ error: "Tabela de usuários incompleta. Execute a migração SQL indicada no README." });
    }
    const fields = ["nome", "matricula", "senha", "role", "telefone"];
    const values = [nome, matricula, await bcrypt.hash(senha, 12), "aluno", telefone];
    if (names.has("tipo_usuario")) {
      fields.push("tipo_usuario");
      values.push("aluno");
    }
    const placeholders = values.map((_, index) => `$${index + 1}`).join(", ");
    const sql = `INSERT INTO "${usersTable}" (${fields.map(field => `"${field}"`).join(", ")})
                 VALUES (${placeholders}) RETURNING nome, matricula, role`;
    const result = await pool.query(sql, values);
    res.status(201).json({ message: "Conta criada! Agora entre com sua matrícula e senha.", user: result.rows[0] });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "Esta matrícula já está cadastrada." });
    console.error("Erro no cadastro:", error.message);
    res.status(500).json({ error: "Não foi possível criar a conta. Confira a estrutura da tabela de usuários." });
  }
});

app.post("/api/auth/login", loginLimiter, async (req, res) => {
  const matricula = String(req.body.matricula || "").trim();
  const senha = String(req.body.senha || "");
  if (!matricula || !senha) return res.status(400).json({ error: "Informe matrícula e senha." });

  try {
    const user = await findUserByMatricula(matricula);
    if (!user) return res.status(401).json({ error: "Matrícula ou senha incorreta." });

    let valid = false;
    const stored = String(user.senha || "");
    if (/^\$2[aby]\$/.test(stored)) {
      valid = await bcrypt.compare(senha, stored);
    } else {
      // Compatibilidade temporária com senhas antigas em texto puro: atualiza para bcrypt após login válido.
      valid = senha === stored;
      if (valid) {
        const hash = await bcrypt.hash(senha, 12);
        await pool.query(`UPDATE "${usersTable}" SET senha = $1 WHERE matricula = $2`, [hash, matricula]);
      }
    }

    if (!valid) return res.status(401).json({ error: "Matrícula ou senha incorreta." });

    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: "Não foi possível iniciar a sessão." });
      req.session.user = publicUser(user);
      req.session.save((saveErr) => {
        if (saveErr) return res.status(500).json({ error: "Não foi possível salvar a sessão." });
        res.json({ user: req.session.user });
      });
    });
  } catch (error) {
    console.error("Erro no login:", error.message);
    res.status(500).json({ error: "Erro ao consultar o banco. Confira a configuração da tabela de usuários." });
  }
});

app.post("/api/auth/logout", requireAuth, (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: "Não foi possível encerrar a sessão." });
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

app.get("/api/auth/me", async (req, res) => {
  if (!req.session.user) return res.json({ user: null });
  try {
    const user = await findUserByMatricula(req.session.user.matricula);
    if (!user) return res.json({ user: null });
    req.session.user = publicUser(user);
    res.json({ user: req.session.user });
  } catch (error) {
    console.error("Erro ao carregar perfil:", error.message);
    res.status(500).json({ error: "Não foi possível carregar o perfil." });
  }
});

app.put("/api/profile", requireAuth, async (req, res) => {
  const telefone = normalizePhone(req.body.telefone);
  if (!telefone) return res.status(400).json({ error: "Informe um WhatsApp válido com DDD." });
  try {
    const result = await pool.query(`UPDATE "${usersTable}" SET telefone=$1 WHERE matricula=$2 RETURNING nome, matricula, role, telefone`, [telefone, req.session.user.matricula]);
    if (!result.rowCount) return res.status(404).json({ error: "Conta não encontrada." });
    req.session.user = publicUser(result.rows[0]);
    res.json({ user: req.session.user, message: "Número atualizado." });
  } catch (error) {
    console.error("Erro ao atualizar perfil:", error.message);
    res.status(500).json({ error: "Não foi possível atualizar o número." });
  }
});

const passwordLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: "draft-7", legacyHeaders: false });
app.put("/api/profile/password", requireAuth, passwordLimiter, async (req, res) => {
  const atual = String(req.body.senha_atual || "");
  const nova = String(req.body.nova_senha || "");
  if (nova.length < 8 || Buffer.byteLength(nova, "utf8") > 72) return res.status(400).json({ error: "A nova senha deve ter de 8 a 72 bytes." });
  if (atual === nova) return res.status(400).json({ error: "A nova senha deve ser diferente da atual." });
  try {
    const user = await findUserByMatricula(req.session.user.matricula);
    if (!user) return res.status(404).json({ error: "Conta não encontrada." });
    const stored = String(user.senha || "");
    const valid = /^\$2[aby]\$/.test(stored) ? await bcrypt.compare(atual, stored) : atual === stored;
    if (!valid) return res.status(401).json({ error: "Senha atual incorreta." });
    const hash = await bcrypt.hash(nova, 12);
    await pool.query(`UPDATE "${usersTable}" SET senha=$1 WHERE matricula=$2`, [hash, req.session.user.matricula]);
    res.json({ message: "Senha alterada com sucesso." });
  } catch (error) {
    console.error("Erro ao alterar senha:", error.message);
    res.status(500).json({ error: "Não foi possível alterar a senha." });
  }
});

// Administração de contas: nunca consulta ou retorna a coluna de senhas.
async function requireCurrentAdmin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Faça login para continuar." });
  try {
    const result = await pool.query(`SELECT role FROM "${usersTable}" WHERE matricula=$1`, [req.session.user.matricula]);
    if (!result.rowCount || normalizeRole(result.rows[0].role) !== "administrador")
      return res.status(403).json({ error: "Acesso exclusivo de administradores." });
    next();
  } catch (error) {
    console.error("Autorização de contas:", error.message);
    res.status(500).json({ error: "Não foi possível verificar sua permissão." });
  }
}

app.get("/api/admin/users", requireCurrentAdmin, async (_req, res) => {
  try {
    const result = await pool.query(`SELECT nome, matricula, telefone, role FROM "${usersTable}" ORDER BY nome, matricula`);
    res.set("Cache-Control", "no-store");
    res.json({ users: result.rows });
  } catch (error) {
    console.error("Listar contas:", error.message);
    res.status(500).json({ error: "Não foi possível listar as contas." });
  }
});

app.put("/api/admin/users/:matricula", requireCurrentAdmin, async (req, res) => {
  const antiga = String(req.params.matricula || "");
  const matricula = String(req.body.matricula || "").trim();
  const nome = String(req.body.nome || "").trim().replace(/\s+/g, " ");
  const telefone = normalizePhone(req.body.telefone);
  const novoCargo = String(req.body.role || "").trim().toLowerCase();
  if (!["aluno", "servidor"].includes(novoCargo))
    return res.status(400).json({ error: "Escolha Aluno ou Servidor." });
  if (nome.length < 3 || nome.length > 120 || !/^[0-9]{5,20}$/.test(matricula) || !telefone)
    return res.status(400).json({ error: "Informe nome (3–120 caracteres), matrícula (5–20 dígitos) e WhatsApp válido com DDD." });
  if (antiga === String(req.session.user.matricula) && matricula !== antiga)
    return res.status(400).json({ error: "Não altere sua própria matrícula pelo gerenciamento. Isso encerraria a identificação da sessão." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(`SELECT matricula, role FROM "${usersTable}" WHERE matricula=$1 FOR UPDATE`, [antiga]);
    if (!existing.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Conta não encontrada." }); }
    if (normalizeRole(existing.rows[0].role) === "administrador") {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "O cargo de contas administradoras não pode ser alterado nesta tela." });
    }
    if (matricula !== antiga) {
      // Os anúncios utilizam matrícula sem chave estrangeira; mantém-se a autoria ao renomeá-la.
      await client.query("UPDATE itens SET usuario_matricula=$1 WHERE usuario_matricula=$2", [matricula, antiga]);
    }
    const result = await client.query(`UPDATE "${usersTable}" SET nome=$1, matricula=$2, telefone=$3, role=$4 WHERE matricula=$5 RETURNING nome, matricula, telefone, role`, [nome, matricula, telefone, novoCargo, antiga]);
    await client.query("COMMIT");
    if (antiga === String(req.session.user.matricula)) req.session.user = { ...req.session.user, nome, telefone };
    res.json({ user: result.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23505") return res.status(409).json({ error: "Essa matrícula já está cadastrada." });
    console.error("Editar conta:", error.message);
    res.status(500).json({ error: "Não foi possível atualizar a conta." });
  } finally { client.release(); }
});

app.delete("/api/admin/users/:matricula", requireCurrentAdmin, async (req, res) => {
  const matricula = String(req.params.matricula || "");
  if (matricula === String(req.session.user.matricula))
    return res.status(400).json({ error: "Você não pode excluir sua própria conta." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(`SELECT matricula FROM "${usersTable}" WHERE matricula=$1 FOR UPDATE`, [matricula]);
    if (!existing.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Conta não encontrada." }); }
    // Exclui também os anúncios para não deixar anúncios sem responsável/WhatsApp.
    const items = await client.query("DELETE FROM itens WHERE usuario_matricula=$1 RETURNING id", [matricula]);
    await client.query(`DELETE FROM "${usersTable}" WHERE matricula=$1`, [matricula]);
    await client.query("COMMIT");
    res.json({ ok: true, deletedItems: items.rowCount });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Excluir conta:", error.message);
    res.status(500).json({ error: "Não foi possível excluir a conta." });
  } finally { client.release(); }
});

// Categorias administradas no banco, com autorização verificada no servidor.
app.get("/api/categories", async (_req, res) => {
  try {
    const result = await pool.query("SELECT id, nome FROM categorias ORDER BY nome");
    res.json({ categories: result.rows });
  } catch (error) { console.error("Categorias:", error.message); res.status(500).json({ error: "Execute sql/migracao_categorias.sql no PostgreSQL." }); }
});
app.post("/api/categories", requireRole("administrador", "servidor"), async (req, res) => {
  const nome = String(req.body?.nome || "").trim().replace(/\s+/g, " ");
  if (nome.length < 2 || nome.length > 60) return res.status(400).json({ error: "A categoria deve ter entre 2 e 60 caracteres." });
  try {
    const result = await pool.query("INSERT INTO categorias(nome) VALUES ($1) RETURNING id, nome", [nome]);
    res.status(201).json({ category: result.rows[0] });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "Esta categoria já existe." });
    console.error("Criar categoria:", error.message); res.status(500).json({ error: "Não foi possível criar a categoria." });
  }
});
app.delete("/api/categories/:id", requireRole("administrador", "servidor"), async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "Categoria inválida." });
  try {
    const result = await pool.query("DELETE FROM categorias c WHERE c.id=$1 AND NOT EXISTS (SELECT 1 FROM itens i WHERE i.categoria=c.nome) RETURNING c.id", [req.params.id]);
    if (!result.rowCount) return res.status(409).json({ error: "Categoria não encontrada ou já utilizada por anúncios. Mova os anúncios para outra categoria antes de excluí-la." });
    res.json({ ok: true });
  } catch (error) { console.error("Excluir categoria:", error.message); res.status(500).json({ error: "Não foi possível excluir a categoria." }); }
});
async function validCategory(nome) {
  const result = await pool.query("SELECT 1 FROM categorias WHERE nome=$1", [nome]);
  return result.rowCount > 0;
}

app.get("/api/items", async (req, res) => {
  const { busca = "", categoria = "", tipo = "" } = req.query;
  const values = [];
  const where = [];
  if (busca) {
    values.push(`%${String(busca).slice(0, 100)}%`);
    where.push(`(i.titulo ILIKE $${values.length} OR i.descricao ILIKE $${values.length} OR i.local ILIKE $${values.length})`);
  }
  if (categoria) {
    values.push(String(categoria));
    where.push(`i.categoria = $${values.length}`);
  }
  if (tipo) {
    values.push(String(tipo));
    where.push(`i.tipo = $${values.length}`);
  }

  try {
    const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const result = await pool.query(
      `SELECT i.id, i.titulo, i.descricao, i.categoria, i.tipo, i.local, i.status, i.imagem_url,
              i.criado_em, i.usuario_matricula, u.nome AS contato_nome, u.telefone AS contato_telefone
       FROM itens i LEFT JOIN "${usersTable}" u ON u.matricula = i.usuario_matricula
       ${filter} ORDER BY i.criado_em DESC`,
      values
    );
    const delivered = await pool.query("SELECT COUNT(*)::int AS total FROM itens WHERE status = 'entregue'");
    res.json({ items: result.rows, delivered: delivered.rows[0].total });
  } catch (error) {
    console.error("Erro ao listar itens:", error.message);
    res.status(500).json({ error: "Não foi possível carregar os anúncios. Execute sql/schema.sql." });
  }
});

app.post("/api/items", requireRole("administrador", "aluno"), uploadPhoto, async (req, res) => {
  const { titulo, descricao, categoria, tipo, local } = req.body;
  if (!titulo || !descricao || !categoria || !tipo || !local) {
    return res.status(400).json({ error: "Preencha título, descrição, categoria, tipo e local." });
  }
  if (!["perdido", "encontrado"].includes(tipo)) return res.status(400).json({ error: "Tipo inválido." });

  let imagem_url = null;
  try {
    if (!await validCategory(categoria)) return res.status(400).json({ error: "Selecione uma categoria válida." });
    imagem_url = await savePhoto(req.file);
    const result = await pool.query(
      `INSERT INTO itens (titulo, descricao, categoria, tipo, local, imagem_url, usuario_matricula)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [titulo, descricao, categoria, tipo, local, imagem_url || null, req.session.user.matricula]
    );
    res.status(201).json({ item: result.rows[0] });
  } catch (error) {
    if (imagem_url) await fs.unlink(path.join(publicDir, imagem_url)).catch(() => {});
    console.error("Erro ao cadastrar item:", error.message);
    res.status(500).json({ error: "Não foi possível cadastrar o anúncio." });
  }
});

app.put("/api/items/:id", requireRole("administrador", "servidor"), uploadPhoto, async (req, res) => {
  const { titulo, descricao, categoria, tipo, local, status } = req.body;
  if (!["perdido", "encontrado"].includes(tipo) || !["aberto", "entregue"].includes(status)) {
    return res.status(400).json({ error: "Tipo ou situação inválida." });
  }
  let imagem_url = null;
  try {
    if (!await validCategory(categoria)) return res.status(400).json({ error: "Selecione uma categoria válida." });
    imagem_url = await savePhoto(req.file);
    const result = await pool.query(
      `UPDATE itens SET titulo=$1, descricao=$2, categoria=$3, tipo=$4, local=$5,
       status=$6, imagem_url=COALESCE($7, imagem_url) WHERE id=$8 RETURNING *`,
      [titulo, descricao, categoria, tipo, local, status, imagem_url, req.params.id]
    );
    if (!result.rowCount) { if (imagem_url) await fs.unlink(path.join(publicDir, imagem_url)).catch(() => {}); return res.status(404).json({ error: "Anúncio não encontrado." }); }
    res.json({ item: result.rows[0] });
  } catch (error) {
    if (imagem_url) await fs.unlink(path.join(publicDir, imagem_url)).catch(() => {});
    console.error("Erro ao editar item:", error.message);
    res.status(500).json({ error: "Não foi possível editar o anúncio." });
  }
});

app.delete("/api/items/:id", requireAuth, async (req, res) => {
  try {
    const result = await pool.query("SELECT id, usuario_matricula FROM itens WHERE id=$1", [req.params.id]);
    const item = result.rows[0];
    if (!item) return res.status(404).json({ error: "Anúncio não encontrado." });

    const role = req.session.user.role;
    const isOwner = String(item.usuario_matricula) === String(req.session.user.matricula);
    if (role === "aluno" && !isOwner) {
      return res.status(403).json({ error: "Alunos só podem excluir os próprios anúncios." });
    }
    await pool.query("DELETE FROM itens WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (error) {
    console.error("Erro ao excluir item:", error.message);
    res.status(500).json({ error: "Não foi possível excluir o anúncio." });
  }
});

app.get("*", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));

app.listen(port, () => console.log(`IFRN Achados & Perdidos disponível em http://localhost:${port}`));
