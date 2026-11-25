# Modelagem

Os diagramas estão em [Mermaid](https://mermaid.js.org). No VS Code, instale a extensão **Markdown Preview Mermaid Support** e abra a pré-visualização (`Ctrl+Shift+V`). No GitHub, eles aparecem renderizados automaticamente.

## DER (modelo de dados)

```mermaid
erDiagram
  PERFIL ||--o{ USUARIO : "define"
  USUARIO ||--o{ SOLICITACAO : "cria"
  USUARIO ||--o{ ATIVIDADE : "é responsável"
  ATIVIDADE |o--o| SOLICITACAO : "pode ter"
  SOLICITACAO ||--o{ RESERVA_ESPACO : "contém"
  SOLICITACAO ||--o{ RESERVA_EQUIPAMENTO : "contém"
  SOLICITACAO ||--o{ HISTORICO : "registra"
  ESPACO ||--o{ RESERVA_ESPACO : "é reservado"
  CATEGORIA ||--o{ EQUIPAMENTO : "classifica"
  EQUIPAMENTO ||--o{ RESERVA_EQUIPAMENTO : "é alocado"
  RESERVA_EQUIPAMENTO ||--o{ MOVIMENTACAO : "entrega/devolução"
  USUARIO ||--o{ NOTIFICACAO : "recebe"
  USUARIO ||--o{ BLOQUEIO : "cria"

  PERFIL { text id PK  text nome  text permissoes }
  USUARIO { int id PK  text nome  text email UK  text senha_hash  text perfil_id FK  int ativo }
  ATIVIDADE { int id PK  text titulo  text tipo  text descricao  int responsavel_id FK  text publico_alvo  int publico_estimado  text inicio  text fim }
  SOLICITACAO { int id PK  int atividade_id FK  int solicitante_id FK  text status  text inicio  text fim  text motivo  int excepcional  text criada_em }
  ESPACO { int id PK  text nome  text localizacao  int capacidade  int ativo }
  CATEGORIA { int id PK  text nome  text controle  int exige_retirada }
  EQUIPAMENTO { int id PK  text codigo_patrimonio UK  text nome  int categoria_id FK  text situacao  text localizacao  int quantidade_total }
  RESERVA_ESPACO { int id PK  int solicitacao_id FK  int espaco_id FK  text inicio  text fim  text status }
  RESERVA_EQUIPAMENTO { int id PK  int solicitacao_id FK  int equipamento_id FK  text inicio  text fim  int quantidade  text status  text retirada }
  MOVIMENTACAO { int id PK  int reserva_equipamento_id FK  text tipo  int responsavel_id FK  text pessoa  text data_hora  text condicao  int atraso }
  HISTORICO { int id PK  int solicitacao_id FK  int ator_id FK  text acao  text justificativa  text data_hora }
  BLOQUEIO { int id PK  text tipo_recurso  int recurso_id  text inicio  text fim  text motivo }
  NOTIFICACAO { int id PK  int usuario_id FK  int solicitacao_id FK  text mensagem  int lida }
```

Tabelas de apoio fora do diagrama: `sessao` (login), `parametro` (políticas configuráveis) e `log_auditoria` (ações administrativas).

**Cuidados da especificação atendidos:**
- Item individual (`controle = INDIVIDUAL`) é separado de item com estoque (`controle = QUANTIDADE`, com `quantidade_total`).
- Não existe um campo booleano "disponível": a disponibilidade é **calculada** para cada intervalo a partir das reservas aprovadas, dos bloqueios e da situação do item.

## Estados da solicitação

```mermaid
stateDiagram-v2
  [*] --> Rascunho: criar
  Rascunho --> Pendente: enviar (valida campos e conflitos)
  Pendente --> Aprovada: aprovar itens (revalida na transação)
  Pendente --> Rejeitada: rejeitar todos os itens (com justificativa)
  Pendente --> EmAjustes: pedir ajustes (com justificativa)
  EmAjustes --> Pendente: corrigir e reenviar
  Aprovada --> Pendente: alterar data/horário/recursos (RN-09)
  Rascunho --> Cancelada: cancelar
  Pendente --> Cancelada: cancelar
  EmAjustes --> Cancelada: cancelar
  Aprovada --> Cancelada: cancelar (libera recursos)
  Aprovada --> Concluida: após o término, sem equipamento pendente
  Rejeitada --> [*]
  Cancelada --> [*]
  Concluida --> [*]
```

## Processo: atividade com múltiplos recursos (10.1 a 10.3)

```mermaid
flowchart TD
  A[Solicitante cadastra atividade<br>e escolhe auditório + projetor] --> B{Verificar disponibilidade}
  B -- indisponível --> B1[Mostra motivo:<br>conflito, bloqueio, capacidade, manutenção] --> A
  B -- disponível --> C[Envia: solicitação PENDENTE]
  C --> D[Gestor de espaços<br>decide o auditório]
  C --> E[Resp. equipamentos<br>decide o projetor]
  D --> F{Revalida na transação}
  E --> F
  F -- conflito --> F1[Recusa aprovação: 409]
  F -- ok --> G[Itens APROVADOS<br>agenda confirmada]
  G --> H[No dia: registrar ENTREGA<br>responsável, hora, condição]
  H --> I[Ao término: registrar DEVOLUÇÃO<br>recebedor, hora, condição, atraso]
  I -- avaria --> J[Item fica AVARIADO<br>e indisponível]
  I --> K[Concluir atividade]
```

## Casos de uso

```mermaid
flowchart LR
  Sol([Solicitante]) --- UC1(Consultar disponibilidade)
  Sol --- UC2(Cadastrar atividade e solicitar recursos)
  Sol --- UC3(Acompanhar, editar e cancelar pedido)
  Gest([Gestor de espaços]) --- UC4(Aprovar / rejeitar / pedir ajustes de espaço)
  Gest --- UC5(Cadastrar espaços e bloqueios)
  Eq([Resp. equipamentos]) --- UC6(Aprovar equipamentos)
  Eq --- UC7(Registrar retirada e devolução)
  Eq --- UC8(Cadastrar equipamentos)
  Adm([Administrador]) --- UC9(Gerenciar usuários, parâmetros e auditoria)
  Pub([Público interno]) --- UC10(Ver agenda pública)
```
