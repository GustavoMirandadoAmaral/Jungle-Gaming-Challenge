# Jungle Gaming — Processador de apostas

Serviço distribuído para processar transações de apostas com NestJS, Bun, PostgreSQL, MikroORM, AWS SQS e LocalStack. O banco é a fonte de verdade para saldo, idempotência, ledger, inbox e outbox.

## Requisitos locais

- Bun 1.x
- Docker Desktop em execução com suporte a containers Linux
- Token do LocalStack configurado na conta local (necessário para iniciar a imagem usada pelo Compose)

## Configuração e inicialização

No PowerShell, na raiz do projeto:

```powershell
bun install
if (!(Test-Path .env)) { Copy-Item .env.example .env }
```

Abra `.env` e preencha `LOCALSTACK_AUTH_TOKEN`. Não compartilhe esse token e não o versione; `.env` está no `.gitignore`.

Suba PostgreSQL, LocalStack e as três instâncias da API:

```powershell
docker compose up -d --build
docker compose ps
```

Crie/atualize o schema com as migrations versionadas:

```powershell
docker compose exec app-1 bun run migration:up
```

As APIs ficam disponíveis em `http://localhost:3001`, `http://localhost:3002` e `http://localhost:3003`. As três compartilham o mesmo PostgreSQL e as mesmas filas SQS.

## Endpoints

- `POST /wallets` — cria uma carteira e, quando o saldo inicial é positivo, registra `OPENING` e o crédito no ledger na mesma transação SQL.
- `GET /wallets/:walletId` — consulta saldo e versão.
- `GET /wallets/:walletId/ledger?cursor=...&limit=50` — consulta lançamentos auditáveis.
- `POST /wallets/:walletId/reconciliation` — compara o saldo materializado com a soma do ledger.
- `POST /wagering/transactions` — recebe `BET`, `WIN`, `LOSS`, `REFUND` ou `ROLLBACK`; exige `Idempotency-Key`.
- `GET /wagering/transactions/:transactionId` — consulta pelo ID interno.
- `GET /providers/:providerId/wagering/transactions/:externalTransactionId` — consulta pelo identificador do provedor.
- `GET /health/live` e `GET /health/ready` — liveness e disponibilidade de PostgreSQL/SQS.
- `GET /metrics` — métricas Prometheus por instância, sem valores monetários ou payloads.

Valores monetários são strings decimais com duas casas, por exemplo `{ "amount": "25.00", "currency": "BRL" }`.

## Testes

Os testes unitários não precisam de serviços externos:

```powershell
bun run test:unit
```

Os testes de integração e concorrência usam PostgreSQL, LocalStack e as três APIs reais. Mantenha o Compose em execução e as migrations aplicadas:

```powershell
bun run test:integration
bun run test:concurrency
```

O teste de concorrência envia a mesma aposta 50 vezes entre as três instâncias e verifica disputa real pelo saldo. Os testes de integração exercitam inbox/redelivery, outbox/SQS, DLQ, referências, consultas e reconciliação.

Outros comandos:

```powershell
bunx tsc --noEmit
bun run lint
docker compose logs --tail=100 app-1
docker compose down
```

## Documentação técnica

Veja [ARCHITECTURE.md](ARCHITECTURE.md) para decisões de concorrência, idempotência, ledger, inbox/outbox, retentativas e limitações conhecidas.
