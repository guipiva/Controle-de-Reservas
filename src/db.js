// =============================================================================
// db.js — banco de dados.
//
// Usa o SQLite que já vem no Node (módulo node:sqlite, Node 22.13 ou mais novo),
// então o banco é só um arquivo: data/reservas.db.
// Aqui ficam o script de criação das tabelas (SCHEMA) e a função de transação.
// Datas e horas são gravadas em UTC no formato ISO 8601 (RNF-06); a tela converte
// para o horário local na hora de mostrar.
// =============================================================================
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

// Script de criação do banco (entregável "script de criação" da seção 13).
// Os CHECK garantem no próprio banco algumas regras, como fim > início (RN-03).
const SCHEMA = `
PRAGMA foreign_keys = ON;

-- Perfis de acesso (Solicitante, Gestor de espaços, Resp. equipamentos, Admin).
CREATE TABLE IF NOT EXISTS perfil (
  id        TEXT PRIMARY KEY,           -- SOLICITANTE, GESTOR_ESPACOS, RESP_EQUIPAMENTOS, ADMIN
  nome      TEXT NOT NULL,
  permissoes TEXT NOT NULL              -- lista separada por vírgula
);

-- Usuários. A senha é guardada só como hash (nunca o texto da senha).
CREATE TABLE IF NOT EXISTS usuario (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  nome       TEXT NOT NULL,
  email      TEXT NOT NULL UNIQUE,
  senha_hash TEXT NOT NULL,
  perfil_id  TEXT NOT NULL REFERENCES perfil(id),
  ativo      INTEGER NOT NULL DEFAULT 1
);

-- Sessões de login: o token fica no cookie do navegador e expira em 8 horas.
CREATE TABLE IF NOT EXISTS sessao (
  token      TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuario(id),
  expira_em  TEXT NOT NULL
);

-- Regras configuráveis pela unidade (horário de funcionamento, antecedência, folga...).
CREATE TABLE IF NOT EXISTS parametro (
  chave     TEXT PRIMARY KEY,
  valor     TEXT NOT NULL,
  descricao TEXT
);

-- Espaços reserváveis (auditório, salas, laboratórios) e a capacidade aprovada.
CREATE TABLE IF NOT EXISTS espaco (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nome        TEXT NOT NULL,
  localizacao TEXT,
  capacidade  INTEGER NOT NULL CHECK (capacidade > 0),
  ativo       INTEGER NOT NULL DEFAULT 1
);

-- Categorias de equipamento. INDIVIDUAL = cada item tem patrimônio; QUANTIDADE = estoque (ex.: cabos).
CREATE TABLE IF NOT EXISTS categoria (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  nome           TEXT NOT NULL UNIQUE,
  controle       TEXT NOT NULL CHECK (controle IN ('INDIVIDUAL','QUANTIDADE')),
  exige_retirada INTEGER NOT NULL DEFAULT 1
);

-- Equipamentos. Não existe campo "disponível": a disponibilidade é calculada por período.
CREATE TABLE IF NOT EXISTS equipamento (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo_patrimonio TEXT NOT NULL UNIQUE,
  nome              TEXT NOT NULL,
  categoria_id      INTEGER NOT NULL REFERENCES categoria(id),
  situacao          TEXT NOT NULL DEFAULT 'DISPONIVEL'
                    CHECK (situacao IN ('DISPONIVEL','MANUTENCAO','AVARIADO','INATIVO')),
  localizacao       TEXT,
  quantidade_total  INTEGER NOT NULL DEFAULT 1 CHECK (quantidade_total >= 0)
);

-- Atividade extracurricular (palestra, oficina...). É opcional: dá para pedir só um equipamento.
CREATE TABLE IF NOT EXISTS atividade (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  titulo           TEXT NOT NULL,
  tipo             TEXT NOT NULL,
  descricao        TEXT NOT NULL,
  responsavel_id   INTEGER NOT NULL REFERENCES usuario(id),
  publico_alvo     TEXT NOT NULL,
  publico_estimado INTEGER NOT NULL DEFAULT 0 CHECK (publico_estimado >= 0),
  inicio           TEXT NOT NULL,
  fim              TEXT NOT NULL,
  CHECK (fim > inicio)
);

-- O pedido em si. O status segue o ciclo: RASCUNHO → PENDENTE → APROVADA/REJEITADA/EM_AJUSTES → CONCLUIDA/CANCELADA.
CREATE TABLE IF NOT EXISTS solicitacao (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  atividade_id   INTEGER REFERENCES atividade(id),
  solicitante_id INTEGER NOT NULL REFERENCES usuario(id),
  status         TEXT NOT NULL DEFAULT 'RASCUNHO'
                 CHECK (status IN ('RASCUNHO','PENDENTE','EM_AJUSTES','APROVADA','REJEITADA','CANCELADA','CONCLUIDA')),
  inicio         TEXT NOT NULL,
  fim            TEXT NOT NULL,
  motivo         TEXT,                  -- finalidade/observações do pedido
  excepcional    INTEGER NOT NULL DEFAULT 0,  -- fora do horário/antecedência (RN-07)
  criada_em      TEXT NOT NULL,
  atualizada_em  TEXT NOT NULL,
  CHECK (fim > inicio)
);

-- Cada espaço pedido numa solicitação, com status próprio (RN-18).
CREATE TABLE IF NOT EXISTS reserva_espaco (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  solicitacao_id INTEGER NOT NULL REFERENCES solicitacao(id),
  espaco_id      INTEGER NOT NULL REFERENCES espaco(id),
  inicio         TEXT NOT NULL,
  fim            TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'PENDENTE'
                 CHECK (status IN ('PENDENTE','APROVADA','REJEITADA','CANCELADA')),
  CHECK (fim > inicio)
);

-- Cada equipamento pedido, com status de aprovação e situação de retirada.
CREATE TABLE IF NOT EXISTS reserva_equipamento (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  solicitacao_id INTEGER NOT NULL REFERENCES solicitacao(id),
  equipamento_id INTEGER NOT NULL REFERENCES equipamento(id),
  inicio         TEXT NOT NULL,
  fim            TEXT NOT NULL,
  quantidade     INTEGER NOT NULL DEFAULT 1 CHECK (quantidade > 0),
  status         TEXT NOT NULL DEFAULT 'PENDENTE'
                 CHECK (status IN ('PENDENTE','APROVADA','REJEITADA','CANCELADA')),
  retirada       TEXT NOT NULL DEFAULT 'NAO_RETIRADO'
                 CHECK (retirada IN ('NAO_RETIRADO','RETIRADO','DEVOLVIDO')),
  CHECK (fim > inicio)
);

-- Entregas e devoluções de equipamentos (RN-15 e RN-16).
CREATE TABLE IF NOT EXISTS movimentacao (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  reserva_equipamento_id INTEGER NOT NULL REFERENCES reserva_equipamento(id),
  tipo                   TEXT NOT NULL CHECK (tipo IN ('ENTREGA','DEVOLUCAO')),
  responsavel_id         INTEGER NOT NULL REFERENCES usuario(id),  -- quem registrou (balcão)
  pessoa                 TEXT NOT NULL,                            -- quem retirou / devolveu
  data_hora              TEXT NOT NULL,
  condicao               TEXT NOT NULL CHECK (condicao IN ('BOA','AVARIADO')),
  atraso                 INTEGER NOT NULL DEFAULT 0,
  observacao             TEXT
);

-- Histórico de cada solicitação: quem fez o quê, quando e por quê (RN-08, RF-12).
CREATE TABLE IF NOT EXISTS historico (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  solicitacao_id INTEGER NOT NULL REFERENCES solicitacao(id),
  ator_id        INTEGER NOT NULL REFERENCES usuario(id),
  acao           TEXT NOT NULL,
  justificativa  TEXT,
  data_hora      TEXT NOT NULL
);

-- Períodos em que um espaço ou equipamento não pode ser reservado (manutenção etc.).
CREATE TABLE IF NOT EXISTS bloqueio (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo_recurso TEXT NOT NULL CHECK (tipo_recurso IN ('ESPACO','EQUIPAMENTO')),
  recurso_id   INTEGER NOT NULL,
  inicio       TEXT NOT NULL,
  fim          TEXT NOT NULL,
  motivo       TEXT NOT NULL,
  criado_por   INTEGER NOT NULL REFERENCES usuario(id),
  CHECK (fim > inicio)
);

-- Notificações exibidas no sino da tela (RF-10).
CREATE TABLE IF NOT EXISTS notificacao (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id     INTEGER NOT NULL REFERENCES usuario(id),
  solicitacao_id INTEGER REFERENCES solicitacao(id),
  mensagem       TEXT NOT NULL,
  lida           INTEGER NOT NULL DEFAULT 0,
  criada_em      TEXT NOT NULL
);

-- Registro de ações administrativas e logins, para auditoria.
CREATE TABLE IF NOT EXISTS log_auditoria (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER,
  acao       TEXT NOT NULL,
  detalhe    TEXT,
  data_hora  TEXT NOT NULL
);

-- Índices: aceleram as buscas de conflito por recurso e período.
CREATE INDEX IF NOT EXISTS ix_res_esp ON reserva_espaco(espaco_id, inicio, fim);
CREATE INDEX IF NOT EXISTS ix_res_eq  ON reserva_equipamento(equipamento_id, inicio, fim);
CREATE INDEX IF NOT EXISTS ix_bloq    ON bloqueio(tipo_recurso, recurso_id, inicio, fim);
CREATE INDEX IF NOT EXISTS ix_sol     ON solicitacao(solicitante_id, status);
`;

/**
 * Abre (ou cria) o arquivo do banco SQLite e garante que as tabelas existem.
 * - Se nada for informado, usa data/reservas.db (criado automaticamente).
 * - ':memory:' cria um banco temporário na memória, usado nos testes.
 * O "CREATE TABLE IF NOT EXISTS" do SCHEMA faz com que rodar de novo não apague nada.
 */
function abrirBanco(arquivo) {
  const caminho = arquivo || process.env.DB_FILE || path.join(__dirname, '..', 'data', 'reservas.db');
  if (caminho !== ':memory:') fs.mkdirSync(path.dirname(caminho), { recursive: true });
  const db = new DatabaseSync(caminho);
  db.exec(SCHEMA);
  return db;
}

/**
 * Executa várias operações no banco como se fossem UMA só (RNF-05).
 * BEGIN IMMEDIATE trava o banco para escrita até o COMMIT; assim, duas aprovações
 * ao mesmo tempo não conseguem alocar o mesmo recurso (critério CA-12).
 * Se qualquer passo lançar erro, o ROLLBACK desfaz tudo o que foi feito.
 */
function transacao(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { abrirBanco, transacao, SCHEMA };
