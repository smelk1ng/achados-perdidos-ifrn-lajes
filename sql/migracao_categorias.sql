CREATE TABLE IF NOT EXISTS categorias (
 id BIGSERIAL PRIMARY KEY,
 nome VARCHAR(60) NOT NULL UNIQUE
);
INSERT INTO categorias(nome) VALUES
 ('Material escolar'),('Eletrônicos'),('Acessórios'),('Documentos'),('Vestuário'),('Outros')
ON CONFLICT (nome) DO NOTHING;

INSERT INTO categorias(nome)
SELECT DISTINCT TRIM(categoria) FROM itens WHERE categoria IS NOT NULL AND LENGTH(TRIM(categoria)) BETWEEN 2 AND 60
ON CONFLICT (nome) DO NOTHING;
