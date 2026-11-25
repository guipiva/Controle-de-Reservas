# Roteiro de demonstração (≈ 10 minutos)

Cobre o pedido da seção 13: **reservar auditório, detectar conflito, aprovar, registrar equipamento e devolução**.

Antes de apresentar, rode `npm run seed` para começar com dados limpos e depois `npm start`. Senha de todos: `senha123`.
Já existe uma palestra **aprovada no Auditório daqui a 3 dias, das 14h às 16h**.

## 1. Solicitante reserva o auditório e o sistema detecta o conflito (CA-01)
1. Entre como **ana@fatec.demo**.
2. **Nova solicitação** → marque "Vincular a uma atividade", preencha título, tipo, descrição, público (ex.: 60).
3. Data: daqui a 3 dias · 15:00 às 17:00 · Espaço: **Auditório** · Equipamento: **Projetor Epson 02**.
4. Clique **Verificar disponibilidade** → aparece o conflito com a palestra, com o horário.
5. Tente **Enviar** → o sistema recusa e explica o motivo.

## 2. Ajusta o horário e envia (CA-02)
6. Mude para **16:00 às 18:00** → Verificar → tudo livre (16h pode começar quando a outra termina).
7. **Enviar para análise** → status *Pendente*.
8. *(Opcional, CA-03)* Mude os participantes para 150 e verifique → excede a capacidade de 120.

## 3. Aprovação por recurso (RN-18, CA-07)
9. Saia e entre como **carla@fatec.demo** (gestora de espaços). O sino mostra a nova solicitação.
10. **Fila de aprovação** → abra o pedido → **Aprovar** → o auditório fica *Aprovado*, mas o projetor continua *Pendente*: cada recurso tem a sua situação.
11. *(Opcional)* Mostre que **Rejeitar** sem justificativa não é aceito.

## 4. Equipamento: aprovação, entrega e devolução com avaria (CA-10, CA-11)
12. Entre como **diego@fatec.demo** → abra a mesma solicitação → **Aprovar** → agora ela fica *Aprovada*.
13. **Registrar entrega** → quem retirou: Ana → a hora é gravada pelo servidor.
14. **Registrar devolução** → condição **Avariado** → tente salvar sem observação (é recusado) → escreva "lente riscada".
15. Vá em **Equipamentos**: o Projetor Epson 02 aparece como *Avariado* e não pode ser reservado; a ocorrência fica registrada.

## 5. Segurança e regras extras
16. **CA-05:** logado como Ana, o menu não mostra a Fila. Se a URL de aprovação for chamada direto, a API responde **403** (coberto pelo teste automatizado).
17. **CA-04:** em Nova solicitação, o *Projetor BenQ 03* (em manutenção) aparece desabilitado.
18. **Bloqueios** (Carla): crie um bloqueio no Auditório no dia da palestra → o sistema avisa quais reservas foram afetadas.
19. **Calendário:** mostre a semana com os estados livre, ocupado, pendente e bloqueado.
20. **Relatórios** (admin): utilização por espaço e equipamento, e exportação em CSV.
21. Termine rodando `npm test` no terminal: os testes dos critérios de aceite passando.
