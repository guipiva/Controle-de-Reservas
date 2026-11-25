// =============================================================================
// server.js — ponto de entrada. É o arquivo executado pelo "npm start".
// Abre o banco, cria os dados de demonstração na primeira execução
// e coloca o servidor no ar em http://localhost:3000 (ou na porta da variável PORT).
// =============================================================================
const { abrirBanco } = require('./db');
const { criarServidor } = require('./app');
const { popular, SENHA_DEMO } = require('./seed');

const db = abrirBanco();
if (db.prepare('SELECT COUNT(*) AS n FROM usuario').get().n === 0) {
  popular(db);
  console.log('Banco criado com dados de demonstração.');
}

const PORTA = Number(process.env.PORT) || 3000;
criarServidor(db).listen(PORTA, () => {
  console.log(`\nSistema de Reservas rodando em http://localhost:${PORTA}`);
  console.log(`Usuários de teste (senha: ${SENHA_DEMO}): ana@fatec.demo, bruno@fatec.demo (solicitantes),`);
  console.log('  carla@fatec.demo (gestora de espaços), diego@fatec.demo (equipamentos), admin@fatec.demo (admin)\n');
});
