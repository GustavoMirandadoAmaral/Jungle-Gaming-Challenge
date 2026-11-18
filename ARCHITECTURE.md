# Decisões de arquitetura

## Limites e fonte de verdade

NestJS organiza a API HTTP, os casos de uso e os workers. O domínio financeiro não depende de decorators do Nest nem de tipos monetários do ORM. PostgreSQL é a fonte de verdade: não há lock ou mapa em memória necessário para a correção entre instâncias.

`Money` recebe strings decimais, faz operações com `decimal.js` e serializa sempre com duas casas. O schema persiste valores em `numeric(20, 2)`. Entradas externas negativas, valores fora de escala e notação científica são rejeitados.

## Concorrência por carteira

`ProcessWagerTransaction` abre uma transação MikroORM e bloqueia somente a linha da carteira afetada com `SELECT ... FOR UPDATE`. A leitura do saldo, validação, atualização da carteira, transação de aposta, ledger, inbox (na entrada SQS) e outbox ocorrem nessa transação. Uma carteira quente serializa suas movimentações; carteiras diferentes continuam concorrentes. `FOR UPDATE` funciona no PostgreSQL compartilhado pelas três instâncias e não depende de uma instância específica.

O banco aplica também as invariantes que precisam sobreviver a bugs de aplicação:

- unicidade de carteira por jogador/moeda, de ID externo por provedor e de chave idempotente por provedor;
- saldo da carteira não negativo;
- no máximo um lançamento de ledger por transação;
- aritmética do lançamento verificada por constraint;
- lançamentos de ledger protegidos por trigger contra `UPDATE` e `DELETE`;
- uma reversão processada por referência e tipo, por índice único parcial.

## Idempotência persistente

`(provider_id, idempotency_key)` tem constraint única. O caso de uso calcula SHA-256 sobre um JSON estável dos campos de negócio, sem incluir a chave nem metadados de transporte. Uma repetição com o mesmo hash retorna o resultado persistido; a mesma chave com outro hash resulta em conflito. O índice único no PostgreSQL arbitra a corrida entre processos.

## Ledger e reconciliação

Cada movimento de saldo cria um `WalletLedgerEntry` com direção, valor, saldo anterior/posterior e versão. A linha do ledger é inserida na mesma transação da atualização da carteira. `LOSS` e transações rejeitadas não alteram saldo e não criam lançamento. A reconciliação soma créditos menos débitos no PostgreSQL e compara com o saldo armazenado; divergências são retornadas e logadas, sem correção silenciosa.

## Referências fora de ordem e reversões

`REFUND` e `ROLLBACK` exigem uma referência do mesmo provedor, jogador, carteira, moeda e rodada, com valor igual ao da operação original. `REFUND` reverte `BET`; `ROLLBACK` reverte `BET`, `WIN` ou `REFUND`. Reversões são atômicas com a alteração do saldo e não podem deixar saldo negativo; esse caso tem código de falha próprio.

Se a referência ainda não existe, a operação fica persistida como `PENDING_REFERENCE`, sem movimento de saldo. A chegada normal da referência tenta resolver as pendências dentro da transação do próprio uso de caso. Um worker agendado também busca novamente referências pendentes com `FOR UPDATE SKIP LOCKED` e backoff exponencial, compartilhando o mesmo caso de uso para aplicar uma reversão. A configuração padrão é poll de 5 s, até 10 tentativas ou 60 min de TTL; esgotado o limite, a operação é rejeitada com `REFERENCE_NOT_FOUND` e evento na outbox.

## Inbox, SQS e ack

O consumidor SQS usa `ProcessWagerTransaction`, igual à API HTTP. `(consumer_name, message_id)` tem constraint única em uma inbox persistente. A inbox e os efeitos financeiros confirmam juntos; a mensagem só recebe `DeleteMessage` depois do commit. Redelivery após o commit encontra a inbox e não repete o débito/crédito. Falhas transitórias recebem visibilidade crescente. Ao esgotar o limite de recebimentos configurado (5 por padrão), uma mensagem válida que falhou tecnicamente é registrada como `FAILED` no PostgreSQL, sem alterar saldo nem ledger; ela continua sem ack para o redrive nativo encaminhá-la à DLQ. Mensagens malformadas também seguem para a DLQ, embora não possam gerar uma linha de aposta auditável. Se o PostgreSQL estiver indisponível durante a gravação do estado `FAILED`, o SQS continua sendo o registro recuperável da mensagem. Em `SIGTERM`, o hook de desligamento impede novos polls e aguarda o poll atual, incluindo processamento e ack, terminar.

## Outbox e publicação

Os eventos são gravados na outbox dentro da transação financeira e, portanto, não podem ser publicados antes do commit. Publishers concorrentes reivindicam lotes com `FOR UPDATE SKIP LOCKED` e lease persistido. A publicação usa FIFO, grupo por agregado e `eventId` como deduplicação do broker; o consumidor ainda precisa tolerar entrega duplicada, pois SQS oferece entrega at-least-once. Falhas de publicação liberam o item após backoff, permitindo que outra instância retome o trabalho.

## Métricas

`GET /metrics` expõe formato Prometheus em cada instância. Contadores incluem operações por status, replay/conflito idempotente, duplicatas da inbox, retries por origem e conflitos de lock do PostgreSQL. O histograma acompanha duração do caso de uso. Gauges acompanham idade do evento pendente mais antigo na outbox e mensagens visíveis/em voo na DLQ. Cada processo mantém seus próprios contadores; o scraper deve coletar todas as três instâncias e agregá-las. Nenhuma métrica inclui valores ou payloads financeiros.

## Decisões e limitações conhecidas

- Autenticação não foi implementada; ela não pontua no desafio. Os endpoints de provedor dependem de `ProviderIdentityPort`, hoje ligado ao adapter `NoopProviderIdentity`. Para produção, substitua esse adapter por validação OIDC em um IdP externo; não crie autenticação artesanal nem tabela local de senhas.
- A cobertura atual inclui testes unitários de domínio, integrações reais com PostgreSQL/LocalStack e cenários de concorrência em três instâncias. Há cenários dedicados para rollback atômico de carteira, transação, ledger, inbox e outbox diante de falha na inserção da outbox; persistência de `FAILED` depois do limite de tentativas e encaminhamento à DLQ; constraints do schema, publishers concorrentes, morte do consumer após o commit e antes do ack, desligamento por `SIGTERM`, reinício de uma instância preservando idempotência e ledger, e encerramento do publisher após reivindicar um evento confirmado, seguido da retomada por outra instância após o lease.
- O `bun run lint` ainda apresenta diagnósticos de estilo/tipagem no repositório; isso não altera o resultado de `bunx tsc --noEmit` nem dos testes executados.
