// =============================================================================
// Testes automatizados dos critérios de aceite CA-01 a CA-12 (seção 11 da especificação)
// e de algumas regras extras. Rodar com: npm test
//
// Cada teste cria um banco NOVO na memória (novoBanco), então um teste não
// interfere no outro nem no banco da aplicação. Os testes chamam direto as
// funções de servico.js; o CA-05 sobe o servidor de verdade para testar o HTTP 403.
// assert.throws(..., (e) => e.status === 409) significa: "espero que dê erro 409".
// =============================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const { abrirBanco } = require('../src/db');
const { popular, SENHA_DEMO } = require('../src/seed');
const { criarServidor } = require('../src/app');
const S = require('../src/servico');

// Data futura no horário de Brasília: dia D+10 às HH:MM
function hora(hh, mm = 0, dias = 10) {
  const d = new Date(Date.now() + dias * 864e5);
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d);
  return new Date(`${ymd}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00-03:00`).toISOString();
}

function novoBanco() {
  const db = abrirBanco(':memory:');
  popular(db, { comExemplos: false });
  const u = (email) => db.prepare('SELECT id, nome, email, perfil_id FROM usuario WHERE email=?').get(email);
  const id = (tabela, nome) => db.prepare(`SELECT id FROM ${tabela} WHERE nome=?`).get(nome).id;
  return {
    db,
    ana: u('ana@fatec.demo'), bruno: u('bruno@fatec.demo'), carla: u('carla@fatec.demo'),
    diego: u('diego@fatec.demo'), admin: u('admin@fatec.demo'),
    auditorio: id('espaco', 'Auditório'),
    projetor1: id('equipamento', 'Projetor Epson 01'),
    projetorManut: id('equipamento', 'Projetor BenQ 03'),
    hdmi: id('equipamento', 'Cabo HDMI 5 m'),
  };
}

const atividade = (publico = 50) => ({ titulo: 'Palestra teste', tipo: 'Palestra', descricao: 'Teste', publico_alvo: 'Alunos', publico_estimado: publico });

// Cria e aprova uma reserva do auditório no intervalo dado.
function reservaAprovada(c, inicio, fim) {
  const s = S.criarSolicitacao(c.db, c.ana, { atividade: atividade(), inicio, fim, espaco_id: c.auditorio, enviar: true });
  S.aprovar(c.db, c.carla, s.id);
  return s;
}

test('CA-01: auditório 14h–16h reservado; pedido 15h–17h não pode ser aprovado', () => {
  const c = novoBanco();
  // Dois pedidos pendentes sobrepostos (pendente não bloqueia o envio)...
  const a = S.criarSolicitacao(c.db, c.ana, { atividade: atividade(), inicio: hora(14), fim: hora(16), espaco_id: c.auditorio, enviar: true });
  const b = S.criarSolicitacao(c.db, c.bruno, { atividade: atividade(), inicio: hora(15), fim: hora(17), espaco_id: c.auditorio, enviar: true });
  // ...o gestor vê o aviso de conflito
  assert.ok(S.obterSolicitacao(c.db, c.carla, b.id).avisos.some(x => x.includes(`#${a.id}`)));
  S.aprovar(c.db, c.carla, a.id);
  assert.throws(() => S.aprovar(c.db, c.carla, b.id), (e) => e.status === 409 && e.detalhes.some(d => d.includes('Conflito')));
  // Novo pedido sobreposto já é recusado no envio, com o motivo
  assert.throws(() => S.criarSolicitacao(c.db, c.bruno, { atividade: atividade(), inicio: hora(15), fim: hora(17), espaco_id: c.auditorio, enviar: true }),
    (e) => e.status === 409);
});

test('CA-02: auditório 14h–16h reservado; pedido 16h–18h é permitido', () => {
  const c = novoBanco();
  reservaAprovada(c, hora(14), hora(16));
  const s = S.criarSolicitacao(c.db, c.bruno, { atividade: atividade(), inicio: hora(16), fim: hora(18), espaco_id: c.auditorio, enviar: true });
  assert.equal(S.aprovar(c.db, c.carla, s.id).status, 'APROVADA');
});

test('CA-02b: com intervalo de preparação configurado, 16h–18h passa a conflitar', () => {
  const c = novoBanco();
  c.db.prepare(`UPDATE parametro SET valor='30' WHERE chave='intervalo_preparacao_min'`).run();
  reservaAprovada(c, hora(14), hora(16));
  assert.throws(() => S.criarSolicitacao(c.db, c.bruno, { atividade: atividade(), inicio: hora(16), fim: hora(18), espaco_id: c.auditorio, enviar: true }),
    (e) => e.status === 409);
});

test('CA-03: auditório com capacidade 120 e evento de 150 pessoas é bloqueado', () => {
  const c = novoBanco();
  assert.throws(() => S.criarSolicitacao(c.db, c.ana, { atividade: atividade(150), inicio: hora(14), fim: hora(16), espaco_id: c.auditorio, enviar: true }),
    (e) => e.status === 409 && e.detalhes.some(d => d.includes('capacidade')));
});

test('CA-04: equipamento em manutenção não pode ser reservado', () => {
  const c = novoBanco();
  assert.throws(() => S.criarSolicitacao(c.db, c.ana, { inicio: hora(14), fim: hora(16), equipamentos: [{ equipamento_id: c.projetorManut }], enviar: true }),
    (e) => e.status === 409 && e.detalhes.some(d => d.includes('MANUTENCAO')));
});

test('CA-05: usuário comum chamando a URL de aprovação recebe acesso negado (HTTP 403)', async () => {
  const c = novoBanco();
  const s = S.criarSolicitacao(c.db, c.bruno, { atividade: atividade(), inicio: hora(14), fim: hora(16), espaco_id: c.auditorio, enviar: true });
  const srv = criarServidor(c.db).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const h = { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' };
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'ana@fatec.demo', senha: SENHA_DEMO }) });
    assert.equal(login.status, 201);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const r = await fetch(`${base}/api/solicitacoes/${s.id}/aprovar`, { method: 'PATCH', headers: { ...h, Cookie: cookie }, body: '{}' });
    assert.equal(r.status, 403);
    const semLogin = await fetch(`${base}/api/solicitacoes/${s.id}/aprovar`, { method: 'PATCH', headers: h, body: '{}' });
    assert.equal(semLogin.status, 401);
  } finally { srv.close(); }
});

test('CA-06: solicitação com campos obrigatórios ausentes não pode ser enviada', () => {
  const c = novoBanco();
  assert.throws(() => S.criarSolicitacao(c.db, c.ana, { atividade: { titulo: '' }, inicio: hora(14), fim: hora(16), espaco_id: c.auditorio, enviar: true }),
    (e) => e.status === 422 && ['titulo', 'tipo', 'descricao', 'publico_estimado'].every(f => e.detalhes.some(d => d.campo === f)));
  // RN-03: fim antes do início
  assert.throws(() => S.criarSolicitacao(c.db, c.ana, { inicio: hora(16), fim: hora(14), espaco_id: c.auditorio }),
    (e) => e.status === 422 && e.detalhes.some(d => d.campo === 'fim'));
});

test('CA-07: rejeição exige justificativa e fica no histórico', () => {
  const c = novoBanco();
  const s = S.criarSolicitacao(c.db, c.ana, { atividade: atividade(), inicio: hora(14), fim: hora(16), espaco_id: c.auditorio, enviar: true });
  assert.throws(() => S.rejeitar(c.db, c.carla, s.id, ''), (e) => e.status === 422);
  S.rejeitar(c.db, c.carla, s.id, 'Auditório reservado para a colação.');
  const d = S.obterSolicitacao(c.db, c.ana, s.id);
  assert.equal(d.status, 'REJEITADA');
  const h = d.historico.find(x => x.acao.startsWith('REJEITOU'));
  assert.equal(h.ator_id, c.carla.id);
  assert.equal(h.justificativa, 'Auditório reservado para a colação.');
  assert.ok(h.data_hora);
});

test('CA-08: alterar data de reserva aprovada revalida conflitos e volta para aprovação', () => {
  const c = novoBanco();
  reservaAprovada(c, hora(9), hora(11));
  const s = S.criarSolicitacao(c.db, c.bruno, { atividade: atividade(), inicio: hora(14), fim: hora(16), espaco_id: c.auditorio, enviar: true });
  S.aprovar(c.db, c.carla, s.id);
  // Mudar para horário ocupado é recusado
  assert.throws(() => S.atualizarSolicitacao(c.db, c.bruno, s.id, { atividade: atividade(), inicio: hora(10), fim: hora(12), espaco_id: c.auditorio }),
    (e) => e.status === 409);
  // Mudar para horário livre volta a PENDENTE
  const novo = S.atualizarSolicitacao(c.db, c.bruno, s.id, { atividade: atividade(), inicio: hora(17), fim: hora(19), espaco_id: c.auditorio });
  assert.equal(novo.status, 'PENDENTE');
  assert.equal(novo.espacos[0].status, 'PENDENTE');
});

test('CA-09: cancelamento libera o horário e registra quem cancelou e o motivo', () => {
  const c = novoBanco();
  const s = reservaAprovada(c, hora(14), hora(16));
  assert.throws(() => S.cancelar(c.db, c.ana, s.id, ''), (e) => e.status === 422);
  S.cancelar(c.db, c.ana, s.id, 'Palestrante desmarcou');
  const d = S.obterSolicitacao(c.db, c.ana, s.id);
  assert.equal(d.status, 'CANCELADA');
  assert.ok(d.historico.some(h => h.acao === 'CANCELOU' && h.ator_id === c.ana.id && h.justificativa === 'Palestrante desmarcou'));
  assert.equal(S.verificarEspaco(c.db, c.auditorio, hora(14), hora(16)).disponivel, true);
});

function emprestimoAprovado(c, inicio = hora(14), fim = hora(16)) {
  const s = S.criarSolicitacao(c.db, c.ana, { inicio, fim, equipamentos: [{ equipamento_id: c.projetor1 }], enviar: true });
  S.aprovar(c.db, c.diego, s.id);
  return S.obterSolicitacao(c.db, c.ana, s.id);
}

test('CA-10: retirada registra responsável e horário da entrega', () => {
  const c = novoBanco();
  const s = emprestimoAprovado(c);
  const m = S.registrarMovimentacao(c.db, c.diego, { reserva_equipamento_id: s.equipamentos[0].id, tipo: 'ENTREGA', pessoa: 'Ana Souza', condicao: 'BOA' });
  assert.equal(m.responsavel_id, c.diego.id);
  assert.equal(m.pessoa, 'Ana Souza');
  assert.ok(m.data_hora);
  // Solicitante comum não pode registrar movimentação
  assert.throws(() => S.registrarMovimentacao(c.db, c.ana, { reserva_equipamento_id: s.equipamentos[0].id, tipo: 'DEVOLUCAO', pessoa: 'x' }),
    (e) => e.status === 403);
});

test('CA-11: devolução com avaria registra a condição e indisponibiliza o item', () => {
  const c = novoBanco();
  const s = emprestimoAprovado(c);
  const rid = s.equipamentos[0].id;
  S.registrarMovimentacao(c.db, c.diego, { reserva_equipamento_id: rid, tipo: 'ENTREGA', pessoa: 'Ana Souza' });
  assert.throws(() => S.registrarMovimentacao(c.db, c.diego, { reserva_equipamento_id: rid, tipo: 'DEVOLUCAO', pessoa: 'Ana Souza', condicao: 'AVARIADO' }),
    (e) => e.status === 422); // avaria sem descrição
  const m = S.registrarMovimentacao(c.db, c.diego, { reserva_equipamento_id: rid, tipo: 'DEVOLUCAO', pessoa: 'Ana Souza', condicao: 'AVARIADO', observacao: 'Lâmpada queimada' });
  assert.equal(m.condicao, 'AVARIADO');
  assert.equal(c.db.prepare('SELECT situacao FROM equipamento WHERE id=?').get(c.projetor1).situacao, 'AVARIADO');
  assert.equal(S.verificarEquipamento(c.db, c.projetor1, hora(14, 0, 12), hora(16, 0, 12)).disponivel, false);
});

test('CA-12: dois aprovadores no mesmo recurso — só uma aprovação conclui', () => {
  const c = novoBanco();
  const a = S.criarSolicitacao(c.db, c.ana, { inicio: hora(14), fim: hora(16), equipamentos: [{ equipamento_id: c.projetor1 }], enviar: true });
  const b = S.criarSolicitacao(c.db, c.bruno, { inicio: hora(15), fim: hora(17), equipamentos: [{ equipamento_id: c.projetor1 }], enviar: true });
  const resultados = [a, b].map((s, i) => {
    try { S.aprovar(c.db, i === 0 ? c.diego : c.admin, s.id); return 'ok'; } catch (e) { return e.status; }
  });
  assert.deepEqual(resultados, ['ok', 409]);
  const alocadas = c.db.prepare(`SELECT COUNT(*) n FROM reserva_equipamento WHERE equipamento_id=? AND status='APROVADA'`).get(c.projetor1).n;
  assert.equal(alocadas, 1);
});

test('RN-13: item por quantidade não fica com saldo negativo', () => {
  const c = novoBanco(); // 6 cabos HDMI
  const a = S.criarSolicitacao(c.db, c.ana, { inicio: hora(14), fim: hora(16), equipamentos: [{ equipamento_id: c.hdmi, quantidade: 4 }], enviar: true });
  S.aprovar(c.db, c.diego, a.id);
  assert.throws(() => S.criarSolicitacao(c.db, c.bruno, { inicio: hora(15), fim: hora(17), equipamentos: [{ equipamento_id: c.hdmi, quantidade: 3 }], enviar: true }),
    (e) => e.status === 409 && e.detalhes.some(d => d.includes('disponível 2')));
  const ok = S.criarSolicitacao(c.db, c.bruno, { inicio: hora(15), fim: hora(17), equipamentos: [{ equipamento_id: c.hdmi, quantidade: 2 }], enviar: true });
  assert.equal(S.aprovar(c.db, c.diego, ok.id).status, 'APROVADA');
});

test('RN-05: pedido em período bloqueado por manutenção é recusado', () => {
  const c = novoBanco();
  S.criarBloqueio(c.db, c.carla, { tipo_recurso: 'ESPACO', recurso_id: c.auditorio, inicio: hora(8), fim: hora(18), motivo: 'Manutenção do ar-condicionado' });
  assert.throws(() => S.criarSolicitacao(c.db, c.ana, { atividade: atividade(), inicio: hora(14), fim: hora(16), espaco_id: c.auditorio, enviar: true }),
    (e) => e.status === 409 && e.detalhes.some(d => d.includes('bloqueado')));
});

test('RN-07: fora do horário exige justificativa de aprovação excepcional', () => {
  const c = novoBanco();
  const s = S.criarSolicitacao(c.db, c.ana, { atividade: atividade(), inicio: hora(23, 30), fim: hora(23, 50), espaco_id: c.auditorio, enviar: true });
  assert.equal(s.excepcional, 1);
  assert.throws(() => S.aprovar(c.db, c.carla, s.id), (e) => e.status === 422);
  assert.equal(S.aprovar(c.db, c.carla, s.id, 'Evento autorizado pela direção').status, 'APROVADA');
});

test('RNF-03: gestor não decide a própria solicitação', () => {
  const c = novoBanco();
  const s = S.criarSolicitacao(c.db, c.carla, { atividade: atividade(), inicio: hora(14), fim: hora(16), espaco_id: c.auditorio, enviar: true });
  assert.throws(() => S.aprovar(c.db, c.carla, s.id), (e) => e.status === 403);
});

test('RN-18: aprovação parcial mostra o status de cada recurso', () => {
  const c = novoBanco();
  const s = S.criarSolicitacao(c.db, c.ana, { atividade: atividade(), inicio: hora(14), fim: hora(16), espaco_id: c.auditorio,
    equipamentos: [{ equipamento_id: c.projetor1 }], enviar: true });
  S.aprovar(c.db, c.carla, s.id);
  let d = S.obterSolicitacao(c.db, c.ana, s.id);
  assert.equal(d.status, 'PENDENTE');
  assert.equal(d.espacos[0].status, 'APROVADA');
  assert.equal(d.equipamentos[0].status, 'PENDENTE');
  S.rejeitar(c.db, c.diego, s.id, 'Projetor reservado para prova');
  d = S.obterSolicitacao(c.db, c.ana, s.id);
  assert.equal(d.status, 'APROVADA');
  assert.equal(d.equipamentos[0].status, 'REJEITADA');
});
