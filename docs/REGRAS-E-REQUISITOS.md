# Regras de negócio e matriz de requisitos

Onde cada item da especificação foi implementado. Arquivos: `src/servico.js` (regras), `src/app.js` (API), `public/js/app.js` (telas), `tests/criterios.test.js` (testes).

## Decisões de política (parametrizáveis em Administração → Parâmetros)

A especificação pede que regras institucionais sejam configuráveis. Os valores abaixo são **de teste**, não normas oficiais.

| Parâmetro | Valor padrão | Efeito |
|---|---|---|
| `intervalo_preparacao_min` | 0 | Folga de montagem/desmontagem entre reservas do mesmo espaço (RN-04) |
| `antecedencia_min_horas` | 24 | Pedidos com menos antecedência são "excepcionais" (RN-07) |
| `hora_abertura` / `hora_fechamento` | 07:00 / 23:00 | Fora disso é "excepcional" (RN-07) |
| `politica_fora_regra` | EXCECAO | `EXCECAO`: permite enviar, mas a aprovação exige justificativa. `BLOQUEAR`: impede o envio |
| `permitir_autoaprovacao` | 0 | Gestor **não** decide a própria solicitação (RNF-03) |
| `fuso` | America/Sao_Paulo | Fuso usado nas regras de horário e nas mensagens |

**Bloqueio provisório:** solicitações *pendentes* **não** bloqueiam a agenda; só reservas *aprovadas* ocupam o recurso. Quando há dois pedidos pendentes sobrepostos, o gestor vê um aviso na tela da solicitação, e o segundo a ser aprovado é recusado por conflito.

**Competência de aprovação:** o gestor de espaços decide os itens de espaço; o responsável por equipamentos decide os itens de equipamento; o administrador decide ambos. A solicitação fica *Aprovada* quando não resta item pendente e pelo menos um foi aprovado (RN-18), e fica *Rejeitada* se todos forem rejeitados.

## Regras de negócio

| Regra | Implementação | Teste |
|---|---|---|
| RN-01 Só autenticados e autorizados solicitam | `exigir(ator,'solicitar')`; rotas com `auth` → 401 | CA-05 |
| RN-02 Campos obrigatórios da atividade | `validarCompleto()` no envio | CA-06 |
| RN-03 Fim > início | `validarDatas()` + `CHECK (fim > inicio)` no banco | CA-06 |
| RN-04 Sem reservas sobrepostas no mesmo espaço (+ folga) | `verificarEspaco()` com `sobrepoe(iA,fA,iB,fB,folga)` | CA-01, CA-02, CA-02b |
| RN-05 Não ocupar bloqueios | `bloqueiosNoPeriodo()` em espaços e equipamentos | RN-05 |
| RN-06 Público ≤ capacidade | `verificarEspaco(..., publicoEstimado)` | CA-03 |
| RN-07 Horário/antecedência | `verificarPolitica()`; flag `excepcional`; justificativa obrigatória na aprovação | RN-07 |
| RN-08 Decisor, data/hora, justificativa | tabela `historico` (ator, ação, justificativa, data_hora) | CA-07 |
| RN-09 Alteração após aprovação revalida | `atualizarSolicitacao()` → revalida e volta a PENDENTE | CA-08 |
| RN-10 Cancelamento libera agenda e registra | `cancelar()` com motivo obrigatório | CA-09 |
| RN-11 Identificação do equipamento | `codigo_patrimonio` único, categoria, situação, local | — |
| RN-12 Item individual sem sobreposição | `verificarEquipamento()` (controle INDIVIDUAL) | CA-12 |
| RN-13 Saldo por quantidade nunca negativo | `picoDeUso()`: calcula o pico de uso simultâneo no intervalo | RN-13 |
| RN-14 Manutenção/avaria/inativo indisponível | situação ≠ DISPONIVEL bloqueia | CA-04, CA-11 |
| RN-15 Entrega com responsável, data/hora, condição | `registrarMovimentacao(tipo ENTREGA)`; hora do servidor | CA-10 |
| RN-16 Devolução com recebedor, condição, atraso, avaria | `registrarMovimentacao(tipo DEVOLUCAO)`; `atraso` calculado | CA-11 |
| RN-17 Equipamento vinculado a evento ou independente | atividade é opcional na solicitação | — |
| RN-18 Status de cada recurso | `status` em cada `reserva_espaco` / `reserva_equipamento` | RN-18 |

**Definição de conflito** (`util.js → sobrepoe`): `[iA, fA)` e `[iB, fB)` se sobrepõem quando `iA < fB + folga` e `iB < fA + folga`. Assim, 16h–18h não conflita com 14h–16h quando a folga é zero.

## Casos de exceção (seção 10.4)

| Exceção | Tratamento |
|---|---|
| Mesmo auditório pedido por duas pessoas em horários sobrepostos | Ambos podem ficar pendentes; o gestor vê aviso; só o primeiro aprovado passa |
| Dois usuários aprovando simultaneamente o último projetor | Aprovação em transação `BEGIN IMMEDIATE` com nova verificação → a segunda recebe 409 |
| Alteração de horário de evento confirmado | Revalida e volta para análise, liberando a agenda aprovada |
| Equipamento não devolvido no prazo e nova reserva próxima | Item retirado e não devolvido continua ocupado até a devolução real; aparece como **Atrasado** |
| Bloqueio de manutenção sobre reservas aprovadas | Bloqueio é criado; a tela lista as reservas afetadas e os solicitantes são notificados |

## Requisitos funcionais

| RF | Status | Onde |
|---|---|---|
| RF-01 Autenticação e permissões por perfil | ✅ | `/api/login`, `PERMISSOES` em `servico.js`, menu por perfil |
| RF-02 Espaços e capacidades | ✅ | Tela Espaços |
| RF-03 Equipamentos, categorias, disponibilidade | ✅ | Tela Equipamentos |
| RF-04 Calendário por dia, semana, espaço e situação | ✅ | Tela Calendário (livre / ocupado / pendente / bloqueado) |
| RF-05 Atividade extracurricular | ✅ | Nova solicitação (atividade vinculada) |
| RF-06 Solicitar espaço | ✅ | Nova solicitação |
| RF-07 Solicitar um ou mais equipamentos | ✅ | Nova solicitação (com quantidade) |
| RF-08 Validar conflitos no servidor | ✅ | No envio **e** de novo na aprovação |
| RF-09 Aprovar, rejeitar, devolver para ajustes | ✅ | Fila de aprovação → detalhe |
| RF-10 Notificações no sistema | ✅ | Sino no topo |
| RF-11 Retirada e devolução | ✅ | Equipamentos e detalhe da solicitação |
| RF-12 Histórico de alterações e decisões | ✅ | Linha do tempo + log de auditoria |
| RF-13 Listagem filtrável | ✅ | Relatórios, Minhas solicitações, Fila |
| RF-14 Exportar CSV/PDF *(opcional)* | ✅ CSV | Relatórios → Exportar CSV (PDF: imprimir a página) |
| RF-15 E-mail *(opcional)* | ❌ | Fora do escopo |
| RF-16 Calendário público *(opcional)* | ✅ | `/#/publica` (só aprovados, sem dados pessoais) |

## Requisitos não funcionais

| RNF | Como foi atendido |
|---|---|
| RNF-01 Responsivo e teclado | Layout com menu recolhível no celular; linhas de tabela acessíveis por Tab + Enter |
| RNF-02 Validação no front e no back | Validação no navegador só para ajudar; o servidor valida tudo de novo |
| RNF-03 Autorização no servidor; sem autoaprovação | Toda rota checa o perfil; parâmetro `permitir_autoaprovacao` |
| RNF-04 Hash de senha e proteção contra ataques | `scrypt` + salt; cookie HttpOnly SameSite=Strict; SQL parametrizado; escape de HTML; CSP; cabeçalho anti-CSRF; limite de tentativas de login. HTTPS fica a cargo do servidor de publicação |
| RNF-05 Transações | `transacao()` com `BEGIN IMMEDIATE` em criação, aprovação, cancelamento e movimentação |
| RNF-06 UTC no banco, fuso local na tela | ISO 8601 UTC no banco; a interface mostra no fuso do navegador |
| RNF-07 Dados mínimos (LGPD) | Só nome e e-mail; agenda pública sem nomes; dados de exemplo fictícios |
| RNF-08 Erros claros e rastreáveis | Mensagens por campo; erros 500 geram código exibido ao usuário e registrado no console |
| RNF-09 Acessibilidade | Rótulos em todos os campos, foco visível, contraste AA, status com texto (não só cor), link "pular para o conteúdo", `aria-live` |
