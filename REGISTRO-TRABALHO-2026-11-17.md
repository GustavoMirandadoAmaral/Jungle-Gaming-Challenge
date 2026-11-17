# Registro de trabalho — 17/11/2026

Este arquivo resume o trabalho feito hoje no desafio, as decisões principais e como verificar o projeto. Ele complementa o `README.md` e o `ARCHITECTURE.md`; não substitui as instruções originais do desafio.

## Objetivo do projeto

Construir um processador de transações de apostas que mantenha saldo correto sob concorrência, duplicidade de requisições, múltiplas instâncias e falhas entre a confirmação no banco e a comunicação com SQS.

## O que foi implementado

### API, carteiras e valores monetários

- API NestJS com três instâncias, todas conectadas ao mesmo PostgreSQL.
- Criação e consulta de carteiras, incluindo consulta paginada do ledger.
- Valores monetários trafegam como strings decimais e são calculados com `decimal.js`; o banco usa `numeric`, sem converter dinheiro para `number`.
- A abertura da carteira e seu crédito inicial são persistidos juntos; o crédito aparece no ledger com saldo anterior, saldo posterior e versão.
- Health checks de vida e prontidão e endpoint de métricas por instância.

### Apostas, consistência e idempotência

- Processamento de `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`.
- Transações PostgreSQL e bloqueio `SELECT ... FOR UPDATE` na carteira afetada. Isso serializa operações concorrentes sobre a mesma carteira e deixa carteiras diferentes progredirem em paralelo.
- Restrições no banco protegem invariantes como saldo não negativo, unicidade de transações do provedor e um lançamento de ledger por transação.
- Chaves de idempotência e hash do conteúdo de negócio ficam persistidos no PostgreSQL. Repetir a mesma chave e o mesmo conteúdo devolve o resultado original; reutilizar a chave com conteúdo diferente retorna conflito sem reaplicar o movimento.
- Ledger auditável e reconciliação que compara o saldo materializado com os lançamentos.
- Referências fora de ordem são mantidas como pendentes e reprocessadas com backoff; reversões respeitam tipo, provedor, jogador, carteira, rodada e valor da operação original.

### Integração com SQS

- Outbox transacional grava eventos junto com as alterações financeiras; o publisher só envia eventos depois do commit.
- Publisher e consumer podem rodar em várias instâncias e usam registros persistidos, leases e `SKIP LOCKED` para dividir trabalho.
- Inbox persistente impede que uma redelivery processe a mesma mensagem duas vezes.
- Mensagens inválidas têm política de redrive para DLQ; falhas transitórias são tentadas novamente.
- A prova da janela entre commit e confirmação no SQS usa LocalStack e força a primeira tentativa de `DeleteMessage` a falhar. A mensagem real volta a ser entregue e a inbox mantém um único débito. Isso reproduz a falha de ack após commit sem encerrar à força o processo do worker.

## Testes e validações

Os cenários de integração e concorrência usam PostgreSQL, LocalStack/SQS e as três APIs reais; não substituem esses componentes por mocks.

- Concorrência: 50 envios idênticos distribuídos entre as três instâncias resultam em um débito; apostas concorrentes não permitem gastar além do saldo.
- Integração SQS: consumer, inbox/redelivery, publisher/outbox, DLQ e publicação de eventos.
- Recuperação após reinício: reiniciar uma instância da API não perde a idempotência persistida nem duplica o lançamento do ledger.
- Conflito de idempotência: a mesma chave com valor alterado retorna `409 IDEMPOTENCY_CONFLICT`, sem mudar saldo, versão ou ledger. O teste de integração desse cenário passou contra o ambiente local real.
- Suíte completa do lote atual: **30 testes aprovados, 0 falhas e 206 verificações (`expect`)**, em 15 arquivos.
- `bunx tsc --noEmit`: concluído sem erros.

Com PostgreSQL, LocalStack e as três instâncias em execução, os comandos principais são:

```powershell
bun run test:unit
bun run test:integration
bun run test:concurrency
bun run test
bunx tsc --noEmit
```

## Commits feitos hoje

| Commit | Conteúdo |
| --- | --- |
| `404acb7` | criação e consulta de carteiras |
| `e80f005` | correção de concorrência no processamento de apostas |
| `0f74aed` | testes de concorrência e resposta padronizada das apostas |
| `914b578` | publisher e consumer SQS com inbox |
| `28127bb` | reversões e reconciliação de carteiras |
| `6d34fff` | documentação de arquitetura e métricas operacionais |

Também houve commits anteriores de estrutura inicial e health check Docker: `170db45` e `b8b3441`.

## Alterações deste registro ainda não commitadas

No momento em que este documento foi escrito, o lote novo contém:

- teste de conflito de idempotência;
- teste de reinício de instância e recuperação da idempotência;
- teste de redelivery após falha do ack SQS depois do commit;
- ajuste no consumer para permitir apontar esses testes a uma fila isolada.

O próprio registro também é novo. Conferir `git status` antes de criar o próximo commit. `regras-do-desafio.md` é material fornecido para consulta e permanece ignorado pelo Git; `.env` e tokens locais não devem ser commitados.

## Conceitos para explicar na avaliação

1. **Por que PostgreSQL é a fonte da verdade:** saldo, chave idempotente, ledger, inbox e outbox precisam sobreviver a reinícios e ser compartilhados entre todas as instâncias.
2. **Como se evita saldo negativo em corridas:** cada operação bloqueia a linha da carteira no banco, lê e valida o saldo dentro da mesma transação e confirma saldo e ledger juntos.
3. **Como funciona a idempotência:** a chave e a impressão digital do conteúdo ficam no banco; a restrição única resolve inclusive duas requisições simultâneas em processos diferentes.
4. **Por que existe inbox/outbox:** inbox deduplica mensagens recebidas de forma persistente; outbox só publica efeitos correspondentes a transações já confirmadas.
5. **Por que a entrega SQS ainda pode repetir:** uma falha entre o commit e o ack permite redelivery. A inbox transforma essa repetição em uma operação sem novo efeito financeiro.
