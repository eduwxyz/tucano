# Acompanhamento de jobs do Databricks

Data: 2026-11-06
Branch: `feature/job-watch`, a partir de `origin/main`

## Objetivo

Permitir que um agente acompanhe um job do Databricks a partir de um `job_id` ou `run_id`. O app consulta o run sem gastar tokens, mostra um cartão animado com estado e métricas, detecta possíveis travamentos e acorda o agente só em eventos relevantes, para ele analisar seguindo uma skill.

## Decisões

| Tema | Decisão |
|---|---|
| Compute | Cluster clássico |
| Acesso | CLI do Databricks, com o perfil escolhido nas Configurações |
| Estrutura | Módulo próprio no núcleo, separado das rotinas |
| Cartão | Painel com métricas visíveis; num run concluído, encolhe para uma linha |
| Comandos | Lista de permitidos configurável; o que não estiver nela é bloqueado |
| Sem run ativo | Com um job e sem run ativo, o app mostra o último run e não inicia o job |

## Fora da primeira versão

- CPU e custo: dependem de tabelas de sistema, de um SQL warehouse e de `POST`, e chegam com atraso.
- Compute serverless.
- Painel com todos os jobs acompanhados.
- Notificação específica de jobs no Telegram. A análise do agente usa as notificações normais do Tucano.
- Outros sistemas além do Databricks. A interface de leitura não impede adicioná-los depois.
- Autenticação por token próprio do Tucano.
- Reparar runs (`repair-run`).

## Sem configuração obrigatória

O app acha a CLI e o perfil sozinho, com `databricks auth profiles`, chamada fixa do próprio app, e mostra o resultado nas Configurações. O perfil e o caminho só são informados à mão para escolher outro. O achado vale por 10 minutos, e um login recusado ou uma CLI ausente faz procurar de novo.

## Etapa 0: validação obrigatória

Antes de construir as métricas do Spark, validar com a CLI do usuário, num cluster em execução:

1. A CLI está instalada onde o Tucano roda, e o perfil autentica. As Configurações mostram o resultado.
2. `databricks api get` alcança a API de monitoramento do Spark pelo proxy do driver. Não há documentação oficial confirmando esse caminho. A validação também define o formato exato do caminho e como obter a organização, o cluster e a porta.
3. As respostas trazem progresso por etapa, shuffle, spill e memória dos executores.
4. Os nomes das flags da CLI e o formato de `jobs get-run` e `jobs list-runs` na versão instalada batem com esta spec.

**Até essa validação, o endereço é uma tentativa:** com o campo vazio, o app testa `/driver-proxy-api/o/<org>/<cluster>/<porta>/api/v1`, com o número do workspace do link do run e depois `0`, nas portas 40001 e 4040. Guarda o que responder, e um cluster que não respondeu só é testado de novo após 5 minutos. O cartão mostra o motivo de cada ausência.

**Se o item 2 ou 3 falhar:** o cartão fica com estado, duração, tasks e comparação com a média. Shuffle, spill, memória e progresso da etapa aparecem como indisponíveis. A detecção de travamento usa só "lentidão fora do normal". Nenhuma fonte alternativa entra nesta versão sem nova decisão do usuário.

## Arquitetura

```
Agente -> acompanhar_job -> job-watches -> cli-policy -> CLI do Databricks
                                ^                              |
                                |                              v
                        cartão e agente <- job-detect <- databricks (leitura)
```

| Arquivo | Responsabilidade | Depende de |
|---|---|---|
| `src/core/cli-policy.ts` | Decide se um comando pode rodar | Só das configurações recebidas |
| `src/core/databricks.ts` | Executa a CLI e devolve uma leitura padronizada | `cli-policy`, `node:child_process` |
| `src/core/job-detect.ts` | Compara leituras e produz eventos | Nada: funções puras |
| `src/core/job-watches.ts` | Persiste, agenda consultas, acorda o agente e define as ferramentas | `db`, `databricks`, `job-detect`, `runs` |
| `src/renderer/src/components/JobWatchCard.tsx` | Cartão na conversa | Store do renderer |

Pontos de integração em código existente:

- `src/core/db.ts`: nova migração e métodos da tabela.
- `src/core/runs.ts`: `runJobEvent`, equivalente a `runRoutine`, e registro das ferramentas.
- `src/shared/types.ts` e `src/shared/rpc.ts`: tipos, evento `job_watch`, RPCs de listar e parar, e `Run.jobWatchIds`.
- `Conversation.tsx`: desenha `JobWatchCard` abaixo da mensagem, como `ServiceCard` e `BrowserCard`.
- Tela de Configurações e aba **Ferramentas** do agente.
- `src/core/guide/`: nova página de ajuda, com uma receita inicial de skill de análise.

Todo texto visível usa `L(pt, en)`. Como o módulo roda no núcleo, ele também funciona com o Tucano em modo servidor, desde que a CLI esteja na máquina do servidor.

## Modelo de dados

Migração nova em `MIGRATIONS`, criando `job_watches`. A estrutura guardada:

```ts
interface JobWatch {
  id: string
  agentId: string
  conversationId: string
  messageId: string // a mensagem que mostra o cartão; as análises vão na thread dela
  jobId?: string
  runId: string
  status: 'watching' | 'ended'
  endReason?: 'finished' | 'stopped' | 'max_time' | 'not_found' | 'agent_removed'
  reading?: JobReading // a última leitura válida
  readAt?: number
  readError?: string // por que a última consulta falhou
  baselineMs?: number // mediana dos últimos runs bem-sucedidos
  firedAlerts: string[] // chaves de alerta já disparadas, como "no_progress:stage-14"
  heldEvents: JobEvent[] // eventos esperando o horário de silêncio ou a pausa
  wakes: number
  createdAt: number
  endedAt?: number
}
```

`job_id` e `run_id` são guardados como texto. O parser não pode perder precisão em IDs numéricos grandes.

## Leitura padronizada

```ts
interface JobReading {
  name: string
  url?: string
  state: 'queued' | 'running' | 'terminating' | 'waiting_retry' | 'succeeded' | 'failed' | 'timed_out' | 'canceled'
  startedAt?: number
  endedAt?: number
  tasks: { key: string; state: JobReading['state']; ms?: number; attempt?: number; runId?: string; error?: string }[]
  spark?: {
    stageId: string
    stageName?: string
    tasksDone: number
    tasksTotal: number
    tasksActive: number
    medianTaskMs?: number
    longestActiveTaskMs?: number
    shuffleBytes: number
    spillBytes: number
    memoryPercent?: number
  }
}
```

O parser aceita tanto `state.life_cycle_state` quanto `status.state`. `TERMINATING` não é estado final. `BLOCKED` e `WAITING` contam como `queued`, e `WAITING_FOR_RETRY` conta como `waiting_retry`. Um run com falhas parciais (`SUCCESS_WITH_FAILURES`) conta como `failed`.

## Regras de comandos

`cli-policy.ts` avalia o vetor de argumentos antes de qualquer execução. A CLI é sempre chamada sem shell, e o app sempre define `--profile` e `--output json`.

Liberados por padrão:

- `jobs get`
- `jobs get-run`
- `jobs get-run-output`
- `jobs list-runs`
- `clusters get`
- `current-user me`, para conferir o login nas Configurações
- `api get`, só nos caminhos da lista: `/api/2.1/jobs/runs/list` e `/driver-proxy-api/`

Cada entrada da lista traz as flags aceitas, como `jobs list-runs --job-id --limit`. Para achar runs, o app usa `api get`, porque ele traz uma página só, e a listagem da CLI pode percorrer todo o histórico.

Sempre recusados, salvo pela opção de ações:

- `jobs run-now` e `jobs cancel-run`, além de qualquer outro comando de escrita.
- `api post`, `api put`, `api patch` e `api delete`.
- Caminhos com `..`, `%2e` ou fora da lista, e flags fora da lista de cada comando.

**Edição da lista:** o usuário pode adicionar comandos. Um comando fora do padrão de leitura exige confirmação no momento em que é adicionado, e cada uso por um agente passa pelo fluxo de aprovação. `jobs run-now`, `jobs cancel-run` e escrita pela API nunca entram pela lista.

**Ações:** vêm desligadas. Ligadas, adicionam as ferramentas `iniciar_job` e `cancelar_job`, que passam pelo fluxo de aprovação existente, sem opção de "sempre permitir", e o botão **Cancelar run** no cartão, em que a pessoa confirma num diálogo.

**Limite conhecido:** as regras valem para o monitor e para as ferramentas. Elas não seguram um agente com shell em **Este computador**, que roda comandos como o usuário. A proteção recomendada é um perfil só de leitura no Databricks e o agente em **Linux isolado** ou sem computador. A tela de Configurações deixa isso explícito.

## Ferramentas do agente

Só aparecem para agentes com **Acompanhar jobs** ligado na aba **Ferramentas**, e essa opção vem desligada.

| Ferramenta | Entrada | Resultado |
|---|---|---|
| `acompanhar_job` | `job_id` ou `run_id` | Cria o acompanhamento e responde na hora, com o cartão. Se já existir para o run, devolve o existente |
| `ver_job` | `run_id`, `task` opcional | Última leitura, ou a saída de uma task. Consultar a saída usa `jobs get-run-output` |
| `parar_acompanhamento` | `run_id` | Encerra o acompanhamento, sem mexer no job |
| `consultar_databricks` | `comando`, `motivo` opcional | Roda um comando da lista de permitidos. É o que torna a edição da lista útil. Comando que não seja de leitura vira pedido de aprovação. O perfil e o formato são sempre definidos pelo app |

A saída de jobs é tratada como dado, nunca como instrução. Ela é limitada em tamanho e passa pela remoção de segredos de `step-text.ts`.

**Prompt:** com a opção ligada, a primeira ação do agente é chamar `acompanhar_job` sempre que falarem de um job ou run, mesmo já terminado, porque é o que mostra o cartão. `databricks jobs` no computador dele é recusado, com a indicação da ferramenta. Com a opção desligada e a CLI na máquina ou o app configurado, ele é instruído a dizer onde ligá-la antes de rodar qualquer comando.

**Skill padrão:** ao ligar a opção num agente, ele recebe a skill `analisar-job-databricks`, criada na primeira vez. Depois ela é uma skill comum: o que a pessoa editar, tirar ou apagar fica assim. O cartão não depende dela.

## Ciclo de um acompanhamento

1. O agente pode passar id, nome exato ou link. Com um job, procurar o run ativo. Sem run ativo, mostrar o último run, já encerrado. Sem nenhum run, responder ao agente e não criar acompanhamento.
2. Havendo mais de um run ativo, acompanhar o mais recente e dizer isso na resposta.
3. Calcular `baselineMs` com até 10 runs bem-sucedidos do mesmo job, usando `--completed-only`.
4. A cada intervalo, ler o run e, com um cluster ativo, as métricas do Spark. Salvar a leitura, emitir `job_watch` e rodar a detecção.
5. Ao chegar a um estado final, processar o evento final e encerrar.

## Eventos

| Evento | Condição | Efeito |
|---|---|---|
| `run_failed` | Estado final `failed` ou `timed_out` | Acorda |
| `task_failed` | Task falhou e não há nova tentativa pendente | Acorda uma vez por task |
| `run_succeeded` | Estado final `succeeded` | Acorda para um resumo curto |
| `possible_stall` | Um dos sinais abaixo | Acorda uma vez por sinal e etapa |
| `run_canceled` | Estado final `canceled` | Só cartão |
| Nova tentativa | Task em `waiting_retry` | Só cartão |
| `high_spill` | Spill igual ou acima do limite configurado (padrão: 10 GB) | Conforme a configuração: só aviso no cartão (padrão) ou acorda uma vez por etapa |

### Sinais de possível travamento

| Sinal | Valor padrão | Fonte |
|---|---|---|
| `no_progress` | `tasksDone` sem mudar por 15 minutos, com tasks ativas | Spark |
| `straggler` | Task ativa acima de 5 vezes a mediana, com pelo menos 10 minutos e 75% da etapa concluída | Spark |
| `slow_run` | Duração acima de 2 vezes `baselineMs`, com pelo menos 3 runs no histórico | Jobs |

O cartão diz "Possível travamento", nunca uma certeza. Se o progresso voltar, o alerta some do cartão sem acordar o agente, e a chave continua em `firedAlerts`, para não disparar de novo. Os valores são iniciais, não foram calibrados com jobs reais e ficam editáveis.

## Quando o agente acorda

- `runJobEvent` usa a mesma fila de `runRoutine`, com `depth: 1`, e responde na thread da mensagem do cartão.
- O contexto traz o evento e o resumo da última leitura. Para mais detalhes, o agente usa `ver_job`.
- O limite padrão é de 3 vezes por run: até 2 alertas e 1 reservada para o evento final. Com o limite configurado em 1, só o evento final acorda.
- No horário de silêncio ou com **Pausar tudo**, as consultas continuam e os eventos ficam em `heldEvents`. Ao liberar, um evento final substitui os alertas pendentes, e cada acompanhamento acorda no máximo uma vez, com o evento marcado como atrasado.
- Sem orçamento de tokens, o cartão segue funcionando e avisa que a análise não pôde rodar.

## Limites configuráveis

| Configuração | Padrão | Mínimo |
|---|---|---|
| Caminho da CLI | Achado sozinho, no PATH e nas pastas comuns de instalação | Não se aplica |
| Endereço da API do Spark | Vazio: descoberto sozinho | Não se aplica |
| Perfil da CLI | Achado sozinho: o do ambiente, senão `DEFAULT`, senão o primeiro com login válido | Não se aplica |
| Intervalo entre consultas | 30 s | 15 s |
| Jobs ao mesmo tempo | 5 | 1 |
| Tempo máximo de acompanhamento | 24 h | 1 h |
| Vezes que o agente acorda por run | 3 | 1 |
| Sem avanço | 15 min | 1 min |
| Múltiplo da task atrasada | 5 | 2 |
| Múltiplo da lentidão | 2 | 1,5 |
| Limite de spill | 10 GB | 1 GB |
| Ao passar do limite de spill | Só aviso no cartão | Não se aplica |

**Ao passar do limite de spill** tem duas opções: **Só aviso no cartão** e **Acordar o agente**. Acordar o agente conta como alerta no limite de vezes por run, então nunca consome a vez reservada ao evento final.

Acima do limite de jobs simultâneos, `acompanhar_job` recusa e explica. O acompanhamento não entra numa fila.

## Cartão

- Cabeçalho: indicador, nome do job, run, duração e estado.
- Métricas: tasks, shuffle, spill e memória.
- Progresso da etapa ativa.
- Lista de tasks, com estado e duração.
- Rodapé: **Abrir no Databricks**, **Parar de acompanhar** e hora da última leitura.

Estados:

- **Rodando:** anel pulsante, igual ao "De olho" das rotinas, respeitando a redução de movimento.
- **Possível travamento:** aviso e indicação de que o agente está investigando, enquanto ele estiver trabalhando.
- **Falhou:** continua aberto, com as métricas lidas antes de o cluster encerrar.
- **Concluído:** encolhe para uma linha, com as métricas a um clique.
- **Sem leitura:** mostra "sem leitura há X minutos", sem mudar o estado do job.
- **Sem acesso:** mostra o comando `databricks auth login --profile <perfil>`.

Métrica sem dado aparece como indisponível, nunca como zero.

## Erros

Falha ao ler nunca é falha do job e nunca acorda o agente.

| Situação | Comportamento |
|---|---|
| CLI não encontrada | Não cria cartão; explica ao agente |
| Login expirado | Estado **Sem acesso**, aviso único e consultas a cada 5 minutos |
| Rede, 5xx ou limite de requisições | Espera crescente, até 5 minutos; volta ao normal na primeira leitura boa |
| Run inexistente ou sem permissão | Encerra com `not_found` |
| JSON inválido ou formato inesperado | Leitura perdida, com registro no log |
| Só a API do Spark falha | `reading.spark` fica sem dados novos; o resto segue |
| Comando recusado pelas regras | Não executa; o motivo aparece no cartão |
| CLI sem resposta | Encerra o processo em 30 s; nunca há duas consultas simultâneas por run |
| Tempo máximo | Encerra com `max_time`; avisa que o job pode continuar rodando |
| Agente ou conversa removidos | Encerra com `agent_removed` |

## Reinício e suspensão

Ao iniciar ou acordar, o app retoma os acompanhamentos com `status: 'watching'` e consulta o estado atual. Um estado final atingido nesse intervalo gera um único evento, marcado como atrasado. As métricas do período ficam faltando, e o cartão deixa isso claro. Durante a suspensão, nenhuma consulta roda.

## Testes

- `test/cli-policy.test.ts`: tabela de permitidos e recusados, incluindo `api post`, caminhos fora da lista, travessia e flags extras.
- `test/job-detect.test.ts`: sequências de leituras para cada evento e sinal, duplicidade, recuperação e as duas opções de spill, com limites diferentes do padrão.
- `test/databricks.test.ts`: respostas de exemplo da CLI, IDs grandes, campos ausentes e os dois formatos de estado.
- `test/job-watches.test.ts`: CLI e relógio simulados, cobrindo evento final reservado, horário de silêncio, retomada, limite simultâneo e recusas de acesso.
- Conferência no app: cartão com dados simulados, nos estados acima, em tema claro e escuro.
- Validação real, feita com o usuário: etapa 0 e um job de verdade no fim.

## Ordem de implementação

1. Etapa 0.
2. `cli-policy` e `databricks`.
3. `job-detect`.
4. Migração e `job-watches`.
5. Ferramentas e `runJobEvent`.
6. Cartão.
7. Configurações e opção por agente.
8. Página de ajuda, com a receita de skill.
9. Testes finais e integração.

## Integração

- O trabalho fica em `feature/job-watch`, no remoto `fork` (`rjgdias/tucano`).
- Ao terminar, a branch é integrada em `major/tucano-next`, no mesmo fork.
- `major/tucano-next` está 223 commits à frente de `origin/main`, e as migrações de `db.ts` dependem da posição. A migração nova precisa ficar depois das que já existem nessa branch, e a integração precisa rodar os testes.
- PR para `eduwxyz/tucano` só com pedido explícito do usuário. Nesse caso, em draft, em inglês e sem esta spec, se o mantenedor não a quiser no repositório.
