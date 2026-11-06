CREATE TABLE IF NOT EXISTS usuarios (
  matricula VARCHAR(20) PRIMARY KEY,
  nome VARCHAR(120) NOT NULL,
  senha TEXT NOT NULL,
  role VARCHAR(30) NOT NULL DEFAULT 'aluno',
  telefone VARCHAR(11),
  criado_em TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS role VARCHAR(30) DEFAULT 'aluno';
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS telefone VARCHAR(11);
CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_matricula_unique ON usuarios (matricula);

CREATE TABLE IF NOT EXISTS itens (
  id BIGSERIAL PRIMARY KEY,
  titulo VARCHAR(120) NOT NULL,
  descricao TEXT NOT NULL,
  categoria VARCHAR(60) NOT NULL,
  tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('perdido', 'encontrado')),
  local VARCHAR(120) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto', 'entregue')),
  imagem_url TEXT,
  usuario_matricula VARCHAR(20) NOT NULL,
  criado_em TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_itens_criado_em ON itens (criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_itens_status ON itens (status);
CREATE INDEX IF NOT EXISTS idx_itens_usuario ON itens (usuario_matricula);
