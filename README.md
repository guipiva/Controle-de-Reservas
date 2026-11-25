# Sistema de Gestão de Atividades Extracurriculares e Reservas — Fatec

Aplicação web para solicitar, aprovar, acompanhar e cancelar reservas de **espaços** (auditório, salas, laboratórios) e **equipamentos** (projetores, microfones, cabos), com ou sem uma **atividade extracurricular** vinculada (palestra, oficina, minicurso…).


## Como rodar (Windows, macOS ou Linux)

**Pré-requisito:** [Node.js](https://nodejs.org) **22.13 ou mais novo**. Para conferir, rode `node -v` no terminal.

1. Abra esta pasta no **VS Code** (`Arquivo → Abrir Pasta…`).
2. Abra o terminal do VS Code (`Ctrl + '`) e rode:

   ```bash
   npm start
   ```

3. Acesse **http://localhost:3000** no navegador.

Não é preciso instalar nada com `npm install`: o projeto usa só módulos nativos do Node, inclusive o banco **SQLite** (`node:sqlite`). Na primeira execução o banco `data/reservas.db` é criado com dados de demonstração.

### Usuários de teste (senha de todos: `senha123`)

| E-mail | Perfil | O que pode fazer |
|---|---|---|
| ana@fatec.demo | Solicitante (docente) | Criar, editar, enviar e cancelar as próprias solicitações |
| bruno@fatec.demo | Solicitante (aluno) | Idem |
| carla@fatec.demo | Gestor de espaços / secretaria | Aprovar/rejeitar/pedir ajustes em **espaços**, cadastrar espaços, bloqueios, relatórios |
| diego@fatec.demo | Responsável por equipamentos | Aprovar **equipamentos**, cadastrar itens, registrar retirada e devolução |
| admin@fatec.demo | Administrador | Tudo, mais usuários, parâmetros e log de auditoria |

### Outros comandos

| Comando | Para quê |
|---|---|
| `npm test` | Roda os testes automatizados dos critérios de aceite CA-01 a CA-12 |
| `npm run seed` | Apaga e recria o banco com os dados de demonstração |
| `PORT=4000 npm start` | Usa outra porta (no PowerShell: `$env:PORT=4000; npm start`) |

## Estrutura

```
reservas-fatec/
├── src/
│   ├── server.js      ← ponto de entrada (npm start)
│   ├── app.js         ← API REST: rotas, sessão, segurança HTTP
│   ├── servico.js     ← REGRAS DE NEGÓCIO (conflitos, aprovação, devolução…)
│   ├── db.js          ← criação das tabelas (script do banco)
│   ├── seed.js        ← dados fictícios de demonstração
│   └── util.js        ← datas, hash de senha, regra de sobreposição
├── public/            ← interface web (HTML, CSS e JavaScript puro)
├── tests/             ← testes dos critérios de aceite
└── docs/              ← regras, requisitos, modelagem (DER), roteiro de demonstração
```

O código está comentado em português: cada arquivo começa explicando o seu papel, e cada função tem um comentário dizendo o que faz e qual regra da especificação (RN, RF, CA) atende. Para entender as regras, comece pelo `src/servico.js`.

Arquitetura (seção 12 da especificação): **interface responsiva → API HTTP/REST → camada de serviço com as regras → SQLite**. A camada de serviço (`servico.js`) é a única que decide; a interface nunca é a única barreira.

## Documentação

- [Regras de negócio e matriz de requisitos (RN/RF/RNF)](docs/REGRAS-E-REQUISITOS.md)
- [Modelagem: DER, estados e processo](docs/MODELAGEM.md)
- [Roteiro de demonstração](docs/ROTEIRO-DEMONSTRACAO.md)
- [Evidência de testes e limitações conhecidas](docs/TESTES.md)

## Endpoints principais

| Método e rota | Função |
|---|---|
| `POST /api/login` · `POST /api/logout` | Autenticação (sessão em cookie HttpOnly) |
| `GET /api/espacos?inicio=&fim=` | Espaços e disponibilidade no período |
| `GET /api/equipamentos` | Equipamentos e situação |
| `POST /api/atividades` ou `POST /api/solicitacoes` | Cadastrar atividade/solicitação de recursos |
| `PUT /api/solicitacoes/{id}` | Editar (revalida e volta para análise se já aprovada) |
| `PATCH /api/solicitacoes/{id}/enviar` | Enviar rascunho para análise |
| `PATCH /api/solicitacoes/{id}/aprovar` | Aprovar, revalidando a disponibilidade na transação |
| `PATCH /api/solicitacoes/{id}/rejeitar` · `/ajustes` | Rejeitar ou devolver para ajustes (justificativa obrigatória) |
| `PATCH /api/solicitacoes/{id}/cancelar` · `/concluir` | Cancelar (libera a agenda) ou concluir |
| `POST /api/disponibilidade` | Consulta informativa de disponibilidade |
| `POST /api/movimentacoes` | Registrar entrega/devolução de equipamento |
| `GET /api/agenda` · `GET /api/agenda-publica` | Agenda consolidada / pública (só aprovados, sem dados pessoais) |
| `POST /api/bloqueios` | Bloqueio de manutenção (avisa reservas afetadas) |
| `GET /api/relatorios/utilizacao` · `/solicitacoes.csv` | Relatórios e exportação CSV |
