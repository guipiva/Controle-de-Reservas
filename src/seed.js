// =============================================================================
// seed.js — dados de demonstração FICTÍCIOS (usuários, espaços, equipamentos, eventos).
// Roda sozinho na primeira vez que o servidor sobe (banco vazio).
// "npm run seed" apaga o banco e recria tudo do zero (bom antes de apresentar).
// =============================================================================
const fs = require('node:fs');
const path = require('node:path');
const { abrirBanco } = require('./db');
const { hashSenha } = require('./util');

const SENHA_DEMO = 'senha123';

/**
 * Cadastra os dados iniciais no banco:
 * - os 4 perfis e os parâmetros de política (valores de teste, não oficiais);
 * - 5 usuários de demonstração (todos com a senha "senha123");
 * - 4 espaços, 3 categorias e 7 equipamentos (1 projetor já em manutenção, para o CA-04);
 * - se comExemplos = true, uma palestra aprovada daqui a 3 dias (14h–16h no Auditório)
 *   e uma oficina pendente, para a agenda não começar vazia.
 * Os testes chamam com comExemplos = false para começar sem reservas.
 */
function popular(db, { comExemplos = true } = {}) {
  const ins = (sql, ...a) => Number(db.prepare(sql).run(...a).lastInsertRowid);

  const perfis = [
    ['SOLICITANTE', 'Solicitante (docente, servidor ou aluno autorizado)', 'solicitar'],
    ['GESTOR_ESPACOS', 'Gestor de espaços / secretaria', 'solicitar,aprovar_espaco,gerir_espacos,bloquear,ver_tudo,relatorios'],
    ['RESP_EQUIPAMENTOS', 'Responsável por equipamentos', 'solicitar,aprovar_equipamento,gerir_equipamentos,movimentar,bloquear,ver_tudo,relatorios'],
    ['ADMIN', 'Administrador', 'todas'],
  ];
  for (const p of perfis) db.prepare('INSERT OR IGNORE INTO perfil (id, nome, permissoes) VALUES (?,?,?)').run(...p);

  // Valores de teste — NÃO são normas oficiais da unidade (premissa do documento).
  const params = [
    ['intervalo_preparacao_min', '0', 'Minutos de montagem/desmontagem entre reservas do mesmo espaço'],
    ['antecedencia_min_horas', '24', 'Antecedência mínima (horas) para solicitar sem aprovação excepcional'],
    ['hora_abertura', '07:00', 'Início do horário de funcionamento'],
    ['hora_fechamento', '23:00', 'Fim do horário de funcionamento'],
    ['politica_fora_regra', 'EXCECAO', 'EXCECAO = permite com aprovação excepcional justificada; BLOQUEAR = impede o envio'],
    ['permitir_autoaprovacao', '0', '1 = gestor pode decidir a própria solicitação; 0 = vedado'],
    ['fuso', 'America/Sao_Paulo', 'Fuso horário usado nas regras de horário'],
  ];
  for (const p of params) db.prepare('INSERT OR IGNORE INTO parametro (chave, valor, descricao) VALUES (?,?,?)').run(...p);

  const h = hashSenha(SENHA_DEMO);
  const usuarios = [
    ['Ana Souza (docente)', 'ana@fatec.demo', 'SOLICITANTE'],
    ['Bruno Lima (aluno)', 'bruno@fatec.demo', 'SOLICITANTE'],
    ['Carla Mendes (secretaria)', 'carla@fatec.demo', 'GESTOR_ESPACOS'],
    ['Diego Rocha (equipamentos)', 'diego@fatec.demo', 'RESP_EQUIPAMENTOS'],
    ['Admin do Sistema', 'admin@fatec.demo', 'ADMIN'],
  ];
  const uid = {};
  for (const [nome, email, perfil] of usuarios) {
    uid[email] = ins('INSERT INTO usuario (nome, email, senha_hash, perfil_id) VALUES (?,?,?,?)', nome, email, h, perfil);
  }

  const auditorio = ins('INSERT INTO espaco (nome, localizacao, capacidade) VALUES (?,?,?)', 'Auditório', 'Bloco A - térreo', 120);
  ins('INSERT INTO espaco (nome, localizacao, capacidade) VALUES (?,?,?)', 'Sala 12', 'Bloco B - 1º andar', 40);
  ins('INSERT INTO espaco (nome, localizacao, capacidade) VALUES (?,?,?)', 'Laboratório 3', 'Bloco C', 30);
  ins('INSERT INTO espaco (nome, localizacao, capacidade) VALUES (?,?,?)', 'Sala de Reuniões', 'Bloco A - 2º andar', 12);

  const catProj = ins('INSERT INTO categoria (nome, controle, exige_retirada) VALUES (?,?,?)', 'Projetores', 'INDIVIDUAL', 1);
  const catSom = ins('INSERT INTO categoria (nome, controle, exige_retirada) VALUES (?,?,?)', 'Áudio', 'INDIVIDUAL', 1);
  const catCabo = ins('INSERT INTO categoria (nome, controle, exige_retirada) VALUES (?,?,?)', 'Cabos e extensões', 'QUANTIDADE', 1);
  const proj1 = ins('INSERT INTO equipamento (codigo_patrimonio, nome, categoria_id, localizacao) VALUES (?,?,?,?)', 'PAT-1001', 'Projetor Epson 01', catProj, 'Almoxarifado');
  ins('INSERT INTO equipamento (codigo_patrimonio, nome, categoria_id, localizacao) VALUES (?,?,?,?)', 'PAT-1002', 'Projetor Epson 02', catProj, 'Almoxarifado');
  ins('INSERT INTO equipamento (codigo_patrimonio, nome, categoria_id, situacao, localizacao) VALUES (?,?,?,?,?)', 'PAT-1003', 'Projetor BenQ 03', catProj, 'MANUTENCAO', 'Assistência técnica');
  const mic = ins('INSERT INTO equipamento (codigo_patrimonio, nome, categoria_id, localizacao) VALUES (?,?,?,?)', 'PAT-2001', 'Microfone sem fio 01', catSom, 'Almoxarifado');
  ins('INSERT INTO equipamento (codigo_patrimonio, nome, categoria_id, localizacao) VALUES (?,?,?,?)', 'PAT-2002', 'Caixa de som ativa', catSom, 'Almoxarifado');
  ins('INSERT INTO equipamento (codigo_patrimonio, nome, categoria_id, localizacao, quantidade_total) VALUES (?,?,?,?,?)', 'COD-HDMI', 'Cabo HDMI 5 m', catCabo, 'Almoxarifado', 6);
  ins('INSERT INTO equipamento (codigo_patrimonio, nome, categoria_id, localizacao, quantidade_total) VALUES (?,?,?,?,?)', 'COD-EXT', 'Extensão elétrica', catCabo, 'Almoxarifado', 8);

  if (!comExemplos) return;

  // Exemplos na agenda: uma palestra aprovada daqui a 3 dias (14h–16h) e um pedido pendente.
  const dia = (n, hh, mm = 0) => { const d = new Date(); d.setDate(d.getDate() + n); d.setHours(hh, mm, 0, 0); return d.toISOString(); };
  const agora = new Date().toISOString();
  const a1 = ins(`INSERT INTO atividade (titulo, tipo, descricao, responsavel_id, publico_alvo, publico_estimado, inicio, fim) VALUES (?,?,?,?,?,?,?,?)`,
    'Palestra: Carreira em Desenvolvimento Web', 'Palestra', 'Bate-papo com ex-alunos sobre mercado de trabalho.', uid['ana@fatec.demo'], 'Alunos de ADS', 90, dia(3, 14), dia(3, 16));
  const s1 = ins(`INSERT INTO solicitacao (atividade_id, solicitante_id, status, inicio, fim, motivo, criada_em, atualizada_em) VALUES (?,?,?,?,?,?,?,?)`,
    a1, uid['ana@fatec.demo'], 'APROVADA', dia(3, 14), dia(3, 16), 'Evento de extensão', agora, agora);
  ins(`INSERT INTO reserva_espaco (solicitacao_id, espaco_id, inicio, fim, status) VALUES (?,?,?,?,?)`, s1, auditorio, dia(3, 14), dia(3, 16), 'APROVADA');
  ins(`INSERT INTO reserva_equipamento (solicitacao_id, equipamento_id, inicio, fim, quantidade, status) VALUES (?,?,?,?,?,?)`, s1, proj1, dia(3, 14), dia(3, 16), 1, 'APROVADA');
  ins(`INSERT INTO reserva_equipamento (solicitacao_id, equipamento_id, inicio, fim, quantidade, status) VALUES (?,?,?,?,?,?)`, s1, mic, dia(3, 14), dia(3, 16), 1, 'APROVADA');
  for (const [ator, acao] of [[uid['ana@fatec.demo'], 'ENVIADA para análise'], [uid['carla@fatec.demo'], 'APROVOU: Auditório'], [uid['diego@fatec.demo'], 'APROVOU: Projetor Epson 01, Microfone sem fio 01']]) {
    ins('INSERT INTO historico (solicitacao_id, ator_id, acao, data_hora) VALUES (?,?,?,?)', s1, ator, acao, agora);
  }

  const a2 = ins(`INSERT INTO atividade (titulo, tipo, descricao, responsavel_id, publico_alvo, publico_estimado, inicio, fim) VALUES (?,?,?,?,?,?,?,?)`,
    'Oficina de Git e GitHub', 'Oficina', 'Oficina prática para iniciantes.', uid['bruno@fatec.demo'], 'Calouros', 25, dia(5, 19), dia(5, 21));
  const s2 = ins(`INSERT INTO solicitacao (atividade_id, solicitante_id, status, inicio, fim, motivo, criada_em, atualizada_em) VALUES (?,?,?,?,?,?,?,?)`,
    a2, uid['bruno@fatec.demo'], 'PENDENTE', dia(5, 19), dia(5, 21), 'Atividade do grupo de estudos', agora, agora);
  ins(`INSERT INTO reserva_espaco (solicitacao_id, espaco_id, inicio, fim) VALUES (?,?,?,?)`, s2, 3, dia(5, 19), dia(5, 21));
  ins('INSERT INTO historico (solicitacao_id, ator_id, acao, data_hora) VALUES (?,?,?,?)', s2, uid['bruno@fatec.demo'], 'ENVIADA para análise', agora);
  ins('INSERT INTO notificacao (usuario_id, solicitacao_id, mensagem, criada_em) VALUES (?,?,?,?)', uid['carla@fatec.demo'], s2, `Nova solicitação #${s2} aguardando análise.`, agora);
}

module.exports = { popular, SENHA_DEMO };

if (require.main === module) {
  const arquivo = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'reservas.db');
  for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(arquivo + ext)) fs.unlinkSync(arquivo + ext);
  const db = abrirBanco(arquivo);
  popular(db);
  console.log(`Banco recriado em ${arquivo} com dados fictícios. Senha de todos os usuários: ${SENHA_DEMO}`);
}
