// =============================================================================
// public/js/app.js — interface do sistema (tudo que roda no navegador).
//
// É uma "SPA" (single page application): existe um único index.html e este
// script troca o conteúdo da área principal conforme o endereço depois do #
// (ex.: #/agenda, #/nova, #/solicitacao/3). Cada tela é uma função "telaXxx".
//
// A interface só conversa com o servidor pela função api(). As validações feitas
// aqui servem para avisar o usuário mais rápido; o servidor valida tudo de novo (RNF-02).
//
// Organização: utilitários → layout/menu/notificações → rotas → uma função por tela.
// =============================================================================
'use strict';

/**
 * Atalhos para buscar elementos na página: $('#id') pega um, $$('.classe') pega vários.
 */
const $ = (sel, raiz = document) => raiz.querySelector(sel);
const $$ = (sel, raiz = document) => [...raiz.querySelectorAll(sel)];
const conteudo = $('#conteudo');
/**
 * Estado global da interface: usuário logado e um cache de listas que mudam pouco
 * (espaços, equipamentos), para não buscar no servidor a cada tela.
 */
const estado = { usuario: null, cache: {} };

// ------------------------------------------------------------ utilitários
/**
 * IMPORTANTE (segurança): troca < > & " ' por códigos HTML antes de colocar texto na página.
 * Sem isso, alguém poderia escrever um <script> no título de um evento e ele rodaria
 * no navegador de outra pessoa (ataque XSS). Todo texto vindo do banco passa por esc().
 */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/**
 * true se o usuário logado tem a permissão. Usado só para mostrar/esconder botões;
 * quem realmente decide é o servidor.
 */
const pode = (p) => !!estado.usuario && estado.usuario.permissoes.includes(p);
/**
 * Funções de formatação de datas no padrão brasileiro, no fuso do navegador (RNF-06).
 */
const fmtDataHora = (iso) => iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
const fmtHora = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const fmtData = (iso) => new Date(iso).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
/**
 * Mostra "26/11/2026 14:00–16:00" ou as duas datas completas se o período passar de um dia.
 */
const fmtPeriodo = (i, f) => {
  const mesmoDia = new Date(i).toDateString() === new Date(f).toDateString();
  return mesmoDia ? `${new Date(i).toLocaleDateString('pt-BR')} ${fmtHora(i)}–${fmtHora(f)}` : `${fmtDataHora(i)} → ${fmtDataHora(f)}`;
};
/**
 * Converte Date para "AAAA-MM-DD" (formato técnico, usado internamente).
 */
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/**
 * Converte Date para "HH:MM" no formato 24 horas.
 */
const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
/**
 * Formato brasileiro para os campos de data: Date → "dd/mm/aaaa".
 */
const dataBR = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;

/**
 * Lê uma data digitada no formato brasileiro ("dd/mm/aaaa") e, opcionalmente, uma hora ("hh:mm", 24 h).
 * Retorna um Date no horário local ou null se for inválida (ex.: 31/02/2026 ou 25:00).
 * Os campos de data/hora do sistema são de texto com máscara, para ficarem sempre no padrão
 * brasileiro: os campos nativos do navegador mudam de formato conforme o idioma do Chrome.
 */
function lerDataBR(texto, hora = '00:00') {
  const md = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(texto || '').trim());
  const mh = /^(\d{2}):(\d{2})$/.exec(String(hora || '').trim());
  if (!md || !mh) return null;
  const [dia, mes, ano] = [Number(md[1]), Number(md[2]), Number(md[3])];
  const [h, m] = [Number(mh[1]), Number(mh[2])];
  if (h > 23 || m > 59) return null;
  const d = new Date(ano, mes - 1, dia, h, m, 0, 0);
  // Se o dia não existe (ex.: 31/02), o Date "pula" para o mês seguinte; aqui isso é recusado.
  return d.getFullYear() === ano && d.getMonth() === mes - 1 && d.getDate() === dia ? d : null;
}

/**
 * Campo de data no padrão brasileiro (dd/mm/aaaa). A máscara é aplicada pelo evento "input" abaixo.
 */
const campoData = (id, nome, valor) =>
  `<input id="${id}" name="${nome}" type="text" inputmode="numeric" maxlength="10" placeholder="dd/mm/aaaa" autocomplete="off" data-mascara="data" value="${valor ? dataBR(valor) : ''}">`;

/**
 * Campo de hora no formato 24 horas (hh:mm).
 */
const campoHora = (id, nome, valor) =>
  `<input id="${id}" name="${nome}" type="text" inputmode="numeric" maxlength="5" placeholder="hh:mm" autocomplete="off" data-mascara="hora" value="${valor || ''}">`;

/**
 * Máscara automática: enquanto o usuário digita só números, as barras ("/") e os dois-pontos (":")
 * são inseridos sozinhos. Ex.: digitar 26112026 vira 26/11/2026; digitar 1430 vira 14:30.
 */
document.addEventListener('input', (e) => {
  const el = e.target;
  if (!el.dataset || !el.dataset.mascara) return;
  const n = el.value.replace(/\D/g, '');
  if (el.dataset.mascara === 'data') {
    el.value = n.slice(0, 2) + (n.length > 2 ? '/' + n.slice(2, 4) : '') + (n.length > 4 ? '/' + n.slice(4, 8) : '');
  } else {
    el.value = n.slice(0, 2) + (n.length > 2 ? ':' + n.slice(2, 4) : '');
  }
});
/**
 * Texto amigável de cada status que vem do banco (ex.: EM_AJUSTES → "Em ajustes").
 */
const ROTULO_STATUS = {
  RASCUNHO: 'Rascunho', PENDENTE: 'Pendente', EM_AJUSTES: 'Em ajustes', APROVADA: 'Aprovada', REJEITADA: 'Rejeitada',
  CANCELADA: 'Cancelada', CONCLUIDA: 'Concluída', NAO_RETIRADO: 'Não retirado', RETIRADO: 'Retirado', DEVOLVIDO: 'Devolvido',
  DISPONIVEL: 'Disponível', MANUTENCAO: 'Manutenção', AVARIADO: 'Avariado', INATIVO: 'Inativo', BLOQUEADO: 'Bloqueado', ATRASADO: 'Atrasado',
};
/**
 * Etiqueta colorida de status. Tem cor E texto, para não depender só da cor (acessibilidade).
 */
const badge = (st) => `<span class="badge st-${esc(st)}">${esc(ROTULO_STATUS[st] || st)}</span>`;
const PERFIS = { SOLICITANTE: 'Solicitante', GESTOR_ESPACOS: 'Gestor de espaços', RESP_EQUIPAMENTOS: 'Resp. equipamentos', ADMIN: 'Administrador' };
const TIPOS_ATIVIDADE = ['Palestra', 'Oficina', 'Minicurso', 'Seminário', 'Apresentação', 'Reunião de projeto', 'Atividade cultural', 'Ação de extensão', 'Outro'];

/**
 * Mensagem flutuante no canto da tela (sucesso, erro ou aviso).
 * Mostra no máximo 3 por vez e some sozinha depois de alguns segundos.
 */
function toast(msg, tipo = '', detalhes) {
  const t = document.createElement('div');
  t.className = `toast ${tipo}`;
  const lista = (detalhes || []).map(d => `<li>${esc(typeof d === 'string' ? d : d.mensagem)}</li>`).join('');
  t.innerHTML = `${esc(msg)}${lista ? `<ul>${lista}</ul>` : ''}`;
  const caixa = $('#toasts');
  caixa.appendChild(t);
  while (caixa.children.length > 3) caixa.firstChild.remove();
  setTimeout(() => t.remove(), tipo === 'erro' && lista ? 9000 : 4500);
}

/**
 * Erro devolvido pela API, com o código HTTP e os detalhes (campos inválidos ou motivos).
 */
class ErroApi extends Error { constructor(m, status, detalhes) { super(m); this.status = status; this.detalhes = detalhes; } }

/**
 * Faz todas as chamadas ao servidor.
 * - Envia e recebe JSON; o cookie de sessão vai junto automaticamente.
 * - O cabeçalho X-Requested-With é conferido no servidor (proteção contra CSRF).
 * - Se o servidor responder 401 (não logado), volta para a tela de login.
 * - Se der erro, lança ErroApi para a tela tratar.
 */
async function api(metodo, url, corpo) {
  const r = await fetch(url, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
    credentials: 'same-origin',
  });
  const dados = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text();
  if (r.status === 401 && url !== '/api/login') { estado.usuario = null; location.hash = '#/login'; }
  if (!r.ok) throw new ErroApi(dados.erro || 'Falha na requisição.', r.status, dados.detalhes);
  return dados;
}

/**
 * Mostra os erros da API para o usuário:
 * - erros de campo (ex.: "Título obrigatório") aparecem embaixo do próprio campo,
 *   que fica destacado em vermelho e recebe o foco (CA-06);
 * - os demais (ex.: conflitos de horário) aparecem em lista numa mensagem flutuante.
 */
function mostrarErro(e, form) {
  if (form) limparErros(form);
  const campos = (e.detalhes || []).filter(d => d && d.campo);
  let primeiro = null;
  if (form) {
    for (const d of campos) {
      const el = form.querySelector(`[name="${d.campo}"]`) || form.querySelector(`[data-campo="${d.campo}"]`);
      const box = el && el.closest('.campo, [data-campo]');
      if (!box) continue;
      box.classList.add('invalido');
      const id = `erro-${d.campo}`;
      box.insertAdjacentHTML('beforeend', `<span class="msg-erro" id="${id}">${esc(d.mensagem)}</span>`);
      if (el.matches('input, select, textarea')) { el.setAttribute('aria-invalid', 'true'); el.setAttribute('aria-describedby', id); }
      primeiro = primeiro || el;
    }
  }
  if (primeiro && primeiro.focus) primeiro.focus();
  const outros = (e.detalhes || []).filter(d => typeof d === 'string' || (d && d.campo && !(form && form.querySelector(`[name="${d.campo}"], [data-campo="${d.campo}"]`))));
  toast(e.message, 'erro', outros);
}
/**
 * Remove os destaques de erro do formulário antes de validar de novo.
 */
function limparErros(form) {
  $$('.invalido', form).forEach(el => el.classList.remove('invalido'));
  $$('.msg-erro', form).forEach(el => el.remove());
  $$('[aria-invalid]', form).forEach(el => { el.removeAttribute('aria-invalid'); el.removeAttribute('aria-describedby'); });
}

/**
 * Pega todos os campos de um formulário e devolve como objeto { nome: valor }.
 */
const dadosForm = (form) => Object.fromEntries(new FormData(form).entries());

/**
 * Busca uma lista no servidor só na primeira vez e guarda no cache.
 */
async function carregar(chave, url) {
  if (!estado.cache[chave]) estado.cache[chave] = await api('GET', url);
  return estado.cache[chave];
}
/**
 * Apaga itens do cache (ex.: depois de cadastrar um equipamento novo).
 */
const invalidar = (...chaves) => chaves.forEach(c => delete estado.cache[c]);

/**
 * Janela modal reutilizável (usa o <dialog> do HTML), usada para aprovar, rejeitar,
 * cancelar, registrar entrega etc. "aoEnviar" é a função chamada ao confirmar;
 * se ela der erro, a janela continua aberta mostrando o erro no campo.
 */
function dialogo({ titulo, corpo, confirmar = 'Confirmar', classe = '', aoEnviar }) {
  const dlg = $('#dialogo');
  dlg.innerHTML = `<form method="dialog" novalidate>
      <h2 id="dlg-titulo">${esc(titulo)}</h2>${corpo}
      <div class="rodape"><button type="button" class="btn secundario" data-fechar>Voltar</button>
      <button type="submit" class="btn ${classe}">${esc(confirmar)}</button></div></form>`;
  dlg.setAttribute('aria-labelledby', 'dlg-titulo');
  const form = $('form', dlg);
  $('[data-fechar]', dlg).onclick = () => dlg.close();
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = $('button[type="submit"]', form);
    btn.disabled = true;
    try {
      await aoEnviar(dadosForm(form), form);
      dlg.close();
    } catch (e) { if (e instanceof ErroApi) mostrarErro(e, form); else throw e; } finally { btn.disabled = false; }
  };
  dlg.showModal();
  const foco = $('input, select, textarea', form);
  if (foco) foco.focus();
}

// ------------------------------------------------------------ layout, menu e notificações
/**
 * Monta o menu lateral conforme o perfil: cada item tem a permissão necessária.
 * Ex.: "Fila de aprovação" só aparece para quem aprova espaços ou equipamentos.
 */
function montarMenu(rotaAtual) {
  const u = estado.usuario;
  const itens = [
    ['Principal'],
    ['#/painel', '🏠', 'Painel'],
    ['#/agenda', '📅', 'Calendário'],
    ['#/nova', '➕', 'Nova solicitação', 'solicitar'],
    ['#/minhas', '📄', 'Minhas solicitações', 'solicitar'],
    ['Gestão', 'ver_tudo'],
    ['#/fila', '✅', 'Fila de aprovação', 'aprovar'],
    ['#/equipamentos', '🎛️', 'Equipamentos'],
    ['#/espacos', '🏛️', 'Espaços'],
    ['#/bloqueios', '⛔', 'Bloqueios', 'bloquear'],
    ['#/relatorios', '📊', 'Relatórios', 'relatorios'],
    ['#/admin', '⚙️', 'Administração', 'admin'],
  ];
  const ok = (p) => !p || (p === 'aprovar' ? pode('aprovar_espaco') || pode('aprovar_equipamento') : pode(p));
  $('#menu').innerHTML = itens.filter(i => (i.length <= 2 ? ok(i[1]) : ok(i[3]))).map(i => i.length <= 2
    ? `<div class="grupo">${esc(i[0])}</div>`
    : `<a href="${i[0]}" ${rotaAtual === i[0] ? 'aria-current="page"' : ''}><span aria-hidden="true">${i[1]}</span>${esc(i[2])}${i[0] === '#/fila' ? '<span class="badge st-PENDENTE" id="menu-fila" hidden></span>' : ''}</a>`).join('');
  $('#usuario-nome').textContent = `${u.nome} · ${PERFIS[u.perfil_id]}`;
}

/**
 * Atualiza o sino de notificações (RF-10). Roda ao trocar de tela e a cada 30 segundos.
 */
async function atualizarNotificacoes() {
  if (!estado.usuario) return;
  try {
    const lista = await api('GET', '/api/notificacoes');
    const naoLidas = lista.filter(n => !n.lida).length;
    const cont = $('#notif-cont');
    cont.hidden = naoLidas === 0;
    cont.textContent = naoLidas;
    $('#btn-notif').setAttribute('aria-label', `Notificações (${naoLidas} não lidas)`);
    $('#painel-notif').innerHTML = lista.length ? lista.map(n => `
      <a href="${n.solicitacao_id ? `#/solicitacao/${n.solicitacao_id}` : '#/painel'}" class="${n.lida ? '' : 'nao-lida'}">
        ${esc(n.mensagem)}<small>${fmtDataHora(n.criada_em)}</small></a>`).join('') : '<p class="vazio">Nenhuma notificação.</p>';
  } catch { /* silencioso */ }
}

$('#btn-notif').onclick = async () => {
  const painel = $('#painel-notif');
  painel.hidden = !painel.hidden;
  $('#btn-notif').setAttribute('aria-expanded', String(!painel.hidden));
  if (!painel.hidden) { await api('POST', '/api/notificacoes/lidas', {}); setTimeout(atualizarNotificacoes, 1500); }
};
document.addEventListener('click', (e) => {
  if (!e.target.closest('.notif')) { $('#painel-notif').hidden = true; $('#btn-notif').setAttribute('aria-expanded', 'false'); }
  if (e.target.closest('#menu a')) fecharMenu();
});
$('#btn-menu').onclick = () => {
  const aberto = $('#menu').classList.toggle('aberto');
  $('#btn-menu').setAttribute('aria-expanded', String(aberto));
};
/**
 * Fecha o menu lateral (no celular ele abre por cima da tela).
 */
function fecharMenu() { $('#menu').classList.remove('aberto'); $('#btn-menu').setAttribute('aria-expanded', 'false'); }
$('#btn-sair').onclick = async () => { await api('POST', '/api/logout', {}); estado.usuario = null; estado.cache = {}; $('#toasts').innerHTML = ''; location.hash = '#/login'; };
setInterval(atualizarNotificacoes, 30000);

// ------------------------------------------------------------ roteamento
/**
 * Tabela de rotas da interface. O endereço depois do # define a tela
 * (ex.: #/solicitacao/5 abre o detalhe do pedido 5). O terceiro valor "true" marca
 * as telas que não exigem login.
 */
const ROTAS = [
  [/^#\/login$/, telaLogin, true],
  [/^#\/publica$/, telaPublica, true],
  [/^#\/painel$/, telaPainel],
  [/^#\/agenda$/, telaAgenda],
  [/^#\/nova$/, () => telaFormulario()],
  [/^#\/editar\/(\d+)$/, (id) => telaFormulario(id)],
  [/^#\/minhas$/, telaMinhas],
  [/^#\/solicitacao\/(\d+)$/, telaDetalhe],
  [/^#\/fila$/, telaFila],
  [/^#\/equipamentos$/, telaEquipamentos],
  [/^#\/espacos$/, telaEspacos],
  [/^#\/bloqueios$/, telaBloqueios],
  [/^#\/relatorios$/, telaRelatorios],
  [/^#\/admin$/, telaAdmin],
];

/**
 * Chamada sempre que o # da URL muda: confere o login, monta o menu
 * e desenha a tela correspondente. Erros da API viram uma mensagem na própria tela.
 */
async function navegar() {
  const hash = location.hash || '#/painel';
  const rota = ROTAS.find(([re]) => re.test(hash));
  if (!rota) { location.hash = '#/painel'; return; }
  const [re, fn, publica] = rota;
  if (!publica && !estado.usuario) {
    try { estado.usuario = await api('GET', '/api/me'); } catch { location.hash = '#/login'; return; }
  }
  const logado = !!estado.usuario && !publica;
  $('#topo').hidden = !logado;
  $('#menu').hidden = !logado;
  if (logado) { montarMenu(hash.replace(/\/\d+$/, '')); atualizarNotificacoes(); }
  conteudo.innerHTML = '<p class="vazio">Carregando…</p>';
  try {
    await fn(...(hash.match(re).slice(1)));
  } catch (e) {
    if (e instanceof ErroApi) conteudo.innerHTML = `<div class="aviso erro"><strong>${esc(e.message)}</strong></div>`;
    else { console.error(e); conteudo.innerHTML = '<div class="aviso erro">Erro inesperado na interface.</div>'; }
  }
  conteudo.focus();
}
window.addEventListener('hashchange', navegar);

// ------------------------------------------------------------ login
/**
 * Tela de login. Os botões de "contas de demonstração" preenchem e-mail e senha.
 */
async function telaLogin() {
  conteudo.innerHTML = `
  <div class="tela-login"><div class="caixa-login">
    <div class="cartao">
      <div class="marca"><img src="img/icone.svg" alt="" width="34" height="34"> <span>Reservas <small>Fatec</small></span></div>
      <p class="subtitulo">Atividades extracurriculares, espaços e equipamentos</p>
      <form id="form-login" novalidate>
        <div class="campo"><label for="email">E-mail</label><input id="email" name="email" type="email" autocomplete="username" required></div>
        <div class="campo"><label for="senha">Senha</label><input id="senha" name="senha" type="password" autocomplete="current-password" required></div>
        <button class="btn" type="submit">Entrar</button>
      </form>
      <hr>
      <div class="contas-demo"><strong>Contas de demonstração</strong> (senha <code>senha123</code>):<br>
        ${[['ana@fatec.demo', 'Solicitante'], ['carla@fatec.demo', 'Gestora de espaços'], ['diego@fatec.demo', 'Equipamentos'], ['admin@fatec.demo', 'Administrador']]
          .map(([e, p]) => `<button type="button" data-email="${e}">${e}</button> — ${p}`).join('<br>')}
      </div>
      <p><a href="#/publica">Ver agenda pública de eventos</a></p>
    </div></div></div>`;
  const form = $('#form-login');
  $$('[data-email]').forEach(b => b.onclick = () => { form.email.value = b.dataset.email; form.senha.value = 'senha123'; form.senha.focus(); });
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      estado.usuario = await api('POST', '/api/login', dadosForm(form));
      estado.cache = {};
      location.hash = '#/painel';
    } catch (e) { mostrarErro(e, form); }
  };
  form.email.focus();
}

// ------------------------------------------------------------ agenda pública (RF-16)
/**
 * Agenda pública (RF-16): só eventos aprovados, sem nomes de pessoas. Não precisa de login.
 */
async function telaPublica() {
  const eventos = await api('GET', `/api/agenda-publica?inicio=${new Date().toISOString()}&fim=${new Date(Date.now() + 60 * 864e5).toISOString()}`);
  const porDia = {};
  for (const e of eventos) (porDia[new Date(e.inicio).toDateString()] ||= []).push(e);
  conteudo.innerHTML = `<div class="cartao">
    <div class="cabecalho"><h1>Agenda pública de eventos</h1><a class="btn secundario" href="#/login">Entrar no sistema</a></div>
    <p class="subtitulo">Somente eventos aprovados, sem dados pessoais. Próximos 60 dias.</p>
    ${Object.keys(porDia).length ? Object.entries(porDia).map(([, evs]) => `
      <h2>${esc(new Date(evs[0].inicio).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' }))}</h2>
      ${evs.map(e => `<div class="evento APROVADA"><strong>${esc(e.titulo)}</strong>${fmtHora(e.inicio)}–${fmtHora(e.fim)} · ${esc(e.recurso)}${e.atividade_tipo ? ` · ${esc(e.atividade_tipo)}` : ''}</div>`).join('')}`).join('')
      : '<p class="vazio">Nenhum evento publicado.</p>'}</div>`;
}

// ------------------------------------------------------------ painel
/**
 * Painel inicial: indicadores conforme o perfil, minhas solicitações recentes
 * e próximos eventos aprovados.
 */
async function telaPainel() {
  const p = await api('GET', '/api/painel');
  const aprovador = pode('aprovar_espaco') || pode('aprovar_equipamento');
  const kpis = [];
  if (aprovador) kpis.push(['#/fila', p.fila, 'aguardando sua análise']);
  if (pode('movimentar')) { kpis.push(['#/equipamentos', p.aRetirar, 'equipamentos a retirar']); kpis.push(['#/equipamentos', p.atrasados, 'devoluções em atraso']); }
  kpis.push(['#/minhas', p.minhas.filter(s => ['PENDENTE', 'EM_AJUSTES'].includes(s.status)).length, 'minhas solicitações em andamento']);
  conteudo.innerHTML = `
    <div class="cabecalho"><h1>Olá, ${esc(estado.usuario.nome.split(' ')[0])}</h1>
      <a class="btn" href="#/nova">➕ Nova solicitação</a></div>
    <div class="grade c4">${kpis.map(([h, v, r]) => `<a class="cartao kpi" href="${h}"><div class="valor">${v}</div><div class="rotulo">${esc(r)}</div></a>`).join('')}</div>
    ${p.minhas.some(s => s.status === 'EM_AJUSTES') ? '<div class="aviso alerta"><strong>Atenção:</strong> você tem solicitação devolvida para ajustes.</div>' : ''}
    <div class="grade c2">
      <section class="cartao"><h2>Minhas solicitações recentes</h2>${tabelaSolicitacoes(p.minhas, false)}</section>
      <section class="cartao"><h2>Próximos eventos aprovados (7 dias)</h2>
        ${p.proximos.length ? agruparEventos(p.proximos).map(e => `<div class="evento ${e.status}"><strong>${esc(e.titulo)}</strong>${fmtData(e.inicio)} · ${fmtHora(e.inicio)}–${fmtHora(e.fim)} · ${esc(e.recurso)}</div>`).join('') : '<p class="vazio">Nada agendado.</p>'}
        <a href="#/agenda">Abrir calendário →</a></section>
    </div>`;
  const fila = $('#menu-fila');
  if (fila && p.fila) { fila.hidden = false; fila.textContent = p.fila; }
}

/**
 * Junta numa linha só os recursos de um mesmo pedido com o mesmo horário e status
 * (ex.: "Auditório, Projetor, Microfone"), para o calendário não repetir o evento.
 */
function agruparEventos(eventos) {
  const m = new Map();
  for (const e of eventos) {
    const k = e.solicitacao_id ? `${e.solicitacao_id}|${e.inicio}|${e.fim}|${e.status}` : Math.random();
    if (m.has(k)) m.get(k).recurso += ', ' + e.recurso; else m.set(k, { ...e });
  }
  return [...m.values()];
}

/**
 * Tabela de solicitações usada em várias telas. A linha inteira é clicável
 * e também abre com Enter pelo teclado (RNF-01).
 */
function tabelaSolicitacoes(lista, comSolicitante = true) {
  if (!lista.length) return '<p class="vazio">Nenhuma solicitação encontrada.</p>';
  return `<div class="tabela-wrap"><table><thead><tr><th>#</th><th>Atividade / recursos</th>${comSolicitante ? '<th>Solicitante</th>' : ''}<th>Período</th><th>Status</th></tr></thead><tbody>
    ${lista.map(s => `<tr class="clicavel" data-ir="#/solicitacao/${s.id}" tabindex="0">
      <td>${s.id}</td>
      <td><a href="#/solicitacao/${s.id}">${esc(s.titulo || 'Reserva sem atividade vinculada')}</a>
        <span class="mini">${esc([s.espacos, s.equipamentos].filter(Boolean).join(' · ') || '—')}</span></td>
      ${comSolicitante ? `<td>${esc(s.solicitante_nome)}</td>` : ''}
      <td>${fmtPeriodo(s.inicio, s.fim)}</td>
      <td>${badge(s.status)}${s.excepcional ? ' <span class="badge st-EM_AJUSTES" title="Fora da política">Excepcional</span>' : ''}</td></tr>`).join('')}
    </tbody></table></div>`;
}
document.addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-ir]');
  if (tr && !e.target.closest('a, button')) location.hash = tr.dataset.ir;
});
document.addEventListener('keydown', (e) => {
  const tr = e.target.closest && e.target.closest('tr[data-ir]');
  if (tr && e.key === 'Enter') location.hash = tr.dataset.ir;
});

// ------------------------------------------------------------ calendário (RF-04)
/**
 * Filtros atuais do calendário (ficam guardados ao trocar de tela).
 */
const agendaEstado = { modo: 'semana', ref: new Date(), espaco_id: '', equipamento_id: '', status: '' };

/**
 * Tela do calendário (RF-04): filtros por dia/semana, espaço, equipamento e situação.
 */
async function telaAgenda() {
  const [espacos, equipamentos] = await Promise.all([carregar('espacos', '/api/espacos'), carregar('equipamentos', '/api/equipamentos')]);
  conteudo.innerHTML = `
    <div class="cabecalho"><h1>Calendário</h1><a class="btn" href="#/nova">➕ Nova solicitação</a></div>
    <form class="cartao filtros" id="form-agenda">
      <div class="campo"><label for="ag-modo">Visualizar</label><select id="ag-modo" name="modo"><option value="semana">Semana</option><option value="dia">Dia</option></select></div>
      <div class="campo"><label for="ag-data">Data</label>${campoData('ag-data', 'data')}</div>
      <div class="campo"><label for="ag-esp">Espaço</label><select id="ag-esp" name="espaco_id"><option value="">Todos</option>${espacos.map(e => `<option value="${e.id}">${esc(e.nome)}</option>`).join('')}</select></div>
      <div class="campo"><label for="ag-eq">Equipamento</label><select id="ag-eq" name="equipamento_id"><option value="">Todos</option>${equipamentos.map(e => `<option value="${e.id}">${esc(e.nome)}</option>`).join('')}</select></div>
      <div class="campo"><label for="ag-st">Situação</label><select id="ag-st" name="status"><option value="">Aprovadas e pendentes</option><option value="APROVADA">Somente aprovadas</option><option value="PENDENTE">Somente pendentes</option></select></div>
      <div class="acoes"><button type="button" class="btn secundario" data-nav="-1" aria-label="Período anterior">◀</button>
        <button type="button" class="btn secundario" data-nav="0">Hoje</button>
        <button type="button" class="btn secundario" data-nav="1" aria-label="Próximo período">▶</button></div>
    </form>
    <div class="legenda"><span class="l-livre">Livre</span><span class="l-ok">Ocupado (aprovado)</span><span class="l-pend">Pendente de análise</span><span class="l-bloq">Bloqueado</span></div>
    <div id="agenda-grade" aria-live="polite"></div>`;
  const form = $('#form-agenda');
  form.modo.value = agendaEstado.modo; form.espaco_id.value = agendaEstado.espaco_id;
  form.equipamento_id.value = agendaEstado.equipamento_id; form.status.value = agendaEstado.status;
  form.data.value = dataBR(agendaEstado.ref);
  form.onchange = () => {
    Object.assign(agendaEstado, { modo: form.modo.value, espaco_id: form.espaco_id.value, equipamento_id: form.equipamento_id.value, status: form.status.value });
    const escolhida = lerDataBR(form.data.value, '12:00'); // só muda quando a data estiver completa e válida
    if (escolhida) agendaEstado.ref = escolhida;
    desenharAgenda();
  };
  $$('[data-nav]', form).forEach(b => b.onclick = () => {
    const n = Number(b.dataset.nav);
    const d = new Date(agendaEstado.ref);
    if (n === 0) agendaEstado.ref = new Date(); else { d.setDate(d.getDate() + n * (agendaEstado.modo === 'semana' ? 7 : 1)); agendaEstado.ref = d; }
    form.data.value = dataBR(agendaEstado.ref);
    desenharAgenda();
  });
  desenharAgenda();
}

/**
 * Busca os eventos do período e desenha uma coluna por dia.
 * Cores: verde = ocupado (aprovado), amarelo = pendente, vermelho listrado = bloqueado;
 * dia sem nada mostra "Livre".
 */
async function desenharAgenda() {
  const ref = new Date(agendaEstado.ref); ref.setHours(0, 0, 0, 0);
  const inicio = new Date(ref);
  if (agendaEstado.modo === 'semana') inicio.setDate(ref.getDate() - ((ref.getDay() + 6) % 7)); // segunda-feira
  const dias = agendaEstado.modo === 'semana' ? 7 : 1;
  const fim = new Date(inicio); fim.setDate(inicio.getDate() + dias);
  const q = new URLSearchParams({ inicio: inicio.toISOString(), fim: fim.toISOString() });
  for (const k of ['espaco_id', 'equipamento_id', 'status']) if (agendaEstado[k]) q.set(k, agendaEstado[k]);
  const eventos = await api('GET', '/api/agenda?' + q);
  const hoje = new Date().toDateString();
  let html = '';
  for (let i = 0; i < dias; i++) {
    const d = new Date(inicio); d.setDate(inicio.getDate() + i);
    const dIni = d.getTime(), dFim = dIni + 864e5;
    const doDia = eventos.filter(e => new Date(e.inicio).getTime() < dFim && new Date(e.fim).getTime() > dIni);
    html += `<section class="dia-col ${d.toDateString() === hoje ? 'hoje' : ''}" aria-label="${esc(d.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }))}">
      <h3>${esc(d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' }))}</h3>
      ${doDia.length ? agruparEventos(doDia).map(e => {
        const tag = e.solicitacao_id && pode('ver_tudo') ? 'button' : 'div';
        const rot = e.status === 'BLOQUEADO' ? 'Bloqueado' : e.status === 'PENDENTE' ? 'Pendente' : 'Ocupado';
        return `<${tag} class="evento ${e.status}" ${tag === 'button' ? `type="button" data-ir="#/solicitacao/${e.solicitacao_id}"` : ''}>
          <strong>${fmtHora(e.inicio)}–${fmtHora(e.fim)} · ${esc(e.recurso)}</strong>${esc(e.titulo)} <em>(${rot})</em></${tag}>`;
      }).join('') : '<span class="livre">Livre</span>'}</section>`;
  }
  $('#agenda-grade').innerHTML = `<div class="agenda ${agendaEstado.modo === 'dia' ? 'dia' : ''}">${html}</div>`;
  $$('#agenda-grade button[data-ir]').forEach(b => b.onclick = () => { location.hash = b.dataset.ir; });
}

// ------------------------------------------------------------ nova / editar solicitação (RF-05, RF-06, RF-07)
/**
 * Tela "Nova solicitação" e também "Editar" (quando recebe o id).
 * Partes: atividade (opcional), data e horário, espaço e equipamentos, observações.
 * O botão "Verificar disponibilidade" consulta o servidor antes de enviar.
 * Ao editar um pedido já aprovado, avisa que ele volta para análise (RN-09).
 */
async function telaFormulario(id) {
  const [espacos, equipamentos] = await Promise.all([carregar('espacos', '/api/espacos'), carregar('equipamentos', '/api/equipamentos')]);
  let s = null;
  if (id) {
    s = await api('GET', `/api/solicitacoes/${id}`);
    if (!s.acoes.editar) throw new ErroApi('Esta solicitação não pode ser editada no status atual.', 409);
  }
  const amanha = new Date(Date.now() + 2 * 864e5);
  const a = s?.atividade;
  const eqSel = new Map((s?.equipamentos || []).map(e => [e.equipamento_id, e.quantidade]));
  const espSel = s?.espacos[0]?.espaco_id;
  conteudo.innerHTML = `
    <div class="cabecalho"><h1>${id ? `Editar solicitação #${id}` : 'Nova solicitação'}</h1></div>
    ${s?.status === 'APROVADA' ? '<div class="aviso alerta">Esta solicitação já está <strong>aprovada</strong>. Ao alterar data, horário ou recursos, ela será revalidada e voltará para análise (RN-09).</div>' : ''}
    ${s?.status === 'EM_AJUSTES' ? `<div class="aviso alerta"><strong>Ajustes solicitados:</strong> ${esc(s.historico.filter(h => h.acao.startsWith('DEVOLVEU')).pop()?.justificativa || '')}</div>` : ''}
    <form id="form-sol" novalidate>
      <section class="cartao">
        <label class="check"><input type="checkbox" id="tem-atividade" ${!s || a ? 'checked' : ''}> Vincular a uma atividade extracurricular (palestra, oficina, evento…)</label>
        <div id="bloco-atividade">
          <div class="linha">
            <div class="campo"><label for="f-titulo">Título *</label><input id="f-titulo" name="titulo" maxlength="200" value="${esc(a?.titulo)}"></div>
            <div class="campo"><label for="f-tipo">Tipo *</label><select id="f-tipo" name="tipo"><option value="">Selecione…</option>${TIPOS_ATIVIDADE.map(t => `<option ${a?.tipo === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
          </div>
          <div class="campo"><label for="f-desc">Descrição *</label><textarea id="f-desc" name="descricao" maxlength="4000">${esc(a?.descricao)}</textarea></div>
          <div class="linha">
            <div class="campo"><label for="f-pub">Público-alvo *</label><input id="f-pub" name="publico_alvo" placeholder="Ex.: alunos de ADS" value="${esc(a?.publico_alvo)}"></div>
            <div class="campo"><label for="f-qtd">Participantes estimados *</label><input id="f-qtd" name="publico_estimado" type="number" min="1" value="${esc(a?.publico_estimado || '')}"></div>
            <div class="campo"><span class="rotulo-grupo">Responsável</span><span>${esc(estado.usuario.nome)}</span></div>
          </div>
        </div>
      </section>
      <section class="cartao">
        <h2>Data e horário</h2>
        <div class="linha">
          <div class="campo"><label for="f-data">Data *</label>${campoData('f-data', 'data', s ? new Date(s.inicio) : amanha)}</div>
          <div class="campo" data-campo="inicio"><label for="f-ini">Início *</label>${campoHora('f-ini', 'hora_inicio', s ? hm(new Date(s.inicio)) : '14:00')}</div>
          <div class="campo" data-campo="fim"><label for="f-fim">Término *</label>${campoHora('f-fim', 'hora_fim', s ? hm(new Date(s.fim)) : '16:00')}</div>
        </div>
      </section>
      <section class="cartao" data-campo="recursos">
        <h2>Recursos</h2>
        <div class="campo"><label for="f-esp">Espaço</label>
          <select id="f-esp" name="espaco_id"><option value="">— Nenhum espaço —</option>
          ${espacos.filter(e => e.ativo || e.id === espSel).map(e => `<option value="${e.id}" ${e.id === espSel ? 'selected' : ''}>${esc(e.nome)} (capacidade ${e.capacidade})</option>`).join('')}</select></div>
        <span class="rotulo-grupo">Equipamentos</span>
        <div class="lista-eq">${equipamentos.map(e => {
          const indisp = e.situacao !== 'DISPONIVEL';
          const marcado = eqSel.has(e.id);
          return `<div class="item-eq ${indisp ? 'desabilitado' : ''}">
            <input type="checkbox" id="eq-${e.id}" data-eq="${e.id}" ${marcado ? 'checked' : ''} ${indisp && !marcado ? 'disabled' : ''}>
            <label for="eq-${e.id}">${esc(e.nome)} <span class="mini">${esc(e.codigo_patrimonio)} · ${indisp ? badge(e.situacao) : esc(e.categoria)}</span></label>
            ${e.controle === 'QUANTIDADE' ? `<input type="number" min="1" max="${e.quantidade_total}" value="${eqSel.get(e.id) || 1}" data-qtd="${e.id}" aria-label="Quantidade de ${esc(e.nome)} (total ${e.quantidade_total})">` : ''}
          </div>`;
        }).join('')}</div>
        <div class="acoes"><button type="button" class="btn secundario" id="btn-verificar">🔎 Verificar disponibilidade</button></div>
        <div class="resultado-disp" id="resultado-disp" aria-live="polite"></div>
      </section>
      <section class="cartao">
        <div class="campo"><label for="f-mot">Observações / finalidade</label><textarea id="f-mot" name="motivo" maxlength="2000">${esc(s?.motivo)}</textarea></div>
        <div class="acoes">
          ${!s || ['RASCUNHO', 'EM_AJUSTES'].includes(s.status) ? `
            <button type="submit" class="btn" data-acao="enviar">Enviar para análise</button>
            <button type="submit" class="btn secundario" data-acao="rascunho">Salvar rascunho</button>`
          : '<button type="submit" class="btn" data-acao="salvar">Salvar alterações e reenviar</button>'}
          <a class="btn secundario" href="${id ? `#/solicitacao/${id}` : '#/minhas'}">Cancelar</a>
        </div>
      </section>
    </form>`;

  const form = $('#form-sol');
  const chk = $('#tem-atividade');
  const alternar = () => { $('#bloco-atividade').hidden = !chk.checked; };
  chk.onchange = alternar; alternar();

  function montar() {
    const f = dadosForm(form);
    const dIni = lerDataBR(f.data, f.hora_inicio);
    const dFim = lerDataBR(f.data, f.hora_fim);
    const ini = dIni ? dIni.toISOString() : null;
    const fim = dFim ? dFim.toISOString() : null;
    return {
      inicio: ini, fim, motivo: f.motivo, espaco_id: f.espaco_id || null,
      equipamentos: $$('[data-eq]:checked', form).map(c => ({ equipamento_id: Number(c.dataset.eq), quantidade: Number($(`[data-qtd="${c.dataset.eq}"]`, form)?.value || 1) })),
      atividade: chk.checked ? { titulo: f.titulo, tipo: f.tipo, descricao: f.descricao, publico_alvo: f.publico_alvo, publico_estimado: f.publico_estimado } : null,
    };
  }

  // Validação no navegador (ajuda o usuário; o servidor valida de novo)
  function validarLocal(d, completo) {
    const erros = [];
    const f = dadosForm(form);
    if (!lerDataBR(f.data)) erros.push({ campo: 'data', mensagem: 'Data inválida. Use o formato dd/mm/aaaa.' });
    else {
      if (!d.inicio) erros.push({ campo: 'inicio', mensagem: 'Horário de início inválido. Use hh:mm (24 h).' });
      if (!d.fim) erros.push({ campo: 'fim', mensagem: 'Horário de término inválido. Use hh:mm (24 h).' });
    }
    if (d.inicio && d.fim && d.fim <= d.inicio) erros.push({ campo: 'fim', mensagem: 'O término deve ser depois do início.' });
    if (completo) {
      if (d.atividade) {
        for (const [c, m] of [['titulo', 'Título obrigatório.'], ['tipo', 'Selecione o tipo.'], ['descricao', 'Descrição obrigatória.'], ['publico_alvo', 'Público-alvo obrigatório.']]) {
          if (!String(d.atividade[c] || '').trim()) erros.push({ campo: c, mensagem: m });
        }
        if (!(Number(d.atividade.publico_estimado) > 0)) erros.push({ campo: 'publico_estimado', mensagem: 'Informe o número de participantes.' });
      }
      if (!d.espaco_id && !d.equipamentos.length) erros.push({ campo: 'recursos', mensagem: 'Selecione ao menos um espaço ou equipamento.' });
    }
    if (erros.length) throw new ErroApi('Corrija os campos destacados.', 422, erros);
  }

  $('#btn-verificar').onclick = async () => {
    const d = montar();
    const box = $('#resultado-disp');
    try {
      validarLocal(d, false);
      const r = await api('POST', '/api/disponibilidade', { ...d, publico_estimado: d.atividade?.publico_estimado, ignorar: id });
      const linhas = [];
      if (r.espaco) linhas.push([espacos.find(e => e.id === r.espaco.espaco_id)?.nome, r.espaco]);
      for (const e of r.equipamentos) linhas.push([equipamentos.find(x => x.id === e.equipamento_id)?.nome, e]);
      if (!linhas.length) { box.innerHTML = '<div class="aviso info">Selecione um espaço ou equipamento para verificar.</div>'; return; }
      const todosOk = linhas.every(([, v]) => v.disponivel);
      box.innerHTML = `<div class="aviso ${todosOk ? 'ok' : 'erro'}"><strong>${todosOk ? 'Tudo disponível no período.' : 'Há recursos indisponíveis.'}</strong><ul>
        ${linhas.map(([n, v]) => `<li>${v.disponivel ? '✔' : '✖'} <strong>${esc(n)}</strong>${v.disponivel ? (v.saldo !== undefined && v.saldo > 1 ? ` — saldo ${v.saldo}` : ' — livre') : ': ' + v.motivos.map(esc).join(' ')}</li>`).join('')}
        </ul></div>${r.politica.length ? `<div class="aviso alerta"><strong>Exige aprovação excepcional:</strong><ul>${r.politica.map(p => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
        <p class="mini">A consulta é informativa: a disponibilidade é verificada de novo no momento da aprovação.</p>`;
    } catch (e) { mostrarErro(e, form); }
  };

  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const acao = ev.submitter?.dataset.acao || 'enviar';
    const d = montar();
    limparErros(form);
    try {
      validarLocal(d, acao !== 'rascunho');
      let r;
      if (!id) r = await api('POST', '/api/solicitacoes', { ...d, enviar: acao === 'enviar' });
      else {
        r = await api('PUT', `/api/solicitacoes/${id}`, d);
        if (acao === 'enviar') r = await api('PATCH', `/api/solicitacoes/${id}/enviar`, {}).then(() => ({ id }));
      }
      toast(acao === 'rascunho' ? 'Rascunho salvo.' : 'Solicitação enviada para análise.', 'ok');
      location.hash = `#/solicitacao/${r.id || id}`;
    } catch (e) {
      if (e.status === 409 && !id) toast('Nada foi enviado. Ajuste o período ou os recursos e tente novamente.');
      mostrarErro(e, form);
    }
  };
}

// ------------------------------------------------------------ minhas solicitações
/**
 * Lista das minhas solicitações, com filtro por status.
 */
async function telaMinhas() {
  conteudo.innerHTML = `<div class="cabecalho"><h1>Minhas solicitações</h1><a class="btn" href="#/nova">➕ Nova solicitação</a></div>
    <div class="cartao"><form class="filtros" id="f-minhas">
      <div class="campo"><label for="m-st">Status</label><select id="m-st" name="status"><option value="">Todos</option>
      ${['RASCUNHO', 'PENDENTE', 'EM_AJUSTES', 'APROVADA', 'REJEITADA', 'CANCELADA', 'CONCLUIDA'].map(s => `<option value="${s}">${ROTULO_STATUS[s]}</option>`).join('')}</select></div>
    </form><div id="lista"></div></div>`;
  const form = $('#f-minhas');
  const atualizar = async () => {
    const q = new URLSearchParams({ minhas: '1', ...(form.status.value ? { status: form.status.value } : {}) });
    $('#lista').innerHTML = tabelaSolicitacoes(await api('GET', '/api/solicitacoes?' + q), false);
  };
  form.onchange = atualizar;
  await atualizar();
}

// ------------------------------------------------------------ fila de aprovação (RF-09)
/**
 * Fila de aprovação (RF-09): pendentes da competência do gestor, ordenados pela data do evento.
 */
async function telaFila() {
  const espacos = await carregar('espacos', '/api/espacos');
  conteudo.innerHTML = `<div class="cabecalho"><h1>Fila de aprovação</h1></div>
    <p class="subtitulo">Solicitações pendentes com itens da sua competência${pode('aprovar_espaco') && pode('aprovar_equipamento') ? ' (espaços e equipamentos)' : pode('aprovar_espaco') ? ' (espaços)' : ' (equipamentos)'}.</p>
    <div class="cartao"><form class="filtros" id="f-fila">
      <div class="campo"><label for="fi-esp">Espaço</label><select id="fi-esp" name="espaco_id"><option value="">Todos</option>${espacos.map(e => `<option value="${e.id}">${esc(e.nome)}</option>`).join('')}</select></div>
      <div class="campo"><label for="fi-q">Buscar</label><input id="fi-q" name="q" type="search" placeholder="título ou solicitante"></div>
    </form><div id="lista"></div></div>`;
  const form = $('#f-fila');
  const atualizar = async () => {
    const q = new URLSearchParams({ fila: '1' });
    if (form.espaco_id.value) q.set('espaco_id', form.espaco_id.value);
    if (form.q.value) q.set('q', form.q.value);
    const lista = (await api('GET', '/api/solicitacoes?' + q)).sort((a, b) => a.inicio.localeCompare(b.inicio));
    $('#lista').innerHTML = tabelaSolicitacoes(lista);
  };
  form.onchange = atualizar;
  form.onsubmit = (e) => { e.preventDefault(); atualizar(); };
  await atualizar();
}

// ------------------------------------------------------------ detalhe da solicitação
/**
 * Detalhe da solicitação: dados, status de cada recurso (RN-18), histórico,
 * retiradas/devoluções e os botões de ação que o servidor liberou para este usuário.
 */
async function telaDetalhe(id) {
  const s = await api('GET', `/api/solicitacoes/${id}`);
  const a = s.atividade;
  const movimentar = pode('movimentar') && s.status === 'APROVADA';
  conteudo.innerHTML = `
    <div class="cabecalho"><div><h1>${esc(a?.titulo || 'Reserva sem atividade vinculada')} ${badge(s.status)}</h1>
      <span class="mini">Solicitação #${s.id} · criada em ${fmtDataHora(s.criada_em)}</span></div>
      <div class="acoes" id="acoes">
        ${s.acoes.decidir ? '<button class="btn ok" data-acao="aprovar">Aprovar</button><button class="btn perigo" data-acao="rejeitar">Rejeitar</button>' : ''}
        ${s.acoes.ajustes ? '<button class="btn secundario" data-acao="ajustes">Pedir ajustes</button>' : ''}
        ${s.acoes.enviar ? '<button class="btn" data-acao="enviar">Enviar para análise</button>' : ''}
        ${s.acoes.editar ? `<a class="btn secundario" href="#/editar/${s.id}">Editar</a>` : ''}
        ${s.acoes.concluir ? '<button class="btn secundario" data-acao="concluir">Marcar como concluída</button>' : ''}
        ${s.acoes.cancelar ? '<button class="btn perigo" data-acao="cancelar">Cancelar solicitação</button>' : ''}
      </div></div>
    ${s.excepcional ? '<div class="aviso alerta"><strong>Aprovação excepcional:</strong> esta solicitação está fora do horário de funcionamento ou da antecedência mínima. A aprovação exige justificativa.</div>' : ''}
    ${s.avisos.map(x => `<div class="aviso alerta">${esc(x)}</div>`).join('')}
    <div class="grade c2">
      <section class="cartao"><h2>Dados</h2><dl class="dados">
        <dt>Período</dt><dd>${fmtPeriodo(s.inicio, s.fim)}</dd>
        <dt>Solicitante</dt><dd>${esc(s.solicitante.nome)}</dd>
        ${a ? `<dt>Tipo</dt><dd>${esc(a.tipo)}</dd><dt>Público-alvo</dt><dd>${esc(a.publico_alvo)}</dd><dt>Participantes</dt><dd>${esc(a.publico_estimado)}</dd><dt>Descrição</dt><dd>${esc(a.descricao)}</dd>` : ''}
        <dt>Observações</dt><dd>${esc(s.motivo || '—')}</dd></dl></section>
      <section class="cartao"><h2>Recursos solicitados</h2>
        <p class="mini">Cada recurso tem sua própria situação: aprovar o evento não aprova automaticamente todos os itens (RN-18).</p>
        <div class="tabela-wrap"><table><thead><tr><th>Recurso</th><th>Aprovação</th><th>Retirada</th>${movimentar ? '<th></th>' : ''}</tr></thead><tbody>
        ${s.espacos.map(r => `<tr><td>🏛️ ${esc(r.espaco_nome)} <span class="mini">capacidade ${r.capacidade}</span></td><td>${badge(r.status)}</td><td>—</td>${movimentar ? '<td></td>' : ''}</tr>`).join('')}
        ${s.equipamentos.map(r => {
          const atrasado = r.retirada === 'RETIRADO' && r.fim < new Date().toISOString();
          let botao = '';
          if (movimentar && r.status === 'APROVADA' && r.retirada === 'NAO_RETIRADO') botao = `<button class="btn pequeno" data-mov="ENTREGA" data-res="${r.id}" data-nome="${esc(r.equipamento_nome)}" data-qtd="${r.quantidade}">Registrar entrega</button>`;
          if (pode('movimentar') && r.retirada === 'RETIRADO') botao = `<button class="btn pequeno" data-mov="DEVOLUCAO" data-res="${r.id}" data-nome="${esc(r.equipamento_nome)}" data-qtd="${r.quantidade}" data-controle="${r.controle}">Registrar devolução</button>`;
          return `<tr><td>🎛️ ${esc(r.equipamento_nome)}${r.quantidade > 1 ? ` × ${r.quantidade}` : ''} <span class="mini">${esc(r.codigo_patrimonio)}</span></td>
            <td>${badge(r.status)}</td><td>${badge(r.retirada)}${atrasado ? ' ' + badge('ATRASADO') : ''}</td>${movimentar || botao ? `<td>${botao}</td>` : ''}</tr>`;
        }).join('')}
        </tbody></table></div></section>
    </div>
    <div class="grade c2">
      <section class="cartao"><h2>Histórico</h2>
        <ol class="linha-tempo">${s.historico.map(h => `<li><strong>${esc(h.acao)}</strong> — ${esc(h.ator_nome)}
          <div class="quando">${fmtDataHora(h.data_hora)}</div>${h.justificativa ? `<div class="just">${esc(h.justificativa)}</div>` : ''}</li>`).join('')}</ol></section>
      <section class="cartao"><h2>Retiradas e devoluções</h2>
        ${s.movimentacoes.length ? `<div class="tabela-wrap"><table><thead><tr><th>Tipo</th><th>Pessoa</th><th>Data/hora</th><th>Condição</th></tr></thead><tbody>
          ${s.movimentacoes.map(m => `<tr><td>${m.tipo === 'ENTREGA' ? 'Entrega' : 'Devolução'}</td><td>${esc(m.pessoa)}<span class="mini">registrado por ${esc(m.responsavel_nome)}</span></td>
          <td>${fmtDataHora(m.data_hora)}${m.atraso ? ' ' + badge('ATRASADO') : ''}</td><td>${badge(m.condicao === 'BOA' ? 'DISPONIVEL' : 'AVARIADO').replace('Disponível', 'Boa')}${m.observacao ? `<span class="mini">${esc(m.observacao)}</span>` : ''}</td></tr>`).join('')}
          </tbody></table></div>` : '<p class="vazio">Nenhuma movimentação registrada.</p>'}</section>
    </div>`;

  const recarregar = () => telaDetalhe(id).then(atualizarNotificacoes);
  const decisao = (acao, titulo, obrigatoria, classe) => dialogo({
    titulo, classe, confirmar: titulo,
    corpo: `<div class="campo"><label for="d-just">Justificativa ${obrigatoria ? '*' : '(opcional)'}</label>
      <textarea id="d-just" name="justificativa" ${obrigatoria ? 'required' : ''}></textarea>
      ${acao === 'aprovar' ? '<span class="dica">A disponibilidade será verificada novamente agora, antes de aprovar.</span>' : ''}</div>`,
    aoEnviar: async (f, form) => {
      if (obrigatoria && !f.justificativa.trim()) throw new ErroApi('Informe a justificativa.', 422, [{ campo: 'justificativa', mensagem: 'Justificativa obrigatória.' }]);
      const r = await api('PATCH', `/api/solicitacoes/${id}/${acao}`, { justificativa: f.justificativa });
      toast(`Feito. Situação atual: ${ROTULO_STATUS[r.status] || r.status}.`, 'ok');
      recarregar();
    },
  });
  const acoes = {
    aprovar: () => decisao('aprovar', 'Aprovar', !!s.excepcional, 'ok'),
    rejeitar: () => decisao('rejeitar', 'Rejeitar', true, 'perigo'),
    ajustes: () => decisao('ajustes', 'Pedir ajustes', true),
    enviar: async () => { try { await api('PATCH', `/api/solicitacoes/${id}/enviar`, {}); toast('Enviada para análise.', 'ok'); recarregar(); } catch (e) { mostrarErro(e); } },
    concluir: async () => { try { await api('PATCH', `/api/solicitacoes/${id}/concluir`, {}); toast('Atividade concluída.', 'ok'); recarregar(); } catch (e) { mostrarErro(e); } },
    cancelar: () => dialogo({
      titulo: 'Cancelar solicitação', confirmar: 'Cancelar solicitação', classe: 'perigo',
      corpo: `<p>Os recursos serão liberados na agenda. Esta ação não pode ser desfeita.</p>
        <div class="campo"><label for="d-mot">Motivo *</label><textarea id="d-mot" name="motivo" required></textarea></div>`,
      aoEnviar: async (f) => { await api('PATCH', `/api/solicitacoes/${id}/cancelar`, { motivo: f.motivo }); toast('Solicitação cancelada.', 'ok'); recarregar(); },
    }),
  };
  $$('#acoes [data-acao]').forEach(b => b.onclick = acoes[b.dataset.acao]);
  $$('[data-mov]').forEach(b => b.onclick = () => dialogoMovimentacao(b.dataset, recarregar, s.solicitante.nome));
}

/**
 * Janela para registrar entrega ou devolução de equipamento (RF-11).
 * A data/hora não é digitada: o servidor registra o horário oficial.
 */
function dialogoMovimentacao(d, depois, pessoaPadrao = '') {
  const entrega = d.mov === 'ENTREGA';
  dialogo({
    titulo: `${entrega ? 'Registrar entrega' : 'Registrar devolução'} — ${d.nome}`,
    confirmar: entrega ? 'Registrar entrega' : 'Registrar devolução',
    corpo: `<div class="campo"><label for="mv-p">${entrega ? 'Retirado por' : 'Devolvido por'} *</label><input id="mv-p" name="pessoa" value="${esc(pessoaPadrao)}" required></div>
      <div class="campo"><label for="mv-c">Condição do item</label><select id="mv-c" name="condicao"><option value="BOA">Boa</option><option value="AVARIADO">Avariado</option></select></div>
      ${!entrega && d.controle === 'QUANTIDADE' ? `<div class="campo"><label for="mv-q">Quantidade avariada (se houver)</label><input id="mv-q" name="quantidade_avariada" type="number" min="1" max="${d.qtd}" value="1"></div>` : ''}
      <div class="campo"><label for="mv-o">Observações ${entrega ? '' : '(obrigatório em caso de avaria)'}</label><textarea id="mv-o" name="observacao"></textarea></div>
      <p class="dica">Data e hora são registradas automaticamente pelo servidor.${!entrega ? ' Itens individuais devolvidos com avaria ficam indisponíveis para novas reservas.' : ''}</p>`,
    aoEnviar: async (f) => {
      const r = await api('POST', '/api/movimentacoes', { ...f, tipo: d.mov, reserva_equipamento_id: Number(d.res) });
      toast(`${entrega ? 'Entrega' : 'Devolução'} registrada às ${fmtHora(r.data_hora)}${r.atraso ? ' (com atraso)' : ''}.`, 'ok');
      invalidar('equipamentos');
      depois();
    },
  });
}

// ------------------------------------------------------------ equipamentos (RF-03, RF-11)
/**
 * Tela de equipamentos: o que retirar, o que está fora (com atraso destacado),
 * ocorrências e o inventário com cadastro/edição.
 */
async function telaEquipamentos() {
  const gerir = pode('gerir_equipamentos');
  const [equipamentos, categorias, painel] = await Promise.all([
    api('GET', '/api/equipamentos'), api('GET', '/api/categorias'), pode('movimentar') ? api('GET', '/api/equipamentos/painel') : null,
  ]);
  estado.cache.equipamentos = equipamentos;
  const linhaRes = (r, mov) => `<tr><td>${esc(r.nome)}${r.quantidade > 1 ? ` × ${r.quantidade}` : ''}<span class="mini">${esc(r.codigo_patrimonio)}</span></td>
    <td><a href="#/solicitacao/${r.solicitacao_id}">#${r.solicitacao_id}</a> ${esc(r.titulo || '')}<span class="mini">${esc(r.solicitante_nome)}</span></td>
    <td>${fmtPeriodo(r.inicio, r.fim)}${r.atrasado ? ' ' + badge('ATRASADO') : ''}</td>
    <td><button class="btn pequeno" data-mov="${mov}" data-res="${r.id}" data-nome="${esc(r.nome)}" data-qtd="${r.quantidade}" data-controle="${r.controle}" data-pessoa="${esc(r.solicitante_nome)}">${mov === 'ENTREGA' ? 'Entregar' : 'Receber devolução'}</button></td></tr>`;
  conteudo.innerHTML = `
    <div class="cabecalho"><h1>Equipamentos</h1>${gerir ? '<div class="acoes"><button class="btn" id="novo-eq">➕ Novo equipamento</button><button class="btn secundario" id="nova-cat">Nova categoria</button></div>' : ''}</div>
    ${painel ? `
    <div class="grade c2">
      <section class="cartao"><h2>A retirar (reservas aprovadas)</h2>
        ${painel.aRetirar.length ? `<div class="tabela-wrap"><table><thead><tr><th>Item</th><th>Solicitação</th><th>Período</th><th></th></tr></thead><tbody>${painel.aRetirar.map(r => linhaRes(r, 'ENTREGA')).join('')}</tbody></table></div>` : '<p class="vazio">Nenhuma retirada prevista.</p>'}</section>
      <section class="cartao"><h2>Retirados — aguardando devolução</h2>
        ${painel.retirados.length ? `<div class="tabela-wrap"><table><thead><tr><th>Item</th><th>Solicitação</th><th>Período</th><th></th></tr></thead><tbody>${painel.retirados.map(r => linhaRes(r, 'DEVOLUCAO')).join('')}</tbody></table></div>` : '<p class="vazio">Nenhum item fora.</p>'}</section>
    </div>
    <section class="cartao"><h2>Ocorrências (avarias e atrasos)</h2>
      ${painel.ocorrencias.length ? `<div class="tabela-wrap"><table><thead><tr><th>Item</th><th>Ocorrência</th><th>Data/hora</th><th>Registrado por</th></tr></thead><tbody>
        ${painel.ocorrencias.map(o => `<tr><td>${esc(o.nome)}</td><td>${o.condicao === 'AVARIADO' ? badge('AVARIADO') : ''} ${o.atraso ? badge('ATRASADO') : ''}<span class="mini">${esc(o.observacao || '')}</span></td><td>${fmtDataHora(o.data_hora)}</td><td>${esc(o.responsavel_nome)}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="vazio">Nenhuma ocorrência.</p>'}</section>` : ''}
    <section class="cartao"><h2>Inventário</h2>
      <div class="tabela-wrap"><table><thead><tr><th>Código</th><th>Nome</th><th>Categoria</th><th>Situação</th><th>Local</th><th>Qtd.</th>${gerir ? '<th></th>' : ''}</tr></thead><tbody>
      ${equipamentos.map(e => `<tr><td>${esc(e.codigo_patrimonio)}</td><td>${esc(e.nome)}</td><td>${esc(e.categoria)}<span class="mini">${e.controle === 'INDIVIDUAL' ? 'item individual' : 'por quantidade'}</span></td>
        <td>${badge(e.situacao)}</td><td>${esc(e.localizacao)}</td><td>${e.quantidade_total}</td>
        ${gerir ? `<td><button class="btn pequeno secundario" data-editar="${e.id}">Editar</button></td>` : ''}</tr>`).join('')}
      </tbody></table></div></section>`;

  $$('[data-mov]').forEach(b => b.onclick = () => dialogoMovimentacao(b.dataset, telaEquipamentos, b.dataset.pessoa));
  if (!gerir) return;
  const formEq = (e = {}) => dialogo({
    titulo: e.id ? `Editar ${e.nome}` : 'Novo equipamento', confirmar: 'Salvar',
    corpo: `<div class="linha"><div class="campo"><label for="e-cod">Código/patrimônio *</label><input id="e-cod" name="codigo_patrimonio" value="${esc(e.codigo_patrimonio)}"></div>
      <div class="campo"><label for="e-nome">Nome *</label><input id="e-nome" name="nome" value="${esc(e.nome)}"></div></div>
      <div class="linha"><div class="campo"><label for="e-cat">Categoria *</label><select id="e-cat" name="categoria_id">${categorias.map(c => `<option value="${c.id}" ${c.id === e.categoria_id ? 'selected' : ''}>${esc(c.nome)} (${c.controle === 'INDIVIDUAL' ? 'individual' : 'quantidade'})</option>`).join('')}</select></div>
      <div class="campo"><label for="e-sit">Situação</label><select id="e-sit" name="situacao">${['DISPONIVEL', 'MANUTENCAO', 'AVARIADO', 'INATIVO'].map(s => `<option value="${s}" ${s === (e.situacao || 'DISPONIVEL') ? 'selected' : ''}>${ROTULO_STATUS[s]}</option>`).join('')}</select></div></div>
      <div class="linha"><div class="campo"><label for="e-loc">Local de armazenamento</label><input id="e-loc" name="localizacao" value="${esc(e.localizacao)}"></div>
      <div class="campo"><label for="e-qtd">Quantidade total</label><input id="e-qtd" name="quantidade_total" type="number" min="0" value="${esc(e.quantidade_total ?? 1)}"><span class="dica">Ignorada para itens individuais.</span></div></div>`,
    aoEnviar: async (f) => {
      const r = await api(e.id ? 'PUT' : 'POST', e.id ? `/api/equipamentos/${e.id}` : '/api/equipamentos', f);
      toast('Equipamento salvo.', 'ok', r.afetadas?.length ? [`Atenção: ${r.afetadas.length} reserva(s) futura(s) usam este item; os solicitantes foram notificados.`] : undefined);
      invalidar('equipamentos'); telaEquipamentos();
    },
  });
  $('#novo-eq').onclick = () => formEq();
  $$('[data-editar]').forEach(b => b.onclick = () => formEq(equipamentos.find(e => e.id === Number(b.dataset.editar))));
  $('#nova-cat').onclick = () => dialogo({
    titulo: 'Nova categoria', confirmar: 'Salvar',
    corpo: `<div class="campo"><label for="c-nome">Nome *</label><input id="c-nome" name="nome"></div>
      <div class="campo"><label for="c-ctrl">Controle</label><select id="c-ctrl" name="controle"><option value="INDIVIDUAL">Item individual (patrimônio)</option><option value="QUANTIDADE">Por quantidade (estoque)</option></select></div>`,
    aoEnviar: async (f) => { await api('POST', '/api/categorias', f); toast('Categoria criada.', 'ok'); telaEquipamentos(); },
  });
}

// ------------------------------------------------------------ espaços (RF-02)
/**
 * Tela de espaços: cadastro e consulta de quais espaços estão livres num horário.
 */
async function telaEspacos() {
  const gerir = pode('gerir_espacos');
  conteudo.innerHTML = `<div class="cabecalho"><h1>Espaços</h1>${gerir ? '<button class="btn" id="novo-esp">➕ Novo espaço</button>' : ''}</div>
    <form class="cartao filtros" id="f-disp">
      <div class="campo"><label for="ds-data">Consultar disponibilidade em</label>${campoData('ds-data', 'data', new Date(Date.now() + 864e5))}</div>
      <div class="campo"><label for="ds-i">das</label>${campoHora('ds-i', 'ini', '14:00')}</div>
      <div class="campo"><label for="ds-f">até</label>${campoHora('ds-f', 'fim', '16:00')}</div>
    </form>
    <div class="cartao" id="lista"></div>`;
  const form = $('#f-disp');
  const atualizar = async () => {
    const f = dadosForm(form);
    const q = new URLSearchParams();
    const ini = lerDataBR(f.data, f.ini), fim = lerDataBR(f.data, f.fim);
    if (ini && fim) { q.set('inicio', ini.toISOString()); q.set('fim', fim.toISOString()); }
    const espacos = await api('GET', '/api/espacos?' + q);
    estado.cache.espacos = espacos.map(({ disponivel, motivos, ...e }) => e);
    $('#lista').innerHTML = `<div class="tabela-wrap"><table><thead><tr><th>Espaço</th><th>Localização</th><th>Capacidade</th><th>No período</th>${gerir ? '<th></th>' : ''}</tr></thead><tbody>
      ${espacos.map(e => `<tr><td>${esc(e.nome)} ${e.ativo ? '' : badge('INATIVO')}</td><td>${esc(e.localizacao)}</td><td>${e.capacidade}</td>
        <td>${e.disponivel === undefined ? '—' : e.disponivel ? '<span class="badge st-APROVADA">Livre</span>' : `<span class="badge st-REJEITADA">Indisponível</span><span class="mini">${e.motivos.map(esc).join(' ')}</span>`}</td>
        ${gerir ? `<td><button class="btn pequeno secundario" data-editar="${e.id}">Editar</button></td>` : ''}</tr>`).join('')}
      </tbody></table></div>`;
    $$('[data-editar]').forEach(b => b.onclick = () => formEsp(espacos.find(e => e.id === Number(b.dataset.editar))));
  };
  const formEsp = (e = {}) => dialogo({
    titulo: e.id ? `Editar ${e.nome}` : 'Novo espaço', confirmar: 'Salvar',
    corpo: `<div class="campo"><label for="s-nome">Nome *</label><input id="s-nome" name="nome" value="${esc(e.nome)}"></div>
      <div class="campo"><label for="s-loc">Localização</label><input id="s-loc" name="localizacao" value="${esc(e.localizacao)}"></div>
      <div class="campo"><label for="s-cap">Capacidade aprovada *</label><input id="s-cap" name="capacidade" type="number" min="1" value="${esc(e.capacidade || '')}"></div>
      <label class="check"><input type="checkbox" name="ativo" value="1" ${e.ativo === 0 ? '' : 'checked'}> Ativo para reservas</label>`,
    aoEnviar: async (f) => {
      await api(e.id ? 'PUT' : 'POST', e.id ? `/api/espacos/${e.id}` : '/api/espacos', { ...f, ativo: f.ativo === '1' });
      toast('Espaço salvo.', 'ok'); invalidar('espacos'); atualizar();
    },
  });
  form.onchange = atualizar;
  if (gerir) $('#novo-esp').onclick = () => formEsp();
  await atualizar();
}

// ------------------------------------------------------------ bloqueios (RN-05)
/**
 * Tela de bloqueios (RN-05): cria períodos de manutenção e mostra
 * as reservas afetadas, se houver.
 */
async function telaBloqueios() {
  const [espacos, equipamentos, bloqueios] = await Promise.all([carregar('espacos', '/api/espacos'), carregar('equipamentos', '/api/equipamentos'), api('GET', '/api/bloqueios')]);
  const tipos = [pode('gerir_espacos') && ['ESPACO', 'Espaço'], pode('gerir_equipamentos') && ['EQUIPAMENTO', 'Equipamento']].filter(Boolean);
  const amanha = new Date(Date.now() + 864e5); amanha.setHours(8, 0, 0, 0);
  const ate = new Date(amanha); ate.setHours(18);
  conteudo.innerHTML = `<div class="cabecalho"><h1>Bloqueios de recursos</h1></div>
    <p class="subtitulo">Períodos de manutenção ou indisponibilidade administrativa. Nenhuma nova solicitação pode ocupar um bloqueio.</p>
    <form class="cartao" id="f-bloq" novalidate><h2>Novo bloqueio</h2>
      <div class="linha">
        <div class="campo"><label for="b-tipo">Tipo</label><select id="b-tipo" name="tipo_recurso">${tipos.map(([v, r]) => `<option value="${v}">${r}</option>`).join('')}</select></div>
        <div class="campo"><label for="b-rec">Recurso</label><select id="b-rec" name="recurso_id"></select></div>
        <div class="campo" data-campo="inicio"><label for="b-di">Data de início</label>${campoData('b-di', 'data_inicio', amanha)}</div>
        <div class="campo"><label for="b-hi">Hora de início</label>${campoHora('b-hi', 'hora_inicio', hm(amanha))}</div>
        <div class="campo" data-campo="fim"><label for="b-df">Data de fim</label>${campoData('b-df', 'data_fim', ate)}</div>
        <div class="campo"><label for="b-hf">Hora de fim</label>${campoHora('b-hf', 'hora_fim', hm(ate))}</div>
      </div>
      <div class="campo"><label for="b-mot">Motivo *</label><input id="b-mot" name="motivo" placeholder="Ex.: manutenção do ar-condicionado"></div>
      <button class="btn" type="submit">Criar bloqueio</button>
      <div id="b-res" aria-live="polite"></div>
    </form>
    <section class="cartao"><h2>Bloqueios cadastrados</h2>
      ${bloqueios.length ? `<div class="tabela-wrap"><table><thead><tr><th>Recurso</th><th>Período</th><th>Motivo</th><th>Criado por</th><th></th></tr></thead><tbody>
        ${bloqueios.map(b => `<tr><td>${esc(b.recurso_nome)}<span class="mini">${b.tipo_recurso === 'ESPACO' ? 'espaço' : 'equipamento'}</span></td><td>${fmtPeriodo(b.inicio, b.fim)}</td><td>${esc(b.motivo)}</td><td>${esc(b.criado_por_nome)}</td>
        <td><button class="btn pequeno perigo" data-excluir="${b.id}">Remover</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="vazio">Nenhum bloqueio.</p>'}
    </section>`;
  const form = $('#f-bloq');
  const opcoes = () => {
    const lista = form.tipo_recurso.value === 'ESPACO' ? espacos : equipamentos;
    form.recurso_id.innerHTML = lista.map(r => `<option value="${r.id}">${esc(r.nome)}</option>`).join('');
  };
  form.tipo_recurso.onchange = opcoes; opcoes();
  form.onsubmit = async (ev) => {
    ev.preventDefault(); limparErros(form);
    const f = dadosForm(form);
    try {
      const ini = lerDataBR(f.data_inicio, f.hora_inicio), fim = lerDataBR(f.data_fim, f.hora_fim);
      const erros = [];
      if (!ini) erros.push({ campo: 'data_inicio', mensagem: 'Início inválido. Use dd/mm/aaaa e hh:mm.' });
      if (!fim) erros.push({ campo: 'data_fim', mensagem: 'Fim inválido. Use dd/mm/aaaa e hh:mm.' });
      if (erros.length) throw new ErroApi('Corrija os campos destacados.', 422, erros);
      const r = await api('POST', '/api/bloqueios', { tipo_recurso: f.tipo_recurso, recurso_id: f.recurso_id, motivo: f.motivo, inicio: ini.toISOString(), fim: fim.toISOString() });
      if (r.afetadas.length) {
        await telaBloqueios();
        $('#b-res').innerHTML = `<div class="aviso alerta"><strong>Bloqueio criado, mas há ${r.afetadas.length} reserva(s) no período.</strong> Os solicitantes foram notificados; avalie cancelar ou remanejar:
          <ul>${r.afetadas.map(a => `<li><a href="#/solicitacao/${a.solicitacao_id}">Solicitação #${a.solicitacao_id}</a> — ${fmtPeriodo(a.inicio, a.fim)} (${ROTULO_STATUS[a.status]})</li>`).join('')}</ul></div>`;
      } else { toast('Bloqueio criado.', 'ok'); telaBloqueios(); }
    } catch (e) { mostrarErro(e, form); }
  };
  $$('[data-excluir]').forEach(b => b.onclick = async () => {
    if (!confirm('Remover este bloqueio?')) return;
    await api('DELETE', `/api/bloqueios/${b.dataset.excluir}`); toast('Bloqueio removido.', 'ok'); telaBloqueios();
  });
}

// ------------------------------------------------------------ relatórios (RF-13, RF-14)
/**
 * Relatórios (RF-13/RF-14): utilização por recurso, totais por status,
 * listagem filtrável e exportação em CSV.
 */
async function telaRelatorios() {
  const espacos = await carregar('espacos', '/api/espacos');
  const de = new Date(); de.setDate(1);
  const ate = new Date(de.getFullYear(), de.getMonth() + 1, 0);
  conteudo.innerHTML = `<div class="cabecalho"><h1>Relatórios</h1></div>
    <form class="cartao filtros" id="f-rel">
      <div class="campo"><label for="r-de">De</label>${campoData('r-de', 'de', de)}</div>
      <div class="campo"><label for="r-ate">Até</label>${campoData('r-ate', 'ate', ate)}</div>
      <div class="campo"><label for="r-st">Status</label><select id="r-st" name="status"><option value="">Todos</option>${Object.keys(ROTULO_STATUS).slice(0, 7).map(s => `<option value="${s}">${ROTULO_STATUS[s]}</option>`).join('')}</select></div>
      <div class="campo"><label for="r-esp">Espaço</label><select id="r-esp" name="espaco_id"><option value="">Todos</option>${espacos.map(e => `<option value="${e.id}">${esc(e.nome)}</option>`).join('')}</select></div>
      <div class="campo"><label for="r-q">Buscar</label><input id="r-q" type="search" name="q"></div>
      <a class="btn secundario" id="btn-csv" href="#">⬇ Exportar CSV</a>
    </form>
    <div id="rel"></div>`;
  const form = $('#f-rel');
  const atualizar = async () => {
    const f = dadosForm(form);
    const q = new URLSearchParams();
    const de = lerDataBR(f.de, '00:00'), ate = lerDataBR(f.ate, '23:59');
    if (de) q.set('de', de.toISOString());
    if (ate) q.set('ate', new Date(ate.getTime() + 59999).toISOString()); // até 23:59:59 do dia
    const qLista = new URLSearchParams(q);
    for (const k of ['status', 'espaco_id', 'q']) if (f[k]) qLista.set(k, f[k]);
    $('#btn-csv').href = '/api/relatorios/solicitacoes.csv?' + qLista;
    const [u, lista] = await Promise.all([api('GET', '/api/relatorios/utilizacao?' + q), api('GET', '/api/solicitacoes?' + qLista)]);
    const tab = (linhas) => `<table><thead><tr><th>Recurso</th><th>Reservas aprovadas</th><th>Horas</th></tr></thead><tbody>${linhas.map(l => `<tr><td>${esc(l.nome)}</td><td>${l.reservas}</td><td>${l.horas}</td></tr>`).join('')}</tbody></table>`;
    $('#rel').innerHTML = `
      <div class="grade c4">${['PENDENTE', 'APROVADA', 'REJEITADA', 'CANCELADA'].map(st => `<div class="cartao kpi"><div class="valor">${u.porStatus.find(p => p.status === st)?.total || 0}</div><div class="rotulo">${ROTULO_STATUS[st]}</div></div>`).join('')}</div>
      <div class="grade c2"><section class="cartao"><h2>Utilização de espaços</h2><div class="tabela-wrap">${tab(u.espacos)}</div></section>
      <section class="cartao"><h2>Utilização de equipamentos</h2><div class="tabela-wrap">${tab(u.equipamentos)}</div></section></div>
      <section class="cartao"><h2>Solicitações no período (${lista.length})</h2>${tabelaSolicitacoes(lista)}</section>`;
  };
  form.onchange = atualizar;
  form.onsubmit = (e) => { e.preventDefault(); atualizar(); };
  await atualizar();
}

// ------------------------------------------------------------ administração
/**
 * Administração: usuários e perfis, parâmetros das regras e log de auditoria.
 */
async function telaAdmin() {
  const [usuarios, parametros, logs] = await Promise.all([api('GET', '/api/usuarios'), api('GET', '/api/parametros'), api('GET', '/api/logs')]);
  conteudo.innerHTML = `<div class="cabecalho"><h1>Administração</h1><button class="btn" id="novo-usr">➕ Novo usuário</button></div>
    <section class="cartao"><h2>Usuários</h2><div class="tabela-wrap"><table><thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Situação</th><th></th></tr></thead><tbody>
      ${usuarios.map(u => `<tr><td>${esc(u.nome)}</td><td>${esc(u.email)}</td><td>${esc(PERFIS[u.perfil_id])}</td><td>${u.ativo ? badge('DISPONIVEL').replace('Disponível', 'Ativo') : badge('INATIVO')}</td>
      <td><button class="btn pequeno secundario" data-usr="${u.id}">Editar</button></td></tr>`).join('')}</tbody></table></div></section>
    <form class="cartao" id="f-param"><h2>Parâmetros</h2>
      <p class="subtitulo">Valores de teste — devem ser definidos pela unidade antes de uso real.</p>
      <div class="grade c2">${parametros.map(p => `<div class="campo"><label for="p-${p.chave}">${esc(p.chave)}</label>
        ${p.chave === 'politica_fora_regra' ? `<select id="p-${p.chave}" name="${p.chave}"><option ${p.valor === 'EXCECAO' ? 'selected' : ''}>EXCECAO</option><option ${p.valor === 'BLOQUEAR' ? 'selected' : ''}>BLOQUEAR</option></select>`
        : `<input id="p-${p.chave}" name="${p.chave}" value="${esc(p.valor)}">`}<span class="dica">${esc(p.descricao)}</span></div>`).join('')}</div>
      <button class="btn" type="submit">Salvar parâmetros</button></form>
    <section class="cartao"><h2>Log de auditoria</h2><div class="tabela-wrap"><table><thead><tr><th>Data/hora</th><th>Usuário</th><th>Ação</th><th>Detalhe</th></tr></thead><tbody>
      ${logs.map(l => `<tr><td>${fmtDataHora(l.data_hora)}</td><td>${esc(l.usuario_nome || '—')}</td><td>${esc(l.acao)}</td><td>${esc(l.detalhe)}</td></tr>`).join('')}</tbody></table></div></section>`;

  const formUsr = (u = {}) => dialogo({
    titulo: u.id ? `Editar ${u.nome}` : 'Novo usuário', confirmar: 'Salvar',
    corpo: `<div class="campo"><label for="u-nome">Nome *</label><input id="u-nome" name="nome" value="${esc(u.nome)}"></div>
      <div class="campo"><label for="u-email">E-mail *</label><input id="u-email" name="email" type="email" value="${esc(u.email)}"></div>
      <div class="campo"><label for="u-perfil">Perfil *</label><select id="u-perfil" name="perfil_id">${Object.entries(PERFIS).map(([k, v]) => `<option value="${k}" ${k === u.perfil_id ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="campo"><label for="u-senha">${u.id ? 'Nova senha (deixe em branco para manter)' : 'Senha *'}</label><input id="u-senha" name="senha" type="password" autocomplete="new-password" minlength="8"></div>
      <label class="check"><input type="checkbox" name="ativo" value="1" ${u.ativo === 0 ? '' : 'checked'}> Usuário ativo</label>`,
    aoEnviar: async (f) => {
      await api(u.id ? 'PUT' : 'POST', u.id ? `/api/usuarios/${u.id}` : '/api/usuarios', { ...f, ativo: f.ativo === '1' });
      toast('Usuário salvo.', 'ok'); telaAdmin();
    },
  });
  $('#novo-usr').onclick = () => formUsr();
  $$('[data-usr]').forEach(b => b.onclick = () => formUsr(usuarios.find(u => u.id === Number(b.dataset.usr))));
  $('#f-param').onsubmit = async (ev) => {
    ev.preventDefault();
    try { await api('PUT', '/api/parametros', dadosForm(ev.target)); toast('Parâmetros salvos.', 'ok'); } catch (e) { mostrarErro(e, ev.target); }
  };
}

navegar();
