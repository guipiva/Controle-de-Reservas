// =============================================================================
// servico.js — REGRAS DE NEGÓCIO do sistema (o arquivo mais importante).
//
// Arquitetura (seção 12 da especificação):
//   tela (public/) → API (app.js) → ESTE ARQUIVO → banco (db.js)
//
// Toda decisão acontece aqui: quem pode fazer o quê, se há conflito de horário,
// se o equipamento está disponível, como muda o status do pedido etc.
// As rotas da API apenas chamam estas funções. Assim, mesmo que alguém chame a API
// direto, sem passar pela tela, as regras continuam valendo (RNF-02 e RNF-03).
//
// Convenção: toda função recebe "db" (conexão com o banco) e, quando precisa saber
// quem está fazendo a ação, "ator" (o usuário logado: id, nome, perfil_id).
// Quando uma regra é violada, a função lança ErroNegocio com o código HTTP adequado.
// =============================================================================
const { transacao } = require('./db');
const {
  ErroNegocio, agoraISO, paraISO, sobrepoe, minutosLocais, hhmmParaMin, hashSenha, fmtPeriodoLocal, fmtLocal,
} = require('./util');

// ---------------------------------------------------------------- perfis e permissões
/**
 * Permissões de cada perfil (RF-01). As funções abaixo usam pode()/exigir()
 * para decidir se o usuário pode fazer cada operação. Isso roda no servidor,
 * então esconder um botão na tela não é a única proteção (RNF-03).
 */
const PERMISSOES = {
  SOLICITANTE:       ['solicitar'],
  GESTOR_ESPACOS:    ['solicitar', 'aprovar_espaco', 'gerir_espacos', 'bloquear', 'ver_tudo', 'relatorios'],
  RESP_EQUIPAMENTOS: ['solicitar', 'aprovar_equipamento', 'gerir_equipamentos', 'movimentar', 'bloquear', 'ver_tudo', 'relatorios'],
  ADMIN:             ['solicitar', 'aprovar_espaco', 'aprovar_equipamento', 'gerir_espacos', 'gerir_equipamentos',
                      'movimentar', 'bloquear', 'ver_tudo', 'relatorios', 'admin'],
};
/**
 * true se o usuário (ator) tem a permissão informada.
 */
const pode = (ator, perm) => !!ator && (PERMISSOES[ator.perfil_id] || []).includes(perm);
/**
 * Igual a pode(), mas lança erro 403 se não tiver a permissão (critério CA-05).
 */
function exigir(ator, perm) {
  if (!pode(ator, perm)) throw new ErroNegocio('Acesso negado: seu perfil não tem permissão para esta operação.', 403);
}

/**
 * Status em que a solicitação não pode mais ser alterada nem cancelada.
 */
const STATUS_FINAIS = ['REJEITADA', 'CANCELADA', 'CONCLUIDA'];

// ---------------------------------------------------------------- parâmetros configuráveis
/**
 * Lê os parâmetros configuráveis da tabela "parametro" (tela Administração).
 * A especificação pede que horário, antecedência etc. sejam configuráveis,
 * porque cada unidade tem regras diferentes. Os "??" definem um valor padrão.
 */
function parametros(db) {
  const p = Object.fromEntries(db.prepare('SELECT chave, valor FROM parametro').all().map(r => [r.chave, r.valor]));
  return {
    intervaloPreparacaoMin: Number(p.intervalo_preparacao_min ?? 0),
    antecedenciaMinHoras: Number(p.antecedencia_min_horas ?? 0),
    horaAbertura: p.hora_abertura ?? '07:00',
    horaFechamento: p.hora_fechamento ?? '23:00',
    politicaForaRegra: p.politica_fora_regra ?? 'EXCECAO', // EXCECAO | BLOQUEAR
    permitirAutoaprovacao: p.permitir_autoaprovacao === '1',
    fuso: p.fuso ?? 'America/Sao_Paulo',
  };
}

// ---------------------------------------------------------------- auditoria e notificações
/**
 * Grava uma linha no log de auditoria (ações administrativas, logins).
 */
function log(db, usuarioId, acao, detalhe) {
  db.prepare('INSERT INTO log_auditoria (usuario_id, acao, detalhe, data_hora) VALUES (?,?,?,?)')
    .run(usuarioId ?? null, acao, detalhe ? String(detalhe) : null, agoraISO());
}
/**
 * Grava um evento no histórico da solicitação (RF-12 / RN-08):
 * quem fez (ator), o que fez (acao), por quê (justificativa) e quando.
 */
function historico(db, solicitacaoId, atorId, acao, justificativa) {
  db.prepare('INSERT INTO historico (solicitacao_id, ator_id, acao, justificativa, data_hora) VALUES (?,?,?,?,?)')
    .run(solicitacaoId, atorId, acao, justificativa || null, agoraISO());
}
/**
 * Cria uma notificação para um usuário (o sino no topo da tela, RF-10).
 */
function notificar(db, usuarioId, solicitacaoId, mensagem) {
  db.prepare('INSERT INTO notificacao (usuario_id, solicitacao_id, mensagem, criada_em) VALUES (?,?,?,?)')
    .run(usuarioId, solicitacaoId ?? null, mensagem, agoraISO());
}
/**
 * Notifica todos os usuários ativos que tenham alguma das permissões
 * informadas (ex.: todos que aprovam espaços), menos quem causou o evento.
 */
function notificarPerfis(db, perms, solicitacaoId, mensagem, excetoId) {
  const perfis = Object.entries(PERMISSOES).filter(([, ps]) => perms.some(x => ps.includes(x))).map(([k]) => k);
  const us = db.prepare(`SELECT id FROM usuario WHERE ativo = 1 AND perfil_id IN (${perfis.map(() => '?').join(',')})`).all(...perfis);
  for (const u of us) if (u.id !== excetoId) notificar(db, u.id, solicitacaoId, mensagem);
}

// ---------------------------------------------------------------- disponibilidade (RN-04, RN-05, RN-06, RN-12..RN-14)
/**
 * Retorna os bloqueios (manutenção etc.) de um recurso que caem no período (RN-05).
 */
function bloqueiosNoPeriodo(db, tipo, recursoId, inicio, fim) {
  return db.prepare('SELECT * FROM bloqueio WHERE tipo_recurso = ? AND recurso_id = ?').all(tipo, recursoId)
    .filter(b => sobrepoe(inicio, fim, b.inicio, b.fim));
}

/**
 * Verifica se um ESPAÇO pode ser usado no período [inicio, fim).
 * Confere, nesta ordem:
 *   1. se o espaço existe e está ativo;
 *   2. capacidade × público estimado (RN-06 / CA-03);
 *   3. bloqueios de manutenção (RN-05);
 *   4. conflito com reservas APROVADAS, considerando a folga (RN-04 / CA-01).
 * Pedidos apenas pendentes não ocupam o espaço (decisão de política, ver docs).
 * "ignorarSolicitacao" serve para, ao editar ou aprovar, não comparar o pedido com ele mesmo.
 * Retorna { disponivel, motivos[] }; motivos explica ao usuário o porquê.
 */
function verificarEspaco(db, espacoId, inicio, fim, { ignorarSolicitacao = 0, publicoEstimado = null } = {}) {
  const motivos = [];
  const esp = db.prepare('SELECT * FROM espaco WHERE id = ?').get(espacoId);
  if (!esp) return { disponivel: false, motivos: ['Espaço inexistente.'] };
  if (!esp.ativo) motivos.push(`O espaço "${esp.nome}" está inativo.`);
  if (publicoEstimado != null && publicoEstimado > esp.capacidade) {
    motivos.push(`Público estimado (${publicoEstimado}) excede a capacidade de "${esp.nome}" (${esp.capacidade}).`);
  }
  for (const b of bloqueiosNoPeriodo(db, 'ESPACO', espacoId, inicio, fim)) {
    motivos.push(`"${esp.nome}" está bloqueado neste período: ${b.motivo}.`);
  }
  const folga = parametros(db).intervaloPreparacaoMin;
  const ocupadas = db.prepare(`
    SELECT r.*, s.id AS sol FROM reserva_espaco r JOIN solicitacao s ON s.id = r.solicitacao_id
    WHERE r.espaco_id = ? AND r.status = 'APROVADA' AND s.id <> ?`).all(espacoId, ignorarSolicitacao);
  for (const r of ocupadas) {
    if (sobrepoe(inicio, fim, r.inicio, r.fim, folga)) {
      motivos.push(`Conflito: "${esp.nome}" já está reservado (solicitação #${r.sol}): ${fmtPeriodoLocal(r.inicio, r.fim, parametros(db).fuso)}.`);
    }
  }
  return { disponivel: motivos.length === 0, motivos, espaco: esp };
}

/**
 * Para equipamentos controlados por QUANTIDADE (ex.: 6 cabos HDMI):
 * calcula quantas unidades estão em uso ao MESMO tempo, no pior momento do período.
 * Funciona como uma "linha do tempo": cada reserva soma +quantidade quando começa
 * e -quantidade quando termina; o maior valor atingido é o pico.
 * Isso é mais justo do que somar todas as reservas do dia, que podem nem se encostar.
 */
function picoDeUso(intervalos, inicio, fim) {
  const ev = [];
  const i0 = new Date(inicio).getTime(), f0 = new Date(fim).getTime();
  for (const r of intervalos) {
    const a = Math.max(i0, new Date(r.inicio).getTime());
    const b = Math.min(f0, new Date(r.fim).getTime());
    if (a < b) { ev.push([a, r.quantidade]); ev.push([b, -r.quantidade]); }
  }
  ev.sort((x, y) => x[0] - y[0] || x[1] - y[1]); // saídas antes de entradas no mesmo instante
  let atual = 0, pico = 0;
  for (const [, q] of ev) { atual += q; pico = Math.max(pico, atual); }
  return pico;
}

/**
 * Verifica se um EQUIPAMENTO pode ser reservado no período.
 *   - situação diferente de DISPONIVEL (manutenção, avariado, inativo) → bloqueia (RN-14 / CA-04);
 *   - bloqueios cadastrados → bloqueia (RN-05);
 *   - item INDIVIDUAL: não pode haver outra reserva aprovada sobreposta (RN-12);
 *   - item por QUANTIDADE: o saldo no período não pode ficar negativo (RN-13).
 * Caso especial (exceção 10.4): item retirado e ainda não devolvido continua ocupado
 * até ser devolvido, mesmo que o horário da reserva já tenha passado.
 */
function verificarEquipamento(db, equipamentoId, inicio, fim, quantidade = 1, { ignorarSolicitacao = 0 } = {}) {
  const motivos = [];
  const eq = db.prepare(`SELECT e.*, c.controle, c.nome AS categoria, c.exige_retirada
                         FROM equipamento e JOIN categoria c ON c.id = e.categoria_id WHERE e.id = ?`).get(equipamentoId);
  if (!eq) return { disponivel: false, motivos: ['Equipamento inexistente.'] };
  if (eq.situacao !== 'DISPONIVEL') {
    motivos.push(`"${eq.nome}" está com situação ${eq.situacao} e não pode ser reservado.`); // RN-14 / CA-04
  }
  if (eq.controle === 'INDIVIDUAL' && quantidade !== 1) motivos.push(`"${eq.nome}" é item individual: quantidade deve ser 1.`);
  for (const b of bloqueiosNoPeriodo(db, 'EQUIPAMENTO', equipamentoId, inicio, fim)) {
    motivos.push(`"${eq.nome}" está bloqueado neste período: ${b.motivo}.`);
  }
  const agora = agoraISO();
  // Reservas aprovadas ocupam o item; se foi retirado e não devolvido, ocupa até a devolução real (exceção 10.4).
  const usos = db.prepare(`
    SELECT r.* FROM reserva_equipamento r
    WHERE r.equipamento_id = ? AND r.status = 'APROVADA' AND r.retirada <> 'DEVOLVIDO' AND r.solicitacao_id <> ?`)
    .all(equipamentoId, ignorarSolicitacao)
    .map(r => (r.retirada === 'RETIRADO' && r.fim < agora ? { ...r, fim: '9999-12-31T00:00:00.000Z' } : r));

  let saldo;
  if (eq.controle === 'INDIVIDUAL') {
    const conflito = usos.find(r => sobrepoe(inicio, fim, r.inicio, r.fim));
    if (conflito) {
      motivos.push(conflito.retirada === 'RETIRADO' && conflito.fim.startsWith('9999')
        ? `"${eq.nome}" está retirado e ainda não foi devolvido (solicitação #${conflito.solicitacao_id}).`
        : `Conflito: "${eq.nome}" já está alocado (solicitação #${conflito.solicitacao_id}) neste período.`); // RN-12
    }
    saldo = conflito ? 0 : 1;
  } else {
    const pico = picoDeUso(usos, inicio, fim);
    saldo = eq.quantidade_total - pico;
    if (quantidade > saldo) {
      motivos.push(`Saldo insuficiente de "${eq.nome}": disponível ${Math.max(saldo, 0)}, solicitado ${quantidade}.`); // RN-13
    }
  }
  return { disponivel: motivos.length === 0, motivos, saldo: Math.max(saldo, 0), equipamento: eq };
}

/**
 * Regra RN-07: pedido fora do horário de funcionamento ou com antecedência
 * menor que a mínima. Não bloqueia sozinho: devolve "alertas". Quem decide o que
 * fazer é o parâmetro politica_fora_regra (EXCECAO ou BLOQUEAR), em validarRecursos().
 */
function verificarPolitica(db, inicio, fim) {
  const p = parametros(db);
  const alertas = [];
  const ab = hhmmParaMin(p.horaAbertura), fe = hhmmParaMin(p.horaFechamento);
  const mi = minutosLocais(inicio, p.fuso), mf = minutosLocais(fim, p.fuso);
  const mesmoDia = new Date(fim) - new Date(inicio) < 24 * 3600 * 1000 && mf > mi;
  if (!mesmoDia || mi < ab || mf > fe) alertas.push(`Fora do horário de funcionamento (${p.horaAbertura}–${p.horaFechamento}).`);
  const horas = (new Date(inicio) - Date.now()) / 3600000;
  if (horas < p.antecedenciaMinHoras) alertas.push(`Antecedência menor que a mínima configurada (${p.antecedenciaMinHoras} h).`);
  return alertas;
}

/**
 * Usada pelo botão "Verificar disponibilidade" da tela.
 * É só informativa: o resultado pode mudar até a aprovação, que verifica de novo.
 */
function consultarDisponibilidade(db, { inicio, fim, espaco_id, equipamentos = [], publico_estimado, ignorar }) {
  const i = paraISO(inicio), f = paraISO(fim);
  if (!i || !f || f <= i) throw new ErroNegocio('Informe início e fim válidos; o fim deve ser posterior ao início.');
  const opts = { ignorarSolicitacao: Number(ignorar) || 0 };
  const res = { espaco: null, equipamentos: [], politica: verificarPolitica(db, i, f) };
  if (espaco_id) {
    const v = verificarEspaco(db, Number(espaco_id), i, f, { ...opts, publicoEstimado: publico_estimado ? Number(publico_estimado) : null });
    res.espaco = { espaco_id: Number(espaco_id), disponivel: v.disponivel, motivos: v.motivos };
  }
  for (const e of equipamentos) {
    const v = verificarEquipamento(db, Number(e.equipamento_id), i, f, Number(e.quantidade) || 1, opts);
    res.equipamentos.push({ equipamento_id: Number(e.equipamento_id), disponivel: v.disponivel, motivos: v.motivos, saldo: v.saldo });
  }
  return res;
}

/**
 * Lista os espaços e, se vier um período, diz se cada um está livre (tela Espaços).
 */
function espacosComDisponibilidade(db, inicio, fim) {
  const espacos = db.prepare('SELECT * FROM espaco ORDER BY nome').all();
  const i = paraISO(inicio), f = paraISO(fim);
  if (!i || !f || f <= i) return espacos;
  return espacos.map(e => {
    const v = verificarEspaco(db, e.id, i, f);
    return { ...e, disponivel: v.disponivel, motivos: v.motivos };
  });
}

// ---------------------------------------------------------------- validação de dados (RN-02, RN-03, CA-06)
/**
 * Limpa os dados que chegaram da tela antes de usar:
 * converte datas para ISO, números para número, corta textos muito longos
 * e junta equipamentos repetidos em uma linha só.
 * Nunca se confia no formato que veio do navegador (RNF-02).
 */
function normalizar(dados) {
  const d = dados || {};
  const out = {
    inicio: paraISO(d.inicio),
    fim: paraISO(d.fim),
    motivo: (d.motivo ?? '').toString().trim().slice(0, 2000),
    espaco_id: d.espaco_id ? Number(d.espaco_id) : null,
    equipamentos: Array.isArray(d.equipamentos) ? d.equipamentos
      .filter(e => e && e.equipamento_id)
      .map(e => ({ equipamento_id: Number(e.equipamento_id), quantidade: Math.max(1, parseInt(e.quantidade, 10) || 1) })) : [],
    atividade: null,
  };
  if (d.atividade) {
    const a = d.atividade;
    out.atividade = {
      titulo: (a.titulo ?? '').toString().trim().slice(0, 200),
      tipo: (a.tipo ?? '').toString().trim().slice(0, 60),
      descricao: (a.descricao ?? '').toString().trim().slice(0, 4000),
      publico_alvo: (a.publico_alvo ?? '').toString().trim().slice(0, 200),
      publico_estimado: parseInt(a.publico_estimado, 10) || 0,
    };
  }
  // equipamentos repetidos são somados em uma linha
  const m = new Map();
  for (const e of out.equipamentos) m.set(e.equipamento_id, (m.get(e.equipamento_id) || 0) + e.quantidade);
  out.equipamentos = [...m].map(([equipamento_id, quantidade]) => ({ equipamento_id, quantidade }));
  return out;
}

/**
 * RN-03: início e fim obrigatórios e fim depois do início.
 * Erros são devolvidos por campo, para a tela destacar o campo certo (CA-06).
 */
function validarDatas(d) {
  const campos = [];
  if (!d.inicio) campos.push({ campo: 'inicio', mensagem: 'Data/hora de início obrigatória.' });
  if (!d.fim) campos.push({ campo: 'fim', mensagem: 'Data/hora de término obrigatória.' });
  if (d.inicio && d.fim && d.fim <= d.inicio) {
    campos.push({ campo: 'fim', mensagem: 'O horário final deve ser posterior ao inicial (RN-03).' });
  }
  if (campos.length) throw new ErroNegocio('Dados inválidos.', 422, campos);
}

/**
 * Validação completa, exigida para ENVIAR (rascunho pode ficar incompleto).
 * RN-02: campos obrigatórios da atividade; ao menos um recurso; início no futuro.
 */
function validarCompleto(d) {
  const campos = [];
  try { validarDatas(d); } catch (e) { campos.push(...e.detalhes); }
  if (d.atividade) {
    const a = d.atividade;
    if (!a.titulo) campos.push({ campo: 'titulo', mensagem: 'Título obrigatório.' });
    if (!a.tipo) campos.push({ campo: 'tipo', mensagem: 'Tipo obrigatório.' });
    if (!a.descricao) campos.push({ campo: 'descricao', mensagem: 'Descrição obrigatória.' });
    if (!a.publico_alvo) campos.push({ campo: 'publico_alvo', mensagem: 'Público-alvo obrigatório.' });
    if (!(a.publico_estimado > 0)) campos.push({ campo: 'publico_estimado', mensagem: 'Informe o número estimado de participantes.' });
  }
  if (!d.espaco_id && d.equipamentos.length === 0) {
    campos.push({ campo: 'recursos', mensagem: 'Selecione ao menos um espaço ou equipamento.' });
  }
  if (d.inicio && d.inicio < agoraISO()) campos.push({ campo: 'inicio', mensagem: 'O início deve estar no futuro.' });
  if (campos.length) throw new ErroNegocio('Preencha os campos obrigatórios antes de enviar.', 422, campos);
}

/**
 * Valida disponibilidade de todos os recursos do pedido.
 * Se algum estiver indisponível, lança erro 409 com a lista de motivos.
 * Depois aplica a política RN-07: com BLOQUEAR, impede o envio; com EXCECAO,
 * marca o pedido como "excepcional" (a aprovação vai exigir justificativa).
 */
function validarRecursos(db, d, ignorarSolicitacao) {
  const conflitos = [];
  if (d.espaco_id) {
    const v = verificarEspaco(db, d.espaco_id, d.inicio, d.fim, {
      ignorarSolicitacao, publicoEstimado: d.atividade ? d.atividade.publico_estimado : null,
    });
    conflitos.push(...v.motivos);
  }
  for (const e of d.equipamentos) {
    conflitos.push(...verificarEquipamento(db, e.equipamento_id, d.inicio, d.fim, e.quantidade, { ignorarSolicitacao }).motivos);
  }
  if (conflitos.length) throw new ErroNegocio('Recurso indisponível para o período solicitado.', 409, conflitos);
  const alertas = verificarPolitica(db, d.inicio, d.fim);
  if (alertas.length && parametros(db).politicaForaRegra === 'BLOQUEAR') {
    throw new ErroNegocio('Solicitação fora da política da unidade.', 409, alertas);
  }
  return { excepcional: alertas.length > 0, alertas };
}

// ---------------------------------------------------------------- leitura de solicitação
/**
 * Carrega a solicitação com a atividade e os itens (espaços e equipamentos).
 */
function carregarDados(db, id) {
  const s = db.prepare('SELECT * FROM solicitacao WHERE id = ?').get(id);
  if (!s) throw new ErroNegocio('Solicitação não encontrada.', 404);
  const atividade = s.atividade_id ? db.prepare('SELECT * FROM atividade WHERE id = ?').get(s.atividade_id) : null;
  const espacos = db.prepare(`SELECT r.*, e.nome AS espaco_nome, e.capacidade FROM reserva_espaco r
                              JOIN espaco e ON e.id = r.espaco_id WHERE r.solicitacao_id = ?`).all(id);
  const equipamentos = db.prepare(`SELECT r.*, e.nome AS equipamento_nome, e.codigo_patrimonio, c.controle, c.exige_retirada
                                   FROM reserva_equipamento r JOIN equipamento e ON e.id = r.equipamento_id
                                   JOIN categoria c ON c.id = e.categoria_id WHERE r.solicitacao_id = ?`).all(id);
  return { s, atividade, espacos, equipamentos };
}

/**
 * Só o dono do pedido ou perfis com "ver_tudo" podem abrir os detalhes.
 */
function podeVer(ator, s) { return s.solicitante_id === ator.id || pode(ator, 'ver_tudo'); }

/**
 * Quais itens o usuário pode decidir: gestor de espaços decide espaços,
 * responsável por equipamentos decide equipamentos, admin decide os dois.
 */
function competencia(ator, espacos, equipamentos) {
  return {
    espacos: pode(ator, 'aprovar_espaco') ? espacos : [],
    equipamentos: pode(ator, 'aprovar_equipamento') ? equipamentos : [],
  };
}

/**
 * Monta tudo que a tela de detalhes precisa: dados, itens, histórico,
 * movimentações, avisos e "acoes" (quais botões mostrar para este usuário).
 * Os botões são só conveniência: cada ação é verificada de novo ao ser executada.
 */
function obterSolicitacao(db, ator, id) {
  const { s, atividade, espacos, equipamentos } = carregarDados(db, Number(id));
  if (!podeVer(ator, s)) throw new ErroNegocio('Acesso negado.', 403);
  const solicitante = db.prepare('SELECT id, nome, email FROM usuario WHERE id = ?').get(s.solicitante_id);
  const hist = db.prepare(`SELECT h.*, u.nome AS ator_nome FROM historico h JOIN usuario u ON u.id = h.ator_id
                           WHERE solicitacao_id = ? ORDER BY h.id`).all(s.id);
  const movs = db.prepare(`SELECT m.*, u.nome AS responsavel_nome FROM movimentacao m JOIN usuario u ON u.id = m.responsavel_id
                           JOIN reserva_equipamento r ON r.id = m.reserva_equipamento_id
                           WHERE r.solicitacao_id = ? ORDER BY m.id`).all(s.id);
  const p = parametros(db);
  const comp = competencia(ator, espacos, equipamentos);
  const temPendenteComp = [...comp.espacos, ...comp.equipamentos].some(i => i.status === 'PENDENTE');
  const dono = s.solicitante_id === ator.id;
  const retirado = equipamentos.some(e => e.retirada === 'RETIRADO');
  const temMov = movs.length > 0;
  // Conflitos com outras PENDENTES (informativo para o gestor: exceção "dois pedidos para o mesmo horário")
  const avisos = [];
  if (s.status === 'PENDENTE') {
    for (const r of espacos) {
      const outros = db.prepare(`SELECT r2.solicitacao_id FROM reserva_espaco r2 JOIN solicitacao s2 ON s2.id = r2.solicitacao_id
                                 WHERE r2.espaco_id = ? AND s2.status = 'PENDENTE' AND s2.id <> ?`)
        .all(r.espaco_id, s.id).filter(o => {
          const x = db.prepare('SELECT inicio, fim FROM reserva_espaco WHERE solicitacao_id = ? AND espaco_id = ?').get(o.solicitacao_id, r.espaco_id);
          return sobrepoe(r.inicio, r.fim, x.inicio, x.fim, p.intervaloPreparacaoMin);
        });
      for (const o of outros) avisos.push(`Também há a solicitação pendente #${o.solicitacao_id} para "${r.espaco_nome}" em horário sobreposto.`);
    }
  }
  return {
    ...s, atividade, espacos, equipamentos, solicitante, historico: hist, movimentacoes: movs, avisos,
    acoes: {
      editar: dono && ['RASCUNHO', 'EM_AJUSTES', 'PENDENTE', 'APROVADA'].includes(s.status) && !temMov,
      enviar: dono && ['RASCUNHO', 'EM_AJUSTES'].includes(s.status),
      decidir: s.status === 'PENDENTE' && temPendenteComp && (p.permitirAutoaprovacao || !dono),
      ajustes: s.status === 'PENDENTE' && (comp.espacos.length + comp.equipamentos.length > 0) && (p.permitirAutoaprovacao || !dono),
      cancelar: !STATUS_FINAIS.includes(s.status) && !retirado && (dono || comp.espacos.length + comp.equipamentos.length > 0),
      concluir: s.status === 'APROVADA' && s.fim <= agoraISO() && !retirado && (dono || pode(ator, 'aprovar_espaco') || pode(ator, 'aprovar_equipamento')),
    },
  };
}

/**
 * Listagem com filtros (RF-13). Solicitantes só veem os próprios pedidos.
 * fila=1 traz a fila de aprovação: pendentes com itens da competência do usuário.
 * Os filtros são montados com "?" (consulta parametrizada), o que evita SQL injection.
 */
function listarSolicitacoes(db, ator, f = {}) {
  const where = [], args = [];
  if (!pode(ator, 'ver_tudo') || f.minhas === '1') { where.push('s.solicitante_id = ?'); args.push(ator.id); }
  if (f.status) { where.push('s.status = ?'); args.push(f.status); }
  if (f.de) { where.push('s.fim > ?'); args.push(paraISO(f.de) || f.de); }
  if (f.ate) { where.push('s.inicio < ?'); args.push(paraISO(f.ate) || f.ate); }
  if (f.espaco_id) { where.push('EXISTS (SELECT 1 FROM reserva_espaco r WHERE r.solicitacao_id = s.id AND r.espaco_id = ?)'); args.push(Number(f.espaco_id)); }
  if (f.equipamento_id) { where.push('EXISTS (SELECT 1 FROM reserva_equipamento r WHERE r.solicitacao_id = s.id AND r.equipamento_id = ?)'); args.push(Number(f.equipamento_id)); }
  if (f.q) { where.push('(a.titulo LIKE ? OR s.motivo LIKE ? OR u.nome LIKE ?)'); const q = `%${f.q}%`; args.push(q, q, q); }
  if (f.fila === '1') {
    // Fila de aprovação: pendentes com itens pendentes da competência do ator
    const partes = [];
    if (pode(ator, 'aprovar_espaco')) partes.push(`EXISTS (SELECT 1 FROM reserva_espaco r WHERE r.solicitacao_id = s.id AND r.status = 'PENDENTE')`);
    if (pode(ator, 'aprovar_equipamento')) partes.push(`EXISTS (SELECT 1 FROM reserva_equipamento r WHERE r.solicitacao_id = s.id AND r.status = 'PENDENTE')`);
    if (!partes.length) throw new ErroNegocio('Acesso negado.', 403);
    where.push(`s.status = 'PENDENTE' AND (${partes.join(' OR ')})`);
  }
  const sql = `
    SELECT s.*, a.titulo, a.tipo, a.publico_estimado, u.nome AS solicitante_nome,
      (SELECT group_concat(e.nome, ', ') FROM reserva_espaco r JOIN espaco e ON e.id = r.espaco_id WHERE r.solicitacao_id = s.id) AS espacos,
      (SELECT group_concat(e.nome || CASE WHEN r.quantidade > 1 THEN ' x' || r.quantidade ELSE '' END, ', ')
         FROM reserva_equipamento r JOIN equipamento e ON e.id = r.equipamento_id WHERE r.solicitacao_id = s.id) AS equipamentos
    FROM solicitacao s JOIN usuario u ON u.id = s.solicitante_id LEFT JOIN atividade a ON a.id = s.atividade_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY s.inicio DESC LIMIT 500`;
  return db.prepare(sql).all(...args);
}

// ---------------------------------------------------------------- escrita de solicitação
/**
 * Grava os itens do pedido. Apaga os antigos e recria: na edição, os itens
 * voltam a PENDENTE e a reserva aprovada é liberada até nova análise (RN-09).
 */
function gravarItens(db, solId, d) {
  db.prepare('DELETE FROM reserva_espaco WHERE solicitacao_id = ?').run(solId);
  db.prepare('DELETE FROM reserva_equipamento WHERE solicitacao_id = ?').run(solId);
  if (d.espaco_id) {
    db.prepare('INSERT INTO reserva_espaco (solicitacao_id, espaco_id, inicio, fim) VALUES (?,?,?,?)').run(solId, d.espaco_id, d.inicio, d.fim);
  }
  for (const e of d.equipamentos) {
    db.prepare('INSERT INTO reserva_equipamento (solicitacao_id, equipamento_id, inicio, fim, quantidade) VALUES (?,?,?,?,?)')
      .run(solId, e.equipamento_id, d.inicio, d.fim, e.quantidade);
  }
}

/**
 * Cria ou atualiza a atividade extracurricular ligada ao pedido (RF-05).
 */
function gravarAtividade(db, atividadeId, ator, d) {
  if (!d.atividade) return null;
  const a = d.atividade;
  const vals = [a.titulo, a.tipo, a.descricao, a.publico_alvo, a.publico_estimado || 0, d.inicio, d.fim]; // rascunho pode ter campos vazios
  if (atividadeId) {
    db.prepare(`UPDATE atividade SET titulo=?, tipo=?, descricao=?, publico_alvo=?, publico_estimado=?, inicio=?, fim=? WHERE id=?`)
      .run(...vals, atividadeId);
    return atividadeId;
  }
  return Number(db.prepare(`INSERT INTO atividade (titulo, tipo, descricao, publico_alvo, publico_estimado, inicio, fim, responsavel_id)
                            VALUES (?,?,?,?,?,?,?,?)`).run(...vals, ator.id).lastInsertRowid);
}

/**
 * Confere se o espaço e os equipamentos informados existem.
 */
function existeRecursos(db, d) {
  if (d.espaco_id && !db.prepare('SELECT 1 FROM espaco WHERE id = ?').get(d.espaco_id)) throw new ErroNegocio('Espaço inexistente.', 422);
  for (const e of d.equipamentos) {
    if (!db.prepare('SELECT 1 FROM equipamento WHERE id = ?').get(e.equipamento_id)) throw new ErroNegocio('Equipamento inexistente.', 422);
  }
}

/**
 * RF-05/06/07: cria a solicitação como RASCUNHO, já com atividade e recursos.
 * Se dados.enviar for true, envia na sequência (é o botão "Enviar para análise").
 */
function criarSolicitacao(db, ator, dados) {
  exigir(ator, 'solicitar'); // RN-01
  const d = normalizar(dados);
  validarDatas(d);
  existeRecursos(db, d);
  const id = transacao(db, () => {
    const atvId = gravarAtividade(db, null, ator, d);
    const agora = agoraISO();
    const solId = Number(db.prepare(`INSERT INTO solicitacao (atividade_id, solicitante_id, inicio, fim, motivo, criada_em, atualizada_em)
                                     VALUES (?,?,?,?,?,?,?)`).run(atvId, ator.id, d.inicio, d.fim, d.motivo, agora, agora).lastInsertRowid);
    gravarItens(db, solId, d);
    historico(db, solId, ator.id, 'CRIADA (rascunho)');
    return solId;
  });
  if (dados && dados.enviar) enviarSolicitacao(db, ator, id);
  return obterSolicitacao(db, ator, id);
}

/**
 * Lê a solicitação do banco no mesmo formato que a tela envia,
 * para reaproveitar as mesmas validações ao enviar um rascunho.
 */
function dadosAtuais(db, id) {
  const { s, atividade, espacos, equipamentos } = carregarDados(db, id);
  return {
    s,
    d: {
      inicio: s.inicio, fim: s.fim, motivo: s.motivo,
      espaco_id: espacos[0]?.espaco_id ?? null,
      equipamentos: equipamentos.map(e => ({ equipamento_id: e.equipamento_id, quantidade: e.quantidade })),
      atividade: atividade && {
        titulo: atividade.titulo, tipo: atividade.tipo, descricao: atividade.descricao,
        publico_alvo: atividade.publico_alvo, publico_estimado: atividade.publico_estimado,
      },
    },
  };
}

/**
 * Envia um rascunho (ou pedido devolvido para ajustes) para análise.
 * Valida campos (CA-06) e disponibilidade (CA-01, CA-03, CA-04); se passar, muda para
 * PENDENTE, registra no histórico e notifica quem aprova.
 */
function enviarSolicitacao(db, ator, id) {
  return transacao(db, () => {
    const { s, d } = dadosAtuais(db, Number(id));
    if (s.solicitante_id !== ator.id) throw new ErroNegocio('Apenas o solicitante pode enviar o pedido.', 403);
    if (!['RASCUNHO', 'EM_AJUSTES'].includes(s.status)) throw new ErroNegocio(`Não é possível enviar uma solicitação ${s.status}.`, 409);
    validarCompleto(d);                                   // CA-06
    const { excepcional, alertas } = validarRecursos(db, d, s.id); // CA-01, CA-03, CA-04
    db.prepare(`UPDATE solicitacao SET status='PENDENTE', excepcional=?, atualizada_em=? WHERE id=?`).run(excepcional ? 1 : 0, agoraISO(), s.id);
    db.prepare(`UPDATE reserva_espaco SET status='PENDENTE' WHERE solicitacao_id=? AND status <> 'CANCELADA'`).run(s.id);
    db.prepare(`UPDATE reserva_equipamento SET status='PENDENTE' WHERE solicitacao_id=? AND status <> 'CANCELADA'`).run(s.id);
    historico(db, s.id, ator.id, s.status === 'EM_AJUSTES' ? 'REENVIADA para análise' : 'ENVIADA para análise',
      excepcional ? 'Requer aprovação excepcional: ' + alertas.join(' ') : null);
    const perms = [d.espaco_id && 'aprovar_espaco', d.equipamentos.length && 'aprovar_equipamento'].filter(Boolean);
    notificarPerfis(db, perms, s.id, `Nova solicitação #${s.id} aguardando análise.`, ator.id);
    return { ok: true, excepcional, alertas };
  });
}

/**
 * Edição do pedido pelo próprio solicitante (RN-09 / CA-08).
 * Se o pedido já estava PENDENTE ou APROVADO, revalida os conflitos e ele volta para
 * análise (PENDENTE). Não permite editar depois que houve retirada de equipamento.
 */
function atualizarSolicitacao(db, ator, id, dados) {
  const novo = normalizar(dados);
  validarDatas(novo);
  existeRecursos(db, novo);
  transacao(db, () => {
    const { s } = dadosAtuais(db, Number(id));
    if (s.solicitante_id !== ator.id) throw new ErroNegocio('Apenas o solicitante pode alterar o pedido.', 403);
    if (!['RASCUNHO', 'EM_AJUSTES', 'PENDENTE', 'APROVADA'].includes(s.status)) {
      throw new ErroNegocio(`Solicitação ${s.status} não pode ser alterada.`, 409);
    }
    const movs = db.prepare(`SELECT COUNT(*) n FROM movimentacao m JOIN reserva_equipamento r ON r.id = m.reserva_equipamento_id
                             WHERE r.solicitacao_id = ?`).get(s.id).n;
    if (movs > 0) throw new ErroNegocio('Há retirada/devolução registrada; cancele e crie nova solicitação.', 409);

    const voltaAnalise = ['PENDENTE', 'APROVADA'].includes(s.status);
    let excepcional = s.excepcional;
    if (voltaAnalise) {
      validarCompleto(novo);
      excepcional = validarRecursos(db, novo, s.id).excepcional ? 1 : 0; // revalida conflitos ignorando a própria solicitação
    }
    const atvId = novo.atividade ? gravarAtividade(db, s.atividade_id, ator, novo) : null;
    db.prepare(`UPDATE solicitacao SET atividade_id=?, inicio=?, fim=?, motivo=?, excepcional=?, status=?, atualizada_em=? WHERE id=?`)
      .run(atvId, novo.inicio, novo.fim, novo.motivo, excepcional, voltaAnalise ? 'PENDENTE' : s.status, agoraISO(), s.id);
    if (!novo.atividade && s.atividade_id) db.prepare('DELETE FROM atividade WHERE id = ?').run(s.atividade_id);
    gravarItens(db, s.id, novo); // itens recriados como PENDENTE: a agenda aprovada é liberada
    historico(db, s.id, ator.id, s.status === 'APROVADA' ? 'ALTERADA após aprovação — retornou para análise' : 'ALTERADA');
    if (voltaAnalise) {
      const perms = [novo.espaco_id && 'aprovar_espaco', novo.equipamentos.length && 'aprovar_equipamento'].filter(Boolean);
      notificarPerfis(db, perms, s.id, `Solicitação #${s.id} foi alterada e precisa de nova análise.`, ator.id);
    }
  });
  return obterSolicitacao(db, ator, id);
}

/**
 * Define o status geral a partir dos itens (RN-18):
 *  - ainda há item pendente     → PENDENTE
 *  - nenhum pendente e algum aprovado → APROVADA (pode ser aprovação parcial)
 *  - todos rejeitados           → REJEITADA
 */
function recalcularStatus(db, solId) {
  const itens = [
    ...db.prepare(`SELECT status FROM reserva_espaco WHERE solicitacao_id=? AND status <> 'CANCELADA'`).all(solId),
    ...db.prepare(`SELECT status FROM reserva_equipamento WHERE solicitacao_id=? AND status <> 'CANCELADA'`).all(solId),
  ].map(i => i.status);
  let st = 'PENDENTE';
  if (!itens.includes('PENDENTE')) st = itens.includes('APROVADA') ? 'APROVADA' : 'REJEITADA';
  db.prepare('UPDATE solicitacao SET status=?, atualizada_em=? WHERE id=?').run(st, agoraISO(), solId);
  return st;
}

/**
 * Verificações comuns a aprovar, rejeitar e pedir ajustes:
 * perfil de gestor (CA-05), pedido pendente, proibição de decidir o próprio pedido (RNF-03)
 * e quais itens pendentes são da competência deste usuário.
 */
function prepararDecisao(db, ator, id) {
  const { s, espacos, equipamentos } = carregarDados(db, Number(id));
  if (!pode(ator, 'aprovar_espaco') && !pode(ator, 'aprovar_equipamento')) {
    throw new ErroNegocio('Acesso negado: apenas gestores podem decidir solicitações.', 403); // CA-05
  }
  if (s.status !== 'PENDENTE') throw new ErroNegocio(`A solicitação está ${s.status}; somente pendentes podem ser decididas.`, 409);
  const p = parametros(db);
  if (!p.permitirAutoaprovacao && s.solicitante_id === ator.id) {
    throw new ErroNegocio('Você não pode decidir a sua própria solicitação (RNF-03).', 403);
  }
  const comp = competencia(ator, espacos, equipamentos);
  const pendEsp = comp.espacos.filter(r => r.status === 'PENDENTE');
  const pendEq = comp.equipamentos.filter(r => r.status === 'PENDENTE');
  return { s, pendEsp, pendEq };
}

/**
 * Aprova os itens da competência do gestor.
 * IMPORTANTE: dentro da transação, a disponibilidade é verificada DE NOVO, porque outro
 * pedido pode ter sido aprovado depois que este foi enviado. É isso que garante o CA-01
 * e o CA-12 (dois aprovadores no mesmo recurso: só um consegue).
 * Pedido "excepcional" (RN-07) exige justificativa. Grava quem aprovou e quando (RN-08).
 */
function aprovar(db, ator, id, justificativa) {
  justificativa = (justificativa || '').trim();
  return transacao(db, () => {
    const { s, pendEsp, pendEq } = prepararDecisao(db, ator, id);
    if (!pendEsp.length && !pendEq.length) throw new ErroNegocio('Não há itens pendentes da sua competência nesta solicitação.', 409);
    if (s.excepcional && !justificativa) {
      throw new ErroNegocio('Solicitação fora da política (RN-07): informe a justificativa da aprovação excepcional.', 422,
        [{ campo: 'justificativa', mensagem: 'Justificativa obrigatória.' }]);
    }
    const atv = s.atividade_id ? db.prepare('SELECT publico_estimado FROM atividade WHERE id=?').get(s.atividade_id) : null;
    const conflitos = [];
    for (const r of pendEsp) {
      conflitos.push(...verificarEspaco(db, r.espaco_id, r.inicio, r.fim, {
        ignorarSolicitacao: s.id, publicoEstimado: atv ? atv.publico_estimado : null,
      }).motivos);
    }
    for (const r of pendEq) {
      conflitos.push(...verificarEquipamento(db, r.equipamento_id, r.inicio, r.fim, r.quantidade, { ignorarSolicitacao: s.id }).motivos);
    }
    if (conflitos.length) throw new ErroNegocio('Não é possível aprovar: há conflito ou indisponibilidade.', 409, conflitos);
    for (const r of pendEsp) db.prepare(`UPDATE reserva_espaco SET status='APROVADA' WHERE id=?`).run(r.id);
    for (const r of pendEq) db.prepare(`UPDATE reserva_equipamento SET status='APROVADA' WHERE id=?`).run(r.id);
    const st = recalcularStatus(db, s.id);
    const itens = [...pendEsp.map(r => r.espaco_nome), ...pendEq.map(r => r.equipamento_nome)].join(', ');
    historico(db, s.id, ator.id, `APROVOU: ${itens}`, justificativa);                    // RN-08
    notificar(db, s.solicitante_id, s.id, `Sua solicitação #${s.id}: ${itens} aprovado(s). Situação: ${st}.`); // RF-10
    return { status: st };
  });
}

/**
 * Rejeita os itens da competência do gestor. Justificativa obrigatória (CA-07).
 */
function rejeitar(db, ator, id, justificativa) {
  justificativa = (justificativa || '').trim();
  if (!justificativa) {
    throw new ErroNegocio('A justificativa é obrigatória para rejeitar.', 422, [{ campo: 'justificativa', mensagem: 'Justificativa obrigatória.' }]); // CA-07
  }
  return transacao(db, () => {
    const { s, pendEsp, pendEq } = prepararDecisao(db, ator, id);
    if (!pendEsp.length && !pendEq.length) throw new ErroNegocio('Não há itens pendentes da sua competência nesta solicitação.', 409);
    for (const r of pendEsp) db.prepare(`UPDATE reserva_espaco SET status='REJEITADA' WHERE id=?`).run(r.id);
    for (const r of pendEq) db.prepare(`UPDATE reserva_equipamento SET status='REJEITADA' WHERE id=?`).run(r.id);
    const st = recalcularStatus(db, s.id);
    const itens = [...pendEsp.map(r => r.espaco_nome), ...pendEq.map(r => r.equipamento_nome)].join(', ');
    historico(db, s.id, ator.id, `REJEITOU: ${itens}`, justificativa);
    notificar(db, s.solicitante_id, s.id, `Sua solicitação #${s.id}: ${itens} rejeitado(s). Motivo: ${justificativa}`);
    return { status: st };
  });
}

/**
 * Devolve o pedido ao solicitante (status EM_AJUSTES) com a explicação do que corrigir.
 */
function solicitarAjustes(db, ator, id, justificativa) {
  justificativa = (justificativa || '').trim();
  if (!justificativa) throw new ErroNegocio('Descreva os ajustes necessários.', 422, [{ campo: 'justificativa', mensagem: 'Justificativa obrigatória.' }]);
  return transacao(db, () => {
    const { s, pendEsp, pendEq } = prepararDecisao(db, ator, id);
    if (!pendEsp.length && !pendEq.length) throw new ErroNegocio('Não há itens pendentes da sua competência nesta solicitação.', 409);
    db.prepare(`UPDATE solicitacao SET status='EM_AJUSTES', atualizada_em=? WHERE id=?`).run(agoraISO(), s.id);
    db.prepare(`UPDATE reserva_espaco SET status='PENDENTE' WHERE solicitacao_id=? AND status <> 'CANCELADA'`).run(s.id);
    db.prepare(`UPDATE reserva_equipamento SET status='PENDENTE' WHERE solicitacao_id=? AND status <> 'CANCELADA'`).run(s.id);
    historico(db, s.id, ator.id, 'DEVOLVEU para ajustes', justificativa);
    notificar(db, s.solicitante_id, s.id, `Sua solicitação #${s.id} precisa de ajustes: ${justificativa}`);
    return { status: 'EM_AJUSTES' };
  });
}

/**
 * Cancela o pedido (RN-10 / CA-09): motivo obrigatório, itens viram CANCELADA
 * e o horário fica livre de novo. Não deixa cancelar com equipamento ainda fora.
 */
function cancelar(db, ator, id, motivo) {
  motivo = (motivo || '').trim();
  if (!motivo) throw new ErroNegocio('Informe o motivo do cancelamento.', 422, [{ campo: 'motivo', mensagem: 'Motivo obrigatório.' }]);
  return transacao(db, () => {
    const { s, espacos, equipamentos } = carregarDados(db, Number(id));
    const dono = s.solicitante_id === ator.id;
    const comp = competencia(ator, espacos, equipamentos);
    if (!dono && comp.espacos.length + comp.equipamentos.length === 0) throw new ErroNegocio('Acesso negado.', 403);
    if (STATUS_FINAIS.includes(s.status)) throw new ErroNegocio(`Solicitação já está ${s.status}.`, 409);
    if (equipamentos.some(e => e.retirada === 'RETIRADO')) {
      throw new ErroNegocio('Há equipamento retirado e não devolvido; registre a devolução antes de cancelar.', 409);
    }
    db.prepare(`UPDATE solicitacao SET status='CANCELADA', atualizada_em=? WHERE id=?`).run(agoraISO(), s.id);
    db.prepare(`UPDATE reserva_espaco SET status='CANCELADA' WHERE solicitacao_id=?`).run(s.id);
    db.prepare(`UPDATE reserva_equipamento SET status='CANCELADA' WHERE solicitacao_id=?`).run(s.id);
    historico(db, s.id, ator.id, 'CANCELOU', motivo);
    if (!dono) notificar(db, s.solicitante_id, s.id, `Sua solicitação #${s.id} foi cancelada por um gestor. Motivo: ${motivo}`);
    return { status: 'CANCELADA' };
  });
}

/**
 * Marca a atividade como realizada: só aprovada, depois do término
 * e com todos os equipamentos devolvidos.
 */
function concluir(db, ator, id) {
  return transacao(db, () => {
    const { s, equipamentos } = carregarDados(db, Number(id));
    const dono = s.solicitante_id === ator.id;
    if (!dono && !pode(ator, 'aprovar_espaco') && !pode(ator, 'aprovar_equipamento')) throw new ErroNegocio('Acesso negado.', 403);
    if (s.status !== 'APROVADA') throw new ErroNegocio('Somente solicitações aprovadas podem ser concluídas.', 409);
    if (s.fim > agoraISO()) throw new ErroNegocio('A atividade ainda não terminou.', 409);
    if (equipamentos.some(e => e.retirada === 'RETIRADO')) throw new ErroNegocio('Há equipamento pendente de devolução.', 409);
    db.prepare(`UPDATE solicitacao SET status='CONCLUIDA', atualizada_em=? WHERE id=?`).run(agoraISO(), s.id);
    historico(db, s.id, ator.id, 'CONCLUIU');
    return { status: 'CONCLUIDA' };
  });
}

// ---------------------------------------------------------------- retirada e devolução (RN-15, RN-16, CA-10, CA-11)
/**
 * Registra a ENTREGA ou a DEVOLUÇÃO de um equipamento (RF-11).
 *  - Entrega (RN-15 / CA-10): só com reserva aprovada; grava quem retirou, quem registrou,
 *    data/hora do servidor e condição.
 *  - Devolução (RN-16 / CA-11): calcula se houve atraso; com avaria, a descrição é obrigatória,
 *    o item individual vira AVARIADO (indisponível) e quem tem reservas futuras dele é avisado.
 */
function registrarMovimentacao(db, ator, dados) {
  exigir(ator, 'movimentar');
  const tipo = String(dados.tipo || '').toUpperCase();
  const pessoa = String(dados.pessoa || '').trim();
  const condicao = String(dados.condicao || 'BOA').toUpperCase();
  const observacao = String(dados.observacao || '').trim().slice(0, 1000) || null;
  const campos = [];
  if (!['ENTREGA', 'DEVOLUCAO'].includes(tipo)) campos.push({ campo: 'tipo', mensagem: 'Tipo deve ser ENTREGA ou DEVOLUCAO.' });
  if (!pessoa) campos.push({ campo: 'pessoa', mensagem: 'Informe quem retirou/devolveu.' });
  if (!['BOA', 'AVARIADO'].includes(condicao)) campos.push({ campo: 'condicao', mensagem: 'Condição deve ser BOA ou AVARIADO.' });
  if (condicao === 'AVARIADO' && !observacao) campos.push({ campo: 'observacao', mensagem: 'Descreva a avaria.' });
  if (campos.length) throw new ErroNegocio('Dados inválidos.', 422, campos);

  return transacao(db, () => {
    const r = db.prepare(`SELECT r.*, s.status AS sol_status, s.solicitante_id, e.nome, e.situacao, e.quantidade_total, c.controle, c.exige_retirada
                          FROM reserva_equipamento r JOIN solicitacao s ON s.id = r.solicitacao_id
                          JOIN equipamento e ON e.id = r.equipamento_id JOIN categoria c ON c.id = e.categoria_id
                          WHERE r.id = ?`).get(Number(dados.reserva_equipamento_id));
    if (!r) throw new ErroNegocio('Reserva de equipamento não encontrada.', 404);
    const agora = agoraISO();
    let atraso = 0;
    if (tipo === 'ENTREGA') {
      if (r.status !== 'APROVADA' || r.sol_status !== 'APROVADA') throw new ErroNegocio('Só é possível entregar equipamento com reserva aprovada.', 409);
      if (r.retirada !== 'NAO_RETIRADO') throw new ErroNegocio('Este equipamento já foi retirado nesta reserva.', 409);
      if (r.situacao !== 'DISPONIVEL') throw new ErroNegocio(`Equipamento está ${r.situacao}; não pode ser entregue.`, 409);
      if (r.controle === 'INDIVIDUAL') {
        const fora = db.prepare(`SELECT solicitacao_id FROM reserva_equipamento WHERE equipamento_id=? AND retirada='RETIRADO' AND id<>?`).get(r.equipamento_id, r.id);
        if (fora) throw new ErroNegocio(`O item ainda não foi devolvido pela solicitação #${fora.solicitacao_id}.`, 409);
      }
      db.prepare(`UPDATE reserva_equipamento SET retirada='RETIRADO' WHERE id=?`).run(r.id);
    } else {
      if (r.retirada !== 'RETIRADO') throw new ErroNegocio('Este equipamento não está retirado.', 409);
      atraso = agora > r.fim ? 1 : 0;
      db.prepare(`UPDATE reserva_equipamento SET retirada='DEVOLVIDO' WHERE id=?`).run(r.id);
      if (condicao === 'AVARIADO') {
        if (r.controle === 'INDIVIDUAL') {
          db.prepare(`UPDATE equipamento SET situacao='AVARIADO' WHERE id=?`).run(r.equipamento_id); // CA-11
        } else {
          const qtd = Math.min(r.quantidade, Math.max(1, parseInt(dados.quantidade_avariada, 10) || 1));
          db.prepare(`UPDATE equipamento SET quantidade_total = MAX(quantidade_total - ?, 0) WHERE id=?`).run(qtd, r.equipamento_id);
        }
        avisarReservasAfetadas(db, 'EQUIPAMENTO', r.equipamento_id, agora, '9999-12-31T00:00:00.000Z',
          `O equipamento "${r.nome}" foi devolvido com avaria e pode não estar disponível.`);
      }
    }
    const movId = Number(db.prepare(`INSERT INTO movimentacao (reserva_equipamento_id, tipo, responsavel_id, pessoa, data_hora, condicao, atraso, observacao)
                                     VALUES (?,?,?,?,?,?,?,?)`).run(r.id, tipo, ator.id, pessoa, agora, condicao, atraso, observacao).lastInsertRowid);
    const texto = tipo === 'ENTREGA' ? `ENTREGA de ${r.nome} para ${pessoa}` :
      `DEVOLUÇÃO de ${r.nome} por ${pessoa} (${condicao}${atraso ? ', COM ATRASO' : ''})`;
    historico(db, r.solicitacao_id, ator.id, texto, observacao);
    return db.prepare('SELECT * FROM movimentacao WHERE id=?').get(movId);
  });
}

/**
 * Dados da tela Equipamentos: o que retirar, o que está fora (e atrasado)
 * e as últimas ocorrências (avarias e atrasos).
 */
function painelEquipamentos(db) {
  const base = `SELECT r.*, e.nome, e.codigo_patrimonio, c.controle, c.exige_retirada, u.nome AS solicitante_nome, a.titulo
                FROM reserva_equipamento r JOIN solicitacao s ON s.id = r.solicitacao_id JOIN equipamento e ON e.id = r.equipamento_id
                JOIN categoria c ON c.id = e.categoria_id JOIN usuario u ON u.id = s.solicitante_id LEFT JOIN atividade a ON a.id = s.atividade_id`;
  const agora = agoraISO();
  return {
    aRetirar: db.prepare(`${base} WHERE r.status='APROVADA' AND s.status='APROVADA' AND r.retirada='NAO_RETIRADO' AND r.fim > ? ORDER BY r.inicio`).all(agora),
    retirados: db.prepare(`${base} WHERE r.retirada='RETIRADO' ORDER BY r.fim`).all().map(r => ({ ...r, atrasado: r.fim < agora })),
    ocorrencias: db.prepare(`SELECT m.*, e.nome, u.nome AS responsavel_nome FROM movimentacao m
                             JOIN reserva_equipamento r ON r.id = m.reserva_equipamento_id JOIN equipamento e ON e.id = r.equipamento_id
                             JOIN usuario u ON u.id = m.responsavel_id WHERE m.condicao='AVARIADO' OR m.atraso=1 ORDER BY m.id DESC LIMIT 50`).all(),
  };
}

// ---------------------------------------------------------------- bloqueios e exceções
/**
 * Avisa os donos das reservas que caem num período (usado quando um bloqueio
 * é criado ou um equipamento quebra) e devolve a lista para mostrar na tela.
 */
function avisarReservasAfetadas(db, tipo, recursoId, inicio, fim, mensagem) {
  const tabela = tipo === 'ESPACO' ? 'reserva_espaco' : 'reserva_equipamento';
  const col = tipo === 'ESPACO' ? 'espaco_id' : 'equipamento_id';
  const afetadas = db.prepare(`SELECT r.*, s.solicitante_id FROM ${tabela} r JOIN solicitacao s ON s.id = r.solicitacao_id
                               WHERE r.${col} = ? AND r.status IN ('APROVADA','PENDENTE') AND s.status IN ('APROVADA','PENDENTE') AND r.fim > ?`)
    .all(recursoId, agoraISO()).filter(r => sobrepoe(inicio, fim, r.inicio, r.fim));
  for (const r of afetadas) notificar(db, r.solicitante_id, r.solicitacao_id, `${mensagem} (sua solicitação #${r.solicitacao_id}).`);
  return afetadas.map(r => ({ solicitacao_id: r.solicitacao_id, inicio: r.inicio, fim: r.fim, status: r.status }));
}

/**
 * Cria um bloqueio de manutenção/indisponibilidade (RN-05).
 * Se já existirem reservas no período (exceção 10.4), o bloqueio é criado mesmo assim,
 * mas a tela mostra as reservas afetadas e os solicitantes são notificados.
 * O cancelamento fica a critério do gestor.
 */
function criarBloqueio(db, ator, dados) {
  exigir(ator, 'bloquear');
  const tipo = String(dados.tipo_recurso || '').toUpperCase();
  if (tipo === 'ESPACO' && !pode(ator, 'gerir_espacos')) throw new ErroNegocio('Acesso negado.', 403);
  if (tipo === 'EQUIPAMENTO' && !pode(ator, 'gerir_equipamentos')) throw new ErroNegocio('Acesso negado.', 403);
  const inicio = paraISO(dados.inicio), fim = paraISO(dados.fim);
  const motivo = String(dados.motivo || '').trim();
  const campos = [];
  if (!['ESPACO', 'EQUIPAMENTO'].includes(tipo)) campos.push({ campo: 'tipo_recurso', mensagem: 'Tipo inválido.' });
  if (!inicio || !fim || fim <= inicio) campos.push({ campo: 'fim', mensagem: 'Período inválido.' });
  if (!motivo) campos.push({ campo: 'motivo', mensagem: 'Motivo obrigatório.' });
  if (campos.length) throw new ErroNegocio('Dados inválidos.', 422, campos);
  return transacao(db, () => {
    const id = Number(db.prepare('INSERT INTO bloqueio (tipo_recurso, recurso_id, inicio, fim, motivo, criado_por) VALUES (?,?,?,?,?,?)')
      .run(tipo, Number(dados.recurso_id), inicio, fim, motivo, ator.id).lastInsertRowid);
    // Exceção 10.4: bloqueio criado com reservas já existentes — não cancela automaticamente, avisa e devolve a lista.
    const afetadas = avisarReservasAfetadas(db, tipo, Number(dados.recurso_id), inicio, fim, `Foi criado um bloqueio (${motivo}) que coincide com sua reserva`);
    log(db, ator.id, 'BLOQUEIO_CRIADO', `#${id} ${tipo} ${dados.recurso_id} ${inicio}–${fim}`);
    return { id, afetadas };
  });
}

/**
 * Lista os bloqueios com o nome do recurso (espaço ou equipamento).
 */
function listarBloqueios(db) {
  return db.prepare(`SELECT b.*, CASE b.tipo_recurso WHEN 'ESPACO' THEN (SELECT nome FROM espaco WHERE id=b.recurso_id)
                     ELSE (SELECT nome FROM equipamento WHERE id=b.recurso_id) END AS recurso_nome, u.nome AS criado_por_nome
                     FROM bloqueio b JOIN usuario u ON u.id = b.criado_por ORDER BY b.inicio DESC`).all();
}

/**
 * Remove um bloqueio e registra no log.
 */
function excluirBloqueio(db, ator, id) {
  exigir(ator, 'bloquear');
  const b = db.prepare('SELECT * FROM bloqueio WHERE id=?').get(Number(id));
  if (!b) throw new ErroNegocio('Bloqueio não encontrado.', 404);
  db.prepare('DELETE FROM bloqueio WHERE id=?').run(b.id);
  log(db, ator.id, 'BLOQUEIO_REMOVIDO', `#${b.id} ${b.motivo}`);
  return { ok: true };
}

// ---------------------------------------------------------------- agenda (RF-04, RF-16)
/**
 * Monta os eventos do calendário (RF-04): reservas de espaços, de equipamentos
 * e bloqueios no período, com filtros. Com publica = true (RF-16), devolve só eventos
 * aprovados de espaços, sem nome de solicitante (LGPD, RNF-07).
 */
function agenda(db, f = {}, publica = false) {
  const inicio = paraISO(f.inicio) || new Date(Date.now() - 7 * 864e5).toISOString();
  const fim = paraISO(f.fim) || new Date(Date.now() + 30 * 864e5).toISOString();
  const statusAceitos = publica ? ['APROVADA'] : (f.status ? [f.status] : ['APROVADA', 'PENDENTE']);
  const ph = statusAceitos.map(() => '?').join(',');
  const eventos = [];
  if (!f.equipamento_id) {
    const args = [...statusAceitos, fim, inicio];
    let filtro = '';
    if (f.espaco_id) { filtro = ' AND r.espaco_id = ?'; args.push(Number(f.espaco_id)); }
    for (const r of db.prepare(`SELECT r.*, e.nome AS recurso, a.titulo, a.tipo, s.status AS sol_status
                                FROM reserva_espaco r JOIN espaco e ON e.id = r.espaco_id JOIN solicitacao s ON s.id = r.solicitacao_id
                                LEFT JOIN atividade a ON a.id = s.atividade_id
                                WHERE r.status IN (${ph}) AND r.inicio < ? AND r.fim > ?${filtro} ORDER BY r.inicio`).all(...args)) {
      eventos.push({ tipo: 'ESPACO', recurso: r.recurso, inicio: r.inicio, fim: r.fim, status: r.status,
        titulo: r.titulo || (publica ? 'Reservado' : 'Reserva de espaço'), atividade_tipo: r.tipo,
        solicitacao_id: publica ? undefined : r.solicitacao_id });
    }
  }
  if (!publica && !f.espaco_id) {
    const args = [...statusAceitos, fim, inicio];
    let filtro = '';
    if (f.equipamento_id) { filtro = ' AND r.equipamento_id = ?'; args.push(Number(f.equipamento_id)); }
    for (const r of db.prepare(`SELECT r.*, e.nome AS recurso, a.titulo FROM reserva_equipamento r JOIN equipamento e ON e.id = r.equipamento_id
                                JOIN solicitacao s ON s.id = r.solicitacao_id LEFT JOIN atividade a ON a.id = s.atividade_id
                                WHERE r.status IN (${ph}) AND r.inicio < ? AND r.fim > ?${filtro} ORDER BY r.inicio`).all(...args)) {
      eventos.push({ tipo: 'EQUIPAMENTO', recurso: r.recurso + (r.quantidade > 1 ? ` (x${r.quantidade})` : ''), inicio: r.inicio, fim: r.fim,
        status: r.status, titulo: r.titulo || 'Empréstimo de equipamento', solicitacao_id: r.solicitacao_id });
    }
  }
  if (!publica) {
    for (const b of listarBloqueios(db).filter(b => b.inicio < fim && b.fim > inicio)) {
      if (f.espaco_id && !(b.tipo_recurso === 'ESPACO' && b.recurso_id === Number(f.espaco_id))) continue;
      if (f.equipamento_id && !(b.tipo_recurso === 'EQUIPAMENTO' && b.recurso_id === Number(f.equipamento_id))) continue;
      eventos.push({ tipo: 'BLOQUEIO', recurso: b.recurso_nome, inicio: b.inicio, fim: b.fim, status: 'BLOQUEADO', titulo: b.motivo });
    }
  }
  return eventos.sort((a, b) => a.inicio.localeCompare(b.inicio));
}

// ---------------------------------------------------------------- cadastros
/**
 * Cadastra ou edita um espaço (RF-02). Sem "id" cria; com "id" atualiza.
 */
function salvarEspaco(db, ator, dados, id) {
  exigir(ator, 'gerir_espacos');
  const nome = String(dados.nome || '').trim();
  const capacidade = parseInt(dados.capacidade, 10);
  const campos = [];
  if (!nome) campos.push({ campo: 'nome', mensagem: 'Nome obrigatório.' });
  if (!(capacidade > 0)) campos.push({ campo: 'capacidade', mensagem: 'Capacidade deve ser maior que zero.' });
  if (campos.length) throw new ErroNegocio('Dados inválidos.', 422, campos);
  const vals = [nome, String(dados.localizacao || '').trim(), capacidade, dados.ativo === false || dados.ativo === 0 ? 0 : 1];
  if (id) {
    db.prepare('UPDATE espaco SET nome=?, localizacao=?, capacidade=?, ativo=? WHERE id=?').run(...vals, Number(id));
    log(db, ator.id, 'ESPACO_ALTERADO', `#${id} ${nome}`);
    return db.prepare('SELECT * FROM espaco WHERE id=?').get(Number(id));
  }
  const novo = Number(db.prepare('INSERT INTO espaco (nome, localizacao, capacidade, ativo) VALUES (?,?,?,?)').run(...vals).lastInsertRowid);
  log(db, ator.id, 'ESPACO_CRIADO', `#${novo} ${nome}`);
  return db.prepare('SELECT * FROM espaco WHERE id=?').get(novo);
}

/**
 * Lista os equipamentos com a categoria e o tipo de controle.
 */
function listarEquipamentos(db) {
  return db.prepare(`SELECT e.*, c.nome AS categoria, c.controle, c.exige_retirada FROM equipamento e
                     JOIN categoria c ON c.id = e.categoria_id ORDER BY c.nome, e.nome`).all();
}

/**
 * Cadastra ou edita um equipamento (RF-03 / RN-11). O código de patrimônio é único.
 * Se o item deixar de estar DISPONIVEL, avisa quem tem reservas futuras dele.
 */
function salvarEquipamento(db, ator, dados, id) {
  exigir(ator, 'gerir_equipamentos');
  const codigo = String(dados.codigo_patrimonio || '').trim();
  const nome = String(dados.nome || '').trim();
  const categoria = db.prepare('SELECT * FROM categoria WHERE id=?').get(Number(dados.categoria_id));
  const situacao = String(dados.situacao || 'DISPONIVEL').toUpperCase();
  const quantidade = categoria && categoria.controle === 'INDIVIDUAL' ? 1 : parseInt(dados.quantidade_total, 10);
  const campos = [];
  if (!codigo) campos.push({ campo: 'codigo_patrimonio', mensagem: 'Código/patrimônio obrigatório (RN-11).' });
  if (!nome) campos.push({ campo: 'nome', mensagem: 'Nome obrigatório.' });
  if (!categoria) campos.push({ campo: 'categoria_id', mensagem: 'Categoria obrigatória.' });
  if (!['DISPONIVEL', 'MANUTENCAO', 'AVARIADO', 'INATIVO'].includes(situacao)) campos.push({ campo: 'situacao', mensagem: 'Situação inválida.' });
  if (!(quantidade >= 0)) campos.push({ campo: 'quantidade_total', mensagem: 'Quantidade inválida.' });
  if (campos.length) throw new ErroNegocio('Dados inválidos.', 422, campos);
  const dup = db.prepare('SELECT id FROM equipamento WHERE codigo_patrimonio=? AND id<>?').get(codigo, Number(id) || 0);
  if (dup) throw new ErroNegocio('Já existe equipamento com este código.', 409);
  return transacao(db, () => {
    const vals = [codigo, nome, categoria.id, situacao, String(dados.localizacao || '').trim(), quantidade];
    let eid = Number(id);
    let afetadas = [];
    if (id) {
      const antes = db.prepare('SELECT situacao FROM equipamento WHERE id=?').get(eid);
      if (!antes) throw new ErroNegocio('Equipamento não encontrado.', 404);
      db.prepare('UPDATE equipamento SET codigo_patrimonio=?, nome=?, categoria_id=?, situacao=?, localizacao=?, quantidade_total=? WHERE id=?').run(...vals, eid);
      if (antes.situacao === 'DISPONIVEL' && situacao !== 'DISPONIVEL') {
        afetadas = avisarReservasAfetadas(db, 'EQUIPAMENTO', eid, agoraISO(), '9999-12-31T00:00:00.000Z',
          `O equipamento "${nome}" passou para ${situacao}`);
      }
      log(db, ator.id, 'EQUIPAMENTO_ALTERADO', `#${eid} ${nome} → ${situacao}`);
    } else {
      eid = Number(db.prepare('INSERT INTO equipamento (codigo_patrimonio, nome, categoria_id, situacao, localizacao, quantidade_total) VALUES (?,?,?,?,?,?)')
        .run(...vals).lastInsertRowid);
      log(db, ator.id, 'EQUIPAMENTO_CRIADO', `#${eid} ${nome}`);
    }
    return { ...db.prepare('SELECT * FROM equipamento WHERE id=?').get(eid), afetadas };
  });
}

/**
 * Cria uma categoria: INDIVIDUAL (item com patrimônio) ou QUANTIDADE (estoque).
 */
function salvarCategoria(db, ator, dados) {
  exigir(ator, 'gerir_equipamentos');
  const nome = String(dados.nome || '').trim();
  const controle = String(dados.controle || '').toUpperCase();
  if (!nome || !['INDIVIDUAL', 'QUANTIDADE'].includes(controle)) throw new ErroNegocio('Informe nome e controle (INDIVIDUAL/QUANTIDADE).', 422);
  const id = Number(db.prepare('INSERT INTO categoria (nome, controle, exige_retirada) VALUES (?,?,?)').run(nome, controle, dados.exige_retirada === false ? 0 : 1).lastInsertRowid);
  log(db, ator.id, 'CATEGORIA_CRIADA', nome);
  return db.prepare('SELECT * FROM categoria WHERE id=?').get(id);
}

// ---------------------------------------------------------------- administração
/**
 * Lista usuários (somente administrador).
 */
function listarUsuarios(db, ator) {
  exigir(ator, 'admin');
  return db.prepare('SELECT id, nome, email, perfil_id, ativo FROM usuario ORDER BY nome').all();
}

/**
 * Cadastra ou edita usuário (somente administrador). Valida e-mail e senha
 * mínima, e impede o admin de tirar o próprio acesso. Desativar um usuário derruba as sessões dele.
 */
function salvarUsuario(db, ator, dados, id) {
  exigir(ator, 'admin');
  const nome = String(dados.nome || '').trim();
  const email = String(dados.email || '').trim().toLowerCase();
  const perfil = String(dados.perfil_id || '');
  const campos = [];
  if (!nome) campos.push({ campo: 'nome', mensagem: 'Nome obrigatório.' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) campos.push({ campo: 'email', mensagem: 'E-mail inválido.' });
  if (!PERMISSOES[perfil]) campos.push({ campo: 'perfil_id', mensagem: 'Perfil inválido.' });
  if (!id && String(dados.senha || '').length < 8) campos.push({ campo: 'senha', mensagem: 'Senha com no mínimo 8 caracteres.' });
  if (campos.length) throw new ErroNegocio('Dados inválidos.', 422, campos);
  const dup = db.prepare('SELECT id FROM usuario WHERE email=? AND id<>?').get(email, Number(id) || 0);
  if (dup) throw new ErroNegocio('E-mail já cadastrado.', 409);
  const ativo = dados.ativo === false || dados.ativo === 0 ? 0 : 1;
  if (id) {
    if (Number(id) === ator.id && (perfil !== 'ADMIN' || !ativo)) throw new ErroNegocio('Você não pode remover seu próprio acesso de administrador.', 409);
    db.prepare('UPDATE usuario SET nome=?, email=?, perfil_id=?, ativo=? WHERE id=?').run(nome, email, perfil, ativo, Number(id));
    if (dados.senha) {
      if (String(dados.senha).length < 8) throw new ErroNegocio('Senha com no mínimo 8 caracteres.', 422);
      db.prepare('UPDATE usuario SET senha_hash=? WHERE id=?').run(hashSenha(String(dados.senha)), Number(id));
    }
    if (!ativo) db.prepare('DELETE FROM sessao WHERE usuario_id=?').run(Number(id));
    log(db, ator.id, 'USUARIO_ALTERADO', `#${id} ${email} ${perfil} ativo=${ativo}`);
    return { id: Number(id) };
  }
  const novo = Number(db.prepare('INSERT INTO usuario (nome, email, senha_hash, perfil_id, ativo) VALUES (?,?,?,?,?)')
    .run(nome, email, hashSenha(String(dados.senha)), perfil, ativo).lastInsertRowid);
  log(db, ator.id, 'USUARIO_CRIADO', `#${novo} ${email} ${perfil}`);
  return { id: novo };
}

/**
 * Lista os parâmetros configuráveis.
 */
function listarParametros(db) { return db.prepare('SELECT * FROM parametro ORDER BY chave').all(); }

/**
 * Atualiza parâmetros (somente admin). Só aceita chaves que já existem.
 */
function salvarParametros(db, ator, valores) {
  exigir(ator, 'admin');
  const permitidos = new Set(listarParametros(db).map(p => p.chave));
  for (const [k, v] of Object.entries(valores || {})) {
    if (!permitidos.has(k)) continue;
    db.prepare('UPDATE parametro SET valor=? WHERE chave=?').run(String(v), k);
    log(db, ator.id, 'PARAMETRO_ALTERADO', `${k}=${v}`);
  }
  return listarParametros(db);
}

/**
 * Últimas 300 linhas do log de auditoria (somente admin).
 */
function listarLogs(db, ator) {
  exigir(ator, 'admin');
  return db.prepare(`SELECT l.*, u.nome AS usuario_nome FROM log_auditoria l LEFT JOIN usuario u ON u.id = l.usuario_id
                     ORDER BY l.id DESC LIMIT 300`).all();
}

// ---------------------------------------------------------------- relatórios (RF-13, RF-14)
/**
 * Relatório de utilização (RF-13): número de reservas aprovadas e horas
 * de uso de cada espaço e equipamento no período, e total de pedidos por status.
 */
function relatorioUtilizacao(db, ator, f = {}) {
  exigir(ator, 'relatorios');
  const inicio = paraISO(f.de) || new Date(Date.now() - 30 * 864e5).toISOString();
  const fim = paraISO(f.ate) || new Date(Date.now() + 30 * 864e5).toISOString();
  const horas = `ROUND(SUM((julianday(MIN(r.fim, ?)) - julianday(MAX(r.inicio, ?))) * 24), 1)`;
  return {
    periodo: { inicio, fim },
    espacos: db.prepare(`SELECT e.nome, COUNT(r.id) AS reservas, COALESCE(${horas}, 0) AS horas
                         FROM espaco e LEFT JOIN reserva_espaco r ON r.espaco_id = e.id AND r.status='APROVADA' AND r.inicio < ? AND r.fim > ?
                         GROUP BY e.id ORDER BY horas DESC`).all(fim, inicio, fim, inicio),
    equipamentos: db.prepare(`SELECT e.nome, COUNT(r.id) AS reservas, COALESCE(${horas}, 0) AS horas
                              FROM equipamento e LEFT JOIN reserva_equipamento r ON r.equipamento_id = e.id AND r.status='APROVADA' AND r.inicio < ? AND r.fim > ?
                              GROUP BY e.id ORDER BY horas DESC`).all(fim, inicio, fim, inicio),
    porStatus: db.prepare(`SELECT status, COUNT(*) AS total FROM solicitacao WHERE inicio < ? AND fim > ? GROUP BY status`).all(fim, inicio),
  };
}

/**
 * Exporta as solicitações em CSV (RF-14) separado por ";" (abre direto no Excel).
 * Datas no formato brasileiro (dd/mm/aaaa hh:mm), no fuso da unidade.
 * O "\uFEFF" no começo faz o Excel reconhecer os acentos. Valores que começam com
 * = + - @ ganham um apóstrofo, para não virarem fórmula (injeção de CSV).
 */
function csvSolicitacoes(db, ator, f) {
  exigir(ator, 'relatorios');
  const linhas = listarSolicitacoes(db, ator, f);
  const fuso = parametros(db).fuso;
  const br = (iso) => fmtLocal(iso, fuso).replace(',', ''); // "26/11/2026 14:00" (formato brasileiro)
  const cab = ['id', 'status', 'titulo', 'solicitante', 'inicio', 'fim', 'espacos', 'equipamentos', 'excepcional'];
  const esc = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@]/.test(s)) s = "'" + s; // evita injeção de fórmula no Excel
    return `"${s.replace(/"/g, '""')}"`;
  };
  return '﻿' + [cab.join(';'), ...linhas.map(l => [l.id, l.status, l.titulo, l.solicitante_nome, br(l.inicio), br(l.fim), l.espacos, l.equipamentos, l.excepcional ? 'sim' : 'não'].map(esc).join(';'))].join('\r\n');
}

// ---------------------------------------------------------------- painel e notificações
/**
 * Números do painel inicial: minhas solicitações, tamanho da fila,
 * equipamentos a retirar/atrasados e próximos eventos.
 */
function painel(db, ator) {
  const minhas = listarSolicitacoes(db, ator, { minhas: '1' }).slice(0, 5);
  let fila = 0;
  if (pode(ator, 'aprovar_espaco') || pode(ator, 'aprovar_equipamento')) fila = listarSolicitacoes(db, ator, { fila: '1' }).length;
  const eq = pode(ator, 'movimentar') ? painelEquipamentos(db) : null;
  return {
    minhas, fila,
    aRetirar: eq ? eq.aRetirar.length : 0,
    atrasados: eq ? eq.retirados.filter(r => r.atrasado).length : 0,
    proximos: agenda(db, { inicio: agoraISO(), fim: new Date(Date.now() + 7 * 864e5).toISOString(), status: 'APROVADA' }).slice(0, 8),
  };
}

/**
 * Últimas 50 notificações do usuário.
 */
function notificacoes(db, ator) {
  return db.prepare('SELECT * FROM notificacao WHERE usuario_id=? ORDER BY id DESC LIMIT 50').all(ator.id);
}
/**
 * Marca todas as notificações do usuário como lidas.
 */
function marcarLidas(db, ator) {
  db.prepare('UPDATE notificacao SET lida=1 WHERE usuario_id=?').run(ator.id);
  return { ok: true };
}

module.exports = {
  PERMISSOES, pode, parametros, log,
  verificarEspaco, verificarEquipamento, consultarDisponibilidade, espacosComDisponibilidade,
  criarSolicitacao, atualizarSolicitacao, enviarSolicitacao, obterSolicitacao, listarSolicitacoes,
  aprovar, rejeitar, solicitarAjustes, cancelar, concluir,
  registrarMovimentacao, painelEquipamentos,
  criarBloqueio, listarBloqueios, excluirBloqueio, agenda,
  salvarEspaco, listarEquipamentos, salvarEquipamento, salvarCategoria,
  listarUsuarios, salvarUsuario, listarParametros, salvarParametros, listarLogs,
  relatorioUtilizacao, csvSolicitacoes, painel, notificacoes, marcarLidas,
};
