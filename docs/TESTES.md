# Evidência de testes e limitações conhecidas

## Testes automatizados

Arquivo: `tests/criterios.test.js` (executor nativo `node:test`). Cada teste cria um banco novo em memória com os dados fictícios, então os testes não interferem no banco da aplicação.

```bash
npm test
```

Resultado da última execução (Node v22.23.5, 23/11/2026):

```
ok 1 - CA-01: auditório 14h–16h reservado; pedido 15h–17h não pode ser aprovado
ok 2 - CA-02: auditório 14h–16h reservado; pedido 16h–18h é permitido
ok 3 - CA-02b: com intervalo de preparação configurado, 16h–18h passa a conflitar
ok 4 - CA-03: auditório com capacidade 120 e evento de 150 pessoas é bloqueado
ok 5 - CA-04: equipamento em manutenção não pode ser reservado
ok 6 - CA-05: usuário comum chamando a URL de aprovação recebe acesso negado (HTTP 403)
ok 7 - CA-06: solicitação com campos obrigatórios ausentes não pode ser enviada
ok 8 - CA-07: rejeição exige justificativa e fica no histórico
ok 9 - CA-08: alterar data de reserva aprovada revalida conflitos e volta para aprovação
ok 10 - CA-09: cancelamento libera o horário e registra quem cancelou e o motivo
ok 11 - CA-10: retirada registra responsável e horário da entrega
ok 12 - CA-11: devolução com avaria registra a condição e indisponibiliza o item
ok 13 - CA-12: dois aprovadores no mesmo recurso — só uma aprovação conclui
ok 14 - RN-13: item por quantidade não fica com saldo negativo
ok 15 - RN-05: pedido em período bloqueado por manutenção é recusado
ok 16 - RN-07: fora do horário exige justificativa de aprovação excepcional
ok 17 - RNF-03: gestor não decide a própria solicitação
ok 18 - RN-18: aprovação parcial mostra o status de cada recurso
# tests 18
# pass 18
# fail 0
```

| Critério | Cenário | Resultado esperado | Status |
|---|---|---|---|
| CA-01 | Auditório 14h–16h reservado; pedido 15h–17h | Aprovação impedida, conflito sinalizado | ✅ |
| CA-02 | Auditório 14h–16h reservado; pedido 16h–18h | Permitido | ✅ |
| CA-03 | Capacidade 120, evento com 150 | Bloqueado | ✅ |
| CA-04 | Equipamento em manutenção | Não reserva | ✅ |
| CA-05 | Usuário comum chama a URL de aprovação | HTTP 403 (e 401 sem login) | ✅ |
| CA-06 | Dados obrigatórios ausentes | Envio impedido, campos indicados | ✅ |
| CA-07 | Gestor rejeita | Justificativa exigida, histórico gravado | ✅ |
| CA-08 | Alterar data de reserva aprovada | Revalida e volta para aprovação | ✅ |
| CA-09 | Cancelamento | Horário liberado, cancelamento registrado | ✅ |
| CA-10 | Retirada | Responsável e horário registrados | ✅ |
| CA-11 | Devolução com avaria | Condição registrada, item indisponível | ✅ |
| CA-12 | Dois aprovadores no mesmo recurso | Só uma aprovação conclui | ✅ |

Testes extras: intervalo de preparação (RN-04), saldo por quantidade (RN-13), bloqueio de manutenção (RN-05), aprovação excepcional fora do horário (RN-07), autoaprovação vedada (RNF-03) e aprovação parcial por recurso (RN-18).

Além disso, o fluxo completo foi exercitado no navegador (Chromium): login → nova solicitação com conflito → ajuste → envio → aprovação do espaço → aprovação do equipamento → entrega → devolução com avaria → equipamentos, relatórios, administração, bloqueios, espaços, visão em celular e agenda pública.

## Limitações conhecidas

- **Concorrência:** o SQLite com um único processo Node serializa as transações (`BEGIN IMMEDIATE`), o que garante o CA-12 nesta implantação. Em produção com vários servidores, o recomendado é PostgreSQL com bloqueio de linha (`SELECT … FOR UPDATE`) ou restrição de exclusão por intervalo.
- **Pendentes não reservam provisoriamente:** é a política escolhida (seção 3 deixa a decisão para a instituição). O gestor é avisado de pedidos pendentes sobrepostos.
- **Uma solicitação usa um único período e no máximo um espaço.** Eventos de vários dias ou com várias salas viram várias solicitações.
- **Recorrência** (ex.: toda terça) não foi implementada.
- **E-mail (RF-15) e PDF (RF-14)** não foram implementados; há exportação CSV e é possível imprimir a página.
- **HTTPS** depende do servidor onde o sistema for publicado; localmente roda em HTTP.
- **Sessões** ficam no banco e expiram em 8 horas; não há "esqueci minha senha" (o administrador redefine).
- O limite de tentativas de login fica em memória e zera quando o servidor reinicia.
