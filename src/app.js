// =============================================================================
// app.js — API REST e servidor de arquivos.
//
// Recebe as requisições HTTP da tela, identifica o usuário pela sessão (cookie),
// chama a função certa de servico.js e devolve a resposta em JSON.
// Também entrega os arquivos da pasta public (HTML, CSS e JS da interface).
//
// Usa só módulos nativos do Node (http, fs, crypto): não precisa de npm install.
// A lista de rotas fica dentro de criarApp(); veja também a tabela no README.
// =============================================================================
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const S = require('./servico');
const { ErroNegocio, conferirSenha, agoraISO } = require('./util');

const PUBLICO = path.join(__dirname, '..', 'public');
const TIPOS = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const SESSAO_HORAS = 8;

// ---------------------------------------------------------------- roteador mínimo
/**
 * Roteador simples feito à mão (no lugar do Express).
 * Cada rota é registrada como, por exemplo, r.get('/api/solicitacoes/:id', ...).
 * O ":id" vira uma expressão regular que captura o valor e entrega em ctx.params.id.
 * achar() percorre as rotas e devolve a primeira que combina com o método e a URL.
 */
function criarRoteador() {
  const rotas = [];
  const add = (metodo) => (padrao, ...handlers) => {
    const nomes = [];
    const re = new RegExp('^' + padrao.replace(/:(\w+)/g, (_, n) => { nomes.push(n); return '([^/]+)'; }) + '$');
    rotas.push({ metodo, re, nomes, handlers });
  };
  return {
    get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE'),
    achar(metodo, url) {
      for (const r of rotas) {
        const m = r.metodo === metodo && url.match(r.re);
        if (m) return { handlers: r.handlers, params: Object.fromEntries(r.nomes.map((n, i) => [n, decodeURIComponent(m[i + 1])])) };
      }
      return null;
    },
  };
}

/**
 * Lê o corpo da requisição (o JSON que a tela envia) e converte para objeto.
 * Limita a 1 MB para evitar que alguém trave o servidor mandando dados enormes.
 */
function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let tam = 0; const partes = [];
    req.on('data', (c) => { tam += c.length; if (tam > 1e6) { reject(new ErroNegocio('Requisição muito grande.', 413)); req.destroy(); } else partes.push(c); });
    req.on('end', () => {
      if (!partes.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(partes).toString('utf8'))); } catch { reject(new ErroNegocio('JSON inválido.', 400)); }
    });
    req.on('error', reject);
  });
}

/**
 * Lê o cabeçalho Cookie e devolve um objeto { nome: valor }.
 * O cookie que importa aqui é o "sid", que guarda o token da sessão.
 */
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

/**
 * Envia a resposta HTTP: objeto vira JSON, texto vai como texto puro.
 */
function enviar(res, status, corpo, extras = {}) {
  const json = typeof corpo === 'string' ? corpo : JSON.stringify(corpo);
  res.writeHead(status, { 'Content-Type': typeof corpo === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', ...extras });
  res.end(json);
}

// ---------------------------------------------------------------- aplicação
/**
 * Monta a aplicação: registra todas as rotas da API e devolve a função
 * que o servidor HTTP chama a cada requisição.
 * Cada rota recebe um "ctx" (contexto) com: req, params, query, body e ator
 * (o usuário logado). As rotas protegidas passam antes pela função "auth".
 */
function criarApp(db) {
  const r = criarRoteador();
  const tentativas = new Map(); // limite simples de tentativas de login por IP (proteção contra força bruta)

  /**
   * Descobre quem está logado: procura o token do cookie na tabela "sessao".
   * Retorna null se não houver sessão, se ela expirou ou se o usuário foi desativado.
   */
  function usuarioDaSessao(req) {
    const token = cookies(req).sid;
    if (!token) return null;
    const s = db.prepare(`SELECT u.id, u.nome, u.email, u.perfil_id, u.ativo, s.expira_em FROM sessao s JOIN usuario u ON u.id = s.usuario_id WHERE s.token = ?`).get(token);
    if (!s || !s.ativo || s.expira_em < agoraISO()) return null;
    return { id: s.id, nome: s.nome, email: s.email, perfil_id: s.perfil_id };
  }
  /**
   * "Porteiro" das rotas protegidas: sem usuário logado, responde 401 (RN-01).
   */
  const auth = (ctx) => { if (!ctx.ator) throw new ErroNegocio('Faça login para continuar.', 401); };

  // --- autenticação (RF-01)
  r.post('/api/login', (ctx) => {
    const ip = ctx.req.socket.remoteAddress;
    const t = tentativas.get(ip) || { n: 0, ate: 0 };
    if (t.ate > Date.now()) throw new ErroNegocio('Muitas tentativas. Aguarde 1 minuto.', 429);
    const email = String(ctx.body.email || '').trim().toLowerCase();
    const u = db.prepare('SELECT * FROM usuario WHERE email = ?').get(email);
    if (!u || !u.ativo || !conferirSenha(String(ctx.body.senha || ''), u.senha_hash)) {
      t.n += 1; if (t.n >= 5) { t.ate = Date.now() + 60000; t.n = 0; } tentativas.set(ip, t);
      S.log(db, null, 'LOGIN_FALHOU', email);
      throw new ErroNegocio('E-mail ou senha inválidos.', 401);
    }
    tentativas.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('DELETE FROM sessao WHERE expira_em < ?').run(agoraISO());
    db.prepare('INSERT INTO sessao (token, usuario_id, expira_em) VALUES (?,?,?)').run(token, u.id, new Date(Date.now() + SESSAO_HORAS * 3600e3).toISOString());
    S.log(db, u.id, 'LOGIN', email);
    ctx.headers['Set-Cookie'] = `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSAO_HORAS * 3600}`;
    return { id: u.id, nome: u.nome, email: u.email, perfil_id: u.perfil_id, permissoes: S.PERMISSOES[u.perfil_id] };
  });
  r.post('/api/logout', (ctx) => {
    const token = cookies(ctx.req).sid;
    if (token) db.prepare('DELETE FROM sessao WHERE token = ?').run(token);
    ctx.headers['Set-Cookie'] = 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';
    return { ok: true };
  });
  r.get('/api/me', auth, (ctx) => ({ ...ctx.ator, permissoes: S.PERMISSOES[ctx.ator.perfil_id] }));

  // --- painel, notificações (RF-10)
  r.get('/api/painel', auth, (ctx) => S.painel(db, ctx.ator));
  r.get('/api/notificacoes', auth, (ctx) => S.notificacoes(db, ctx.ator));
  r.post('/api/notificacoes/lidas', auth, (ctx) => S.marcarLidas(db, ctx.ator));

  // --- recursos (RF-02, RF-03)
  r.get('/api/espacos', auth, (ctx) => S.espacosComDisponibilidade(db, ctx.query.inicio, ctx.query.fim));
  r.post('/api/espacos', auth, (ctx) => S.salvarEspaco(db, ctx.ator, ctx.body));
  r.put('/api/espacos/:id', auth, (ctx) => S.salvarEspaco(db, ctx.ator, ctx.body, ctx.params.id));
  r.get('/api/categorias', auth, () => db.prepare('SELECT * FROM categoria ORDER BY nome').all());
  r.post('/api/categorias', auth, (ctx) => S.salvarCategoria(db, ctx.ator, ctx.body));
  r.get('/api/equipamentos', auth, () => S.listarEquipamentos(db));
  r.post('/api/equipamentos', auth, (ctx) => S.salvarEquipamento(db, ctx.ator, ctx.body));
  r.put('/api/equipamentos/:id', auth, (ctx) => S.salvarEquipamento(db, ctx.ator, ctx.body, ctx.params.id));
  r.get('/api/equipamentos/painel', auth, (ctx) => { if (!S.pode(ctx.ator, 'movimentar')) throw new ErroNegocio('Acesso negado.', 403); return S.painelEquipamentos(db); });

  // --- disponibilidade e agenda (RF-04, RF-08)
  r.post('/api/disponibilidade', auth, (ctx) => S.consultarDisponibilidade(db, ctx.body));
  r.get('/api/agenda', auth, (ctx) => S.agenda(db, ctx.query));
  r.get('/api/agenda-publica', (ctx) => S.agenda(db, ctx.query, true)); // RF-16: sem dados pessoais

  // --- solicitações (RF-05..RF-09, RF-12, RF-13)
  r.get('/api/solicitacoes', auth, (ctx) => S.listarSolicitacoes(db, ctx.ator, ctx.query));
  r.post('/api/solicitacoes', auth, (ctx) => S.criarSolicitacao(db, ctx.ator, ctx.body));
  r.post('/api/atividades', auth, (ctx) => S.criarSolicitacao(db, ctx.ator, ctx.body)); // atividade + recursos
  r.get('/api/solicitacoes/:id', auth, (ctx) => S.obterSolicitacao(db, ctx.ator, ctx.params.id));
  r.put('/api/solicitacoes/:id', auth, (ctx) => S.atualizarSolicitacao(db, ctx.ator, ctx.params.id, ctx.body));
  r.patch('/api/solicitacoes/:id/enviar', auth, (ctx) => S.enviarSolicitacao(db, ctx.ator, ctx.params.id));
  r.patch('/api/solicitacoes/:id/aprovar', auth, (ctx) => S.aprovar(db, ctx.ator, ctx.params.id, ctx.body.justificativa));
  r.patch('/api/solicitacoes/:id/rejeitar', auth, (ctx) => S.rejeitar(db, ctx.ator, ctx.params.id, ctx.body.justificativa));
  r.patch('/api/solicitacoes/:id/ajustes', auth, (ctx) => S.solicitarAjustes(db, ctx.ator, ctx.params.id, ctx.body.justificativa));
  r.patch('/api/solicitacoes/:id/cancelar', auth, (ctx) => S.cancelar(db, ctx.ator, ctx.params.id, ctx.body.motivo));
  r.patch('/api/solicitacoes/:id/concluir', auth, (ctx) => S.concluir(db, ctx.ator, ctx.params.id));

  // --- retirada/devolução (RF-11)
  r.post('/api/movimentacoes', auth, (ctx) => S.registrarMovimentacao(db, ctx.ator, ctx.body));

  // --- bloqueios e administração
  r.get('/api/bloqueios', auth, () => S.listarBloqueios(db));
  r.post('/api/bloqueios', auth, (ctx) => S.criarBloqueio(db, ctx.ator, ctx.body));
  r.delete('/api/bloqueios/:id', auth, (ctx) => S.excluirBloqueio(db, ctx.ator, ctx.params.id));
  r.get('/api/usuarios', auth, (ctx) => S.listarUsuarios(db, ctx.ator));
  r.post('/api/usuarios', auth, (ctx) => S.salvarUsuario(db, ctx.ator, ctx.body));
  r.put('/api/usuarios/:id', auth, (ctx) => S.salvarUsuario(db, ctx.ator, ctx.body, ctx.params.id));
  r.get('/api/parametros', auth, () => S.listarParametros(db));
  r.put('/api/parametros', auth, (ctx) => S.salvarParametros(db, ctx.ator, ctx.body));
  r.get('/api/logs', auth, (ctx) => S.listarLogs(db, ctx.ator));

  // --- relatórios (RF-13, RF-14)
  r.get('/api/relatorios/utilizacao', auth, (ctx) => S.relatorioUtilizacao(db, ctx.ator, ctx.query));
  r.get('/api/relatorios/solicitacoes.csv', auth, (ctx) => {
    ctx.headers['Content-Type'] = 'text/csv; charset=utf-8';
    ctx.headers['Content-Disposition'] = 'attachment; filename="solicitacoes.csv"';
    return { __bruto: S.csvSolicitacoes(db, ctx.ator, ctx.query) };
  });

  /**
   * Entrega os arquivos da pasta public (HTML, CSS, JS, imagens).
   * O path.normalize + startsWith impede pedir arquivos fora da pasta (ex.: "../src/db.js").
   * Qualquer caminho desconhecido devolve o index.html (as telas usam rotas com #).
   */
  function servirEstatico(req, res, url) {
    let arquivo = path.normalize(path.join(PUBLICO, url === '/' ? 'index.html' : url));
    if (!arquivo.startsWith(PUBLICO)) return enviar(res, 403, 'Proibido');
    if (!fs.existsSync(arquivo) || fs.statSync(arquivo).isDirectory()) arquivo = path.join(PUBLICO, 'index.html');
    // no-cache: o navegador sempre confere se o arquivo mudou, assim uma versão nova aparece ao recarregar a página
    res.writeHead(200, { 'Content-Type': TIPOS[path.extname(arquivo)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(arquivo).pipe(res);
  }

  /**
   * Função chamada a cada requisição:
   * 1. coloca cabeçalhos de segurança;
   * 2. se não for /api/, serve arquivo estático;
   * 3. acha a rota, lê o corpo, identifica o usuário e executa;
   * 4. erros de negócio viram respostas com o código certo; erros inesperados viram 500
   *    com um código curto para o suporte achar no console (RNF-08).
   */
  return async function handler(req, res) {
    // Cabeçalhos de segurança básicos (RNF-04)
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:");
    const u = new URL(req.url, 'http://localhost');
    if (!u.pathname.startsWith('/api/')) return servirEstatico(req, res, u.pathname);
    const achado = r.achar(req.method, u.pathname);
    if (!achado) return enviar(res, 404, { erro: 'Rota não encontrada.' });
    const ctx = { req, params: achado.params, query: Object.fromEntries(u.searchParams), headers: {}, ator: null, body: {} };
    try {
      // CSRF: requisições que alteram dados precisam vir da própria página (cabeçalho customizado + SameSite=Strict)
      if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'fetch') throw new ErroNegocio('Requisição recusada.', 403);
      if (['POST', 'PUT', 'PATCH'].includes(req.method)) ctx.body = await lerCorpo(req);
      ctx.ator = usuarioDaSessao(req);
      let resultado;
      for (const h of achado.handlers) resultado = h(ctx);
      if (resultado && resultado.__bruto !== undefined) {
        res.writeHead(200, ctx.headers); return res.end(resultado.__bruto);
      }
      enviar(res, req.method === 'POST' ? 201 : 200, resultado ?? { ok: true }, ctx.headers);
    } catch (e) {
      if (e instanceof ErroNegocio) return enviar(res, e.status, { erro: e.message, detalhes: e.detalhes }, ctx.headers);
      // Rastreabilidade de falhas (RNF-08): código para o suporte localizar no console
      const codigo = crypto.randomBytes(4).toString('hex');
      console.error(`[erro ${codigo}]`, req.method, u.pathname, e);
      enviar(res, 500, { erro: `Erro interno. Informe ao suporte o código ${codigo}.` });
    }
  };
}

/**
 * Cria o servidor HTTP do Node usando a aplicação acima.
 */
function criarServidor(db) { return http.createServer(criarApp(db)); }

module.exports = { criarServidor };
