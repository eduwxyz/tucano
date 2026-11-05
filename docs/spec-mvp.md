# Tucano — MVP spec

> The original design document, written in Portuguese while the app was still called *Tucano*. Code comments cite its sections as `spec §N`. It records the decisions and their reasons; the README describes the app as it is.

**Status:** rascunho · **Data:** 2026-10-17

## Goal

Um app desktop (Electron), local-first e open source, onde eu converso com um time de agentes de IA em canais e DMs, como num Slack. Os agentes rodam nas **assinaturas que eu já pago** (Claude Code e Codex), sem chave de API e sem cobrança por uso. O diferencial é a **camada de governança**: cada agente só enxerga as ferramentas que recebeu, toda ação sensível vira um pedido de aprovação amarrado à ação exata, todo run tem recibo e o limite de uso é checado **antes** de cada run e durante ele.

Por quê: o OpenMausBot já entrega "agentes num app de mensagens" local, rodando sobre as CLIs. O agentes.chat entrega governança, mas como SaaS fechado e voltado pra times. Este projeto junta os dois: local, aberto, e com autonomia controlada.

Usuário do MVP: eu, numa máquina só. Quem baixar o repositório usa do mesmo jeito, com as próprias assinaturas.

## Conceitos

| Conceito | O que é |
|---|---|
| **Workspace** | O espaço local. Tem um **contexto** (texto livre: quem sou, o que faço, regras) que entra em toda conversa de todo agente. |
| **Motor** | A CLI que executa o agente: **Claude Code** (`claude`) ou **Codex** (`codex`), instalada e logada pelo próprio usuário. |
| **Agente** | Nome, @handle, avatar, instruções, motor + modelo + esforço, limite de uso mensal, canais e grants. |
| **Canal / DM** | Conversa com mensagens. Canal tem agentes membros; DM é eu + um agente. |
| **Run** | Uma execução de um agente em resposta a uma mensagem. Máquina de estados persistida. Um run pode ter vários **turnos** (cada turno é um processo da CLI). |
| **Step** | Um passo visível de um run: turno do modelo, chamada de ferramenta, pergunta, aprovação. |
| **Conector** | Um servidor MCP (remoto por URL ou local por comando stdio). |
| **Gateway** | Servidor MCP local do próprio app. É a **única** porta de ferramentas que a CLI enxerga. |
| **Ferramenta** | Uma tool de um conector, classificada como `read`, `write` ou `sensitive`. |
| **Grant** | Nível de acesso de um agente a um conector: `none`, `read` ou `read_write`. |
| **Aprovação** | Pedido para executar uma chamada `sensitive` específica (ferramenta + argumentos exatos). |
| **Resumo** | O que uma conversa já cobriu e saiu da janela de mensagens: decisões, pendências, estado do trabalho. Um por canal ou DM. |
| **Memória** | Uma nota durável, curta, com origem. **Sobre mim** (vale pra todos os agentes) ou **do agente** (só dele). |
| **Computador** | Um computador Linux isolado (container Docker) de um agente, persistente, onde ele faz qualquer coisa sem pedir. |
| **Artefato** | Um arquivo que o agente mostra no chat (print, documento, página, planilha), guardado como estava na hora. |
| **Rotina** | Um pedido agendado pra um agente (dias + horário), que posta numa conversa e roda sozinho. |
| **Projeto** | Um canal ligado a uma pasta do Mac: todo agente dele recebe os arquivos de contexto e a memória do projeto, e quem tem computador pode receber a pasta. |
| **Recibo** | Registro de cada turno: motor, modelo, tokens (in/out/cache/raciocínio), duração e, quando a CLI informa, o custo equivalente em API. |

## Behaviors

### 1. Chat

- Sidebar com canais, DMs, agentes e **Aprovações** (com badge de pendentes).
- Criar canal, adicionar e remover agentes de um canal, abrir DM com um agente.
- Composer com autocomplete de `@handle`. Mensagens renderizam Markdown (código com highlight).
- A resposta do agente aparece em streaming quando o motor permite (Claude Code: token a token; Codex no MVP: por bloco de mensagem). Acima dela, a lista de steps (ferramenta, resumo dos argumentos, duração, status), colapsável.
- Cada resposta de agente tem um rodapé: `modelo · tokens · duração`. Clicando, abre o recibo por turno.
- Botão **Parar** enquanto um run roda: encerra o processo da CLI.

### 2. Quem responde

- **DM:** o agente sempre responde.
- **Mensagem com @menção:** os mencionados respondem (até 3), sem passar pelo router.
- **Mensagem num canal sem menção:** o **router** decide. Ele recebe as últimas ~10 mensagens e a lista de agentes do canal (handle + uma linha de papel) e devolve, em saída estruturada, 0 a 2 handles e um motivo curto.
- O router só decide quem fala. Ele **não** concede permissão nem altera grants.
- O router roda num motor e modelo pequenos, configuráveis (default: Claude Code + Haiku, com `--json-schema`). Gera recibo próprio, atribuído ao workspace.
- **Jev (opcional):** em Configurações, o router pode ser o Jev, o modelo de decisão da TypeSafe, com a chave do usuário. A pergunta vai como uma escolha tipada entre os handles do canal e "ninguém" (com o mesmo texto que o Haiku lê como estado); um segundo agente é chamado quando ganha pelo menos 30%. Decide em menos de 1 s, contra ~17 s medidos com o Haiku. É a única exceção a "sem chave de API": cada decisão manda as últimas 10 mensagens do canal pra TypeSafe e é cobrada lá, e a tela diz isso. A chave é conferida em `/v1/models` antes de ser guardada, fica cifrada no cofre do sistema e o renderer só sabe se ela existe. Se o Jev falhar (sem chave, recusada, limite, fora do ar), o Haiku decide e a mensagem do router diz por quê.
- Mensagens de agente **nunca** passam pelo router. Um agente pode @mencionar outro, o que dispara um run dele. A profundidade da cadeia é limitada a 3 por mensagem humana original.

### 3. Run

- Estados: `queued → running → (waiting_approval | waiting_input) → running → completed | failed | cancelled | limit_reached | interrupted`.
- O estado do run, os steps e a chamada de ferramenta pendente ficam no SQLite. Um run esperando aprovação ou resposta sobrevive a fechar o app.
- **Sem processo pendurado:** quando o run precisa esperar (aprovação ou `ask_user`), o turno da CLI termina. Depois da decisão, o app abre um turno novo com o resultado no contexto. Assim nada depende de um processo vivo por horas.
- Ao reabrir o app, runs que estavam em `running` viram `interrupted`, com um botão **Retomar** (abre um turno novo a partir do último step completo).
- **Contexto de cada turno** (o app monta; no Claude Code, a sessão é guardada por agente, conversa e thread, e as respostas seguintes mandam só o que é novo; veja *Sessão guardada* abaixo):
  1. Contexto do workspace
  2. Instruções do agente
  3. Últimas N mensagens da conversa (default 30), com o autor de cada uma
  4. Steps já concluídos do run (resultados de ferramenta, aprovações, respostas)

  Os itens 1 e 2 vão como system prompt. As ferramentas vêm do gateway.
- **Travas por resposta** (M10), no lugar dos limites de 50 chamadas e 15 min do M7, que cortavam trabalho longo que ia bem (duas respostas do Staff morreram nos 15 min instalando o Swift, ~1 M de tokens cada, sem resultado). Nenhuma corta pelo tempo ou pelo número de ferramentas:
  - **Loop:** a mesma chamada (ferramenta + argumentos) com o mesmo resultado. Na 3ª vez o resultado volta com um aviso pra mudar de abordagem; na 5ª, a resposta para. Rodar o mesmo teste depois de editar o código dá outro resultado e não conta. A mesma busca na web 5 vezes também para. **8 ferramentas falhando seguidas** param.
  - **Travado:** 20 min sem nenhum sinal (texto, tokens, ferramenta terminando). Uma ferramenta rodando tem o próprio tempo máximo e não conta como silêncio.
  - **Teto de gasto:** por resposta, 10% do limite do mês do agente. Ao passar, as próximas ferramentas são recusadas com "escreva o que fez e o que falta e encerre"; a resposta fica **pausada**, com **Continuar**, que abre uma resposta nova com os passos feitos na tarefa. Se ela seguir gastando até 30% acima do teto, é cortada (e fica pausada do mesmo jeito). No Codex o uso só chega no fim, então o teto não pausa no meio.
  - O teto (%) e o tempo de travado ficam em Configurações.
- **Contagem justa:** no limite do mês, no teto e nos recibos, um token lido do cache conta 10% (é o que ele custa). O recibo mostra entrada, cache e saída separados, também numa resposta cortada.
- **Cache da conversa:** a conversa vai pro Claude Code como blocos de texto, um por mensagem (`--input-format stream-json`), sem nada no fim que mude a cada resposta (a hora vai no cabeçalho de cada mensagem, com o dia da semana; "responda à última" foi pro system prompt). A próxima resposta começa com os mesmos blocos e lê a conversa do cache (medido: 92% da entrada, contra só o system prompt antes). O cache da assinatura dura 1 h. A janela só muda de começo quando a memória consolida, a cada ~20 mensagens.
- No máximo 4 runs simultâneos. O resto fica em `queued`.

### 4. Ferramentas embutidas (MVP)

- `ask_user`: faz uma pergunta curta. O run fica em `waiting_input` até eu responder na conversa.

Expostas pelo gateway, como qualquer outra. Todas as demais vêm de conectores MCP.

### 5. Motores

- **Claude Code:** `claude -p --output-format stream-json --verbose --include-partial-messages`, com `--model`, `--system-prompt`, `--tools ""` (nenhuma ferramenta embutida: sem shell, sem arquivos), `--strict-mcp-config --mcp-config <gateway>`, `--setting-sources ""` (ignora hooks, plugins e configurações do usuário) e `--no-session-persistence` (fora as respostas de agente, que guardam sessão). Não usar `--bare`, que desliga o login por assinatura.
- **Sessão guardada (Claude Code):** a primeira resposta de um agente numa conversa ou thread começa uma sessão (`--session-id`) com a conversa inteira; as próximas a retomam (`--resume`) mandando só as mensagens novas desde a última resposta dele e a tarefa. O processo fica aberto 5 min depois de uma resposta (no máximo 2 esperando, ~140 MB cada), e a próxima é escrita nele; depois disso, a próxima abre outro processo e retoma do disco. O token do gateway fica o mesmo enquanto a sessão vive (entre respostas, as chamadas são recusadas). Começa outra sessão quando: o system prompt ou as ferramentas mudam (o `--resume` mantém o primeiro system prompt), uma mensagem que ela viu foi editada ou apagada, aparece uma mensagem no meio, a última resposta não terminou bem (parada, travada, limite, reserva), em "Tentar de novo", passou de ~60k tokens de contexto ou de 55 min parada (o cache dura 1 h), ou o app reabriu. Enquanto outro agente ainda escreve uma mensagem que ela veria pela metade, a resposta vai sem sessão. Os arquivos das sessões largadas são apagados.
- **Codex:** `codex exec --json --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check -s read-only -C <diretório vazio do run>`, com `-m`, `-c model_reasoning_effort=…`, skills e docs de projeto desligados, busca na web só com a Web ligada (§16), `--disable` em cada recurso embutido (shell, exec, plugins, apps, navegador, computer use, multiagente, imagens, memórias, hooks) e o gateway como único servidor MCP via `-c mcp_servers…` com `default_tools_approval_mode="approve"` (quem decide é o gateway).
- **O Codex roda com um home próprio do app** (`HOME` e `CODEX_HOME` numa pasta do Tucano). Medido com `codex debug prompt-input`: com o home do usuário, mesmo com `--ignore-user-config`, ele carrega o `~/.codex/AGENTS.md` e as skills do usuário, e num teste real usou o shell pra rodar uma ferramenta pessoal. Por isso o usuário faz um login próprio do Codex pro Tucano, pelo fluxo do próprio Codex, uma vez.
- O app **nunca** toca em credenciais: não lê, não guarda, não repassa token. O login acontece no fluxo da própria CLI (`claude auth login` / `codex login`), que o app abre num Terminal.
- Configurações mostra, por motor: instalado (caminho e versão), logado (`claude auth status`, `codex login status`) e o tipo de login. Se a CLI estiver logada com chave de API em vez de assinatura, o app avisa.
- Cada motor fica atrás de uma interface própria `Engine` (`run(turno) → stream de EngineEvent`), com uma implementação fake pros testes.
- Medido nesta máquina (Claude Code 2.1.286, Codex 0.153.4): resposta curta em ~5 s no Claude Code com Haiku e ~4 s no Codex com Luna, já isolado da configuração do usuário (sem isolar, o Codex levou 12 s carregando MCPs e plugins).

### 6. Conectores e classificação

- Adicionar conector de dois jeitos:
  - **Remoto:** URL https do servidor MCP, com OAuth (redirect pra localhost) ou token.
  - **Local (stdio):** comando + argumentos + variáveis de ambiente. Mostra um aviso de que vai rodar um processo na minha máquina.
- Quem conecta nos servidores MCP é o **app**, não a CLI. A CLI só vê o gateway.
- Ao conectar, o app lista as ferramentas e classifica cada uma:
  1. `annotations.readOnlyHint = true` → `read`
  2. `annotations.destructiveHint = true` → `sensitive`
  3. Senão, pelo nome: `get/list/search/read/find/fetch` → `read`; `delete/remove/merge/deploy/send/publish/transfer/pay` → `sensitive`
  4. Senão → `write`
- Uma tela de revisão mostra a classificação. Eu posso mudar a classe de qualquer ferramenta, desligá-la, ou marcá-la como **alto risco** (exige segurar o botão pra aprovar).
- Uma ferramenta nova que aparece depois (`tools/list_changed`) entra **desligada** até eu revisar.
- Credenciais dos conectores (tokens OAuth e chaves) ficam cifradas com `safeStorage`. Se a autenticação falhar, o conector fica como "precisa reconectar" e a chamada devolve um erro claro pro agente.

### 7. Gateway e grants (escopo por agente)

- O gateway é um servidor MCP Streamable HTTP em `127.0.0.1`, porta aleatória. Cada turno recebe uma URL com um **token de uso único** que identifica agente + run. Sem token válido, nada responde.
- Na página do agente, um nível por conector: `none`, `read` ou `read_write`.
  - `read` expõe só ferramentas `read`.
  - `read_write` expõe `read`, `write` e `sensitive`. As `sensitive` sempre passam por aprovação.
- O `tools/list` do gateway devolve **só** o que o grant do agente permite. O que está fora do grant não existe pro modelo.
- **Defesa em profundidade:** o gateway confere o grant de novo em cada `tools/call`. Uma chamada a ferramenta não permitida é rejeitada e vira step de erro, nunca executa.
- Agente novo nasce sem nenhum grant.

### 8. Aprovações

- Quando o agente chama uma ferramenta `sensitive`, o gateway **não executa**: grava o pedido, responde ao modelo "pedido de aprovação criado, aguarde a decisão" e o app encerra o turno. O run vai pra `waiting_approval` e aparecem:
  - um card inline na conversa (ferramenta, argumentos formatados, motivo dado pelo agente);
  - uma entrada em **Aprovações**;
  - uma notificação do sistema.
- A aprovação é amarrada a `hash(conector, ferramenta, argumentos canônicos)`. Ao aprovar, **o app** executa exatamente aquela chamada guardada e abre um turno novo com o resultado. Uma chamada diferente gera outro pedido.
- **Recusar:** pede um motivo opcional. O turno novo recebe `Recusado por <eu>: <motivo>` e o agente pode propor outro caminho.
- Ferramenta de alto risco: aprovar exige segurar o botão por 1,5 s.
- Expiração: 24 h (configurável). Ao expirar, o turno novo recebe "expirado" e o agente avisa na conversa.
- Cada aprovação fica no histórico com decisão, horário e motivo.

### 9. Limites de uso e recibos

- Não há cobrança por chamada: o custo real é a cota do meu plano. Por isso o limite é em **tokens**, que os dois motores informam.
- Cada agente tem um limite mensal de tokens (default do workspace: 2 milhões). O mês segue o calendário local.
- **Antes** de cada turno, o app confere o saldo. Se acabou, o turno não abre: o run vira `limit_reached` e o agente posta que parou pelo limite.
- **Durante** o turno, o app soma o uso que chega no stream (Claude Code informa por mensagem; Codex, no fim do turno). Se passar do saldo, encerra o processo.
- Alerta (notificação + mensagem no app) quando o uso passa de 80%.
- Depois de cada turno, grava o recibo com os tokens reais (incluindo cache e raciocínio) e, no Claude Code, o custo equivalente em API (`total_cost_usd`), só como referência.
- Uma tela de **Uso** mostra o uso do mês por agente (barra contra o limite), os avisos de limite do plano e a lista de runs.

### 10. Agentes

- Criar e editar: nome, @handle (2–32 caracteres `[a-z0-9_-]`, único), cor, instruções, motor, modelo, esforço, limite de uso, canais, grants.
- Modelos por motor: Claude Code (`opus`, `sonnet`, `haiku`) e Codex (`gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol`). A lista vem de um JSON local editável.
- Arquivar: o agente sai dos canais e da lista. Histórico e recibos ficam.

### 11. Configurações

- **Motores:** status de cada CLI (instalada, versão, logada), botão **Entrar** que abre o login da própria CLI num Terminal, e caminho customizado do binário.
- Contexto do workspace, motor e modelo do router, limites de run, expiração de aprovação, limite de uso default.

### 12. Memória (M4)

Hoje cada turno vê só as últimas 30 mensagens da conversa e nada de outras conversas. O M4 dá dois níveis de memória, sempre visíveis e editáveis, e um jeito de esquecer que não volta sozinho.

Referências: o modelo do **Honcho** (participantes e conversas, resumos por sessão, conclusões que atravessam sessões), a decisão adicionar/atualizar/nada do **Mem0**, os memory blocks do **Letta**. Nenhum entra como dependência: todos pedem Python, banco à parte ou LLM por API. Fica tudo no SQLite, com a CLI do usuário fazendo o trabalho de modelo.

**Curto prazo: resumo da conversa**

- Cada canal e DM tem um resumo. O turno recebe o resumo **mais todas as mensagens depois dele**, inteiras.
- Quando passam de 50 mensagens depois do resumo, as mais antigas (todas menos as últimas 30) são **consolidadas**: um modelo pequeno (default Haiku) recebe o resumo anterior + essas mensagens e devolve o resumo novo, de até ~500 palavras. É recursivo: o resumo pende pro recente, sem perder o começo.
- O resumo aparece no topo da conversa (**Resumo**). Dá pra corrigir à mão e pedir **Resumir agora**.
- Recibo próprio, atribuído a "Memória" na tela de Uso.

**Longo prazo: memórias**

- Dois escopos: **sobre mim** (entra no prompt de todo agente) e **do agente** (só no dele). Até 40 por escopo no prompt, as confirmadas mais recentemente primeiro. Busca semântica só quando isso não couber mais.
- Cada memória guarda origem: quem criou (agente, extração ou eu), conversa e mensagens de onde veio.
- **Como entram:**
  1. **O agente guarda** com a ferramenta `lembrar` (texto, sobre mim ou dele, e opcionalmente qual memória substitui). Por agente, um modo: **grava sozinho** (default; aparece "Guardou: …" na mensagem, com Desfazer), **pede aprovação** (fica "Quer guardar: …" com Guardar/Descartar) ou **só lê**.
  2. **A consolidação extrai** do mesmo trecho que vai pro resumo: o modelo recebe as memórias sobre mim que existem e devolve, por item, *adicionar*, *atualizar a memória X* ou *confirmar a memória X*. Só vira fato sobre mim o que **eu** disse: uma extração sem evidência numa mensagem minha é descartada. Default: **viram sugestões** que eu aceito ou descarto; dá pra trocar pra gravar sozinho ou desligar.
  3. **Eu escrevo** uma memória direto na tela de Memória.
- **Atualizar não apaga:** a versão nova entra e a velha fica arquivada, com a linha do tempo visível.

**Esquecer**

- **Esquecer** (por mim, ou o Desfazer do chat) tira a memória do prompt na hora e guarda um registro do que foi esquecido. A extração recebe esses registros como "não reaprender", e o app descarta qualquer memória nova igual a uma esquecida. Isso evita o problema do Honcho, em que uma conclusão apagada volta porque as mensagens de origem continuam lá.
- **Apagar de vez** remove até o registro (aí pode ser aprendida de novo).
- **Envelhecer sem sumir:** memória sem confirmação há 60 dias vai pra **Revisar** ("ainda vale?"). Nada some sozinho. A consolidação confirma uma memória quando a conversa reforça ela.

**Tela de Memória** (sidebar): Sugestões (com badge), Revisar, Sobre mim, uma seção por agente, Esquecidas. Cada item mostra texto, origem, data e ações (editar, esquecer, histórico).

### 13. Computador do agente (M5)

Cada agente pode ganhar um computador próprio: um Linux isolado dentro do Mac, onde ele instala, cria, roda e testa o que precisar sem pedir permissão. O Mac do usuário fica de fora.

- **O que é:** um container Docker por agente, criado pelo app e persistente (o que ele instala e cria continua lá). Imagem base `node:22-bookworm` (Node, npm, Python 3, git, curl, compiladores); o agente é root lá dentro e instala o resto (apt, pip, npm). Limite de 3 GB de RAM e 2 CPUs.
- **O cérebro fica fora:** a CLI continua rodando no Mac, com a assinatura. O computador só recebe comandos pelo gateway. Nenhuma credencial entra nele.
- **A pasta `/work`** fica numa pasta do app no Mac, então o app lê os arquivos direto e o usuário pode abrir no Finder.
- Liga por agente, na página dele (**Computador**: desligado / ligado). Default: desligado. Precisa do Docker Desktop rodando; sem ele, o agente avisa e a página mostra o que fazer.
- **Ferramentas** (pelo gateway, só pra agente com computador ligado):
  - `bash`: roda um comando em `/work`, com tempo máximo (default 2 min, até 10). A saída volta cortada no meio se for longa.
  - `read_file`, `write_file`, `edit_file`: ler, criar e trocar trechos de arquivos.
  - `start_service` / `stop_service`: deixa um processo rodando em segundo plano (servidor web, API, dashboard), com log em `/work/.logs`. As portas do computador (3000, 3001, 4173, 5000, 5173, 8000, 8080, 8501, 8888) ficam acessíveis só em `127.0.0.1` do Mac.
  - `screenshot`: abre uma URL num navegador escondido (o Chromium do próprio Electron) e devolve a imagem pro modelo e pro chat. `localhost:<porta>` aponta pro computador do agente.
  - `show_file`: mostra um arquivo no chat (imagem, Markdown, HTML, PDF, CSV ou texto).
- **Governança:** dentro do computador nada pede aprovação. O que sai dele (push, e-mail, deploy por conector) continua nas regras de conectores e aprovações. Cada comando aparece como step.
- **Na interface:**
  - prints e arquivos mostrados aparecem na mensagem e abrem num **painel lateral** (HTML num iframe isolado, sem acesso ao app);
  - serviço iniciado vira um card com **Abrir**, que mostra o app rodando no painel;
  - página do agente: estado do computador, serviços (abrir, parar), **Abrir pasta**, **Reiniciar** e **Apagar computador** (some tudo, inclusive `/work`).
- **Pastas emprestadas (M5.1):** na página do agente, **Emprestar pasta…** abre o seletor do Mac; a pasta aparece no computador dele em `/projetos/<nome>`, com **Pode mudar** ou **Só ler**, e **Devolver**.
  - Só pastas dentro da pasta do usuário: nunca a própria, `~/Library`, pastas ocultas (`~/.ssh`, `~/.config`) nem os dados do app. O core confere (seguindo symlinks); o renderer não grava pasta direto.
  - O Docker só monta pasta ao criar o container. Emprestar ou devolver salva o estado do computador numa imagem (`docker commit`) e recria a partir dela: o que ele instalou fica, os serviços param.
  - `node_modules` (sempre) e `.venv` (quando existe) de cada pasta com escrita ganham um volume próprio do Linux, então um `npm install` dele não troca os binários do Mac.
  - O prompt diz quais pastas são dele, que são os arquivos de verdade, pra olhar o `git status` antes, mexer só no pedido e conferir com os testes. Sem credenciais, push e deploy ficam comigo.

### 14. Rotinas (M6)

Até aqui tudo começa com uma mensagem minha. Uma rotina faz o agente trabalhar sozinho, num horário: eu agendo uma vez e o resultado aparece na conversa, como qualquer outra resposta.

- **O que é:** nome, agente, onde postar (a DM com ele ou um canal de que ele participa), o que fazer (texto livre, como eu escreveria numa mensagem), dias da semana e horário. Ligada ou desligada.
- **Quando roda:** no horário local do Mac. Um agendador no core confere a cada 30 s se alguma rotina venceu, então funciona também depois do Mac acordar.
- **Rodou perdida:** se o app estava fechado ou o Mac dormindo no horário, a rotina roda **uma vez** quando o app volta, desde que tenha vencido há menos de 12 h, e aparece como atrasada. Mais velha que isso, pula pra próxima. Nunca acumula várias execuções.
- **Na conversa:** entra uma mensagem da rotina (ícone de relógio, nome e o pedido) e o agente responde em seguida, com tudo que uma resposta tem: ferramentas, computador, prints, memória, @menção de outro agente. O agente sabe que é uma rotina agendada, e que eu posso não estar olhando agora.
- **Governança igual:** mesmo limite de tokens (checado antes), mesmos grants, e ação sensível vira pedido de aprovação, que espera até eu decidir. Se a mesma rotina ainda está rodando, a próxima execução pula.
- **Aviso:** quando termina, uma notificação do sistema com o agente, o nome da rotina e o começo da resposta (ou "pediu aprovação", "parou no limite", "falhou"). Clicar abre o app.
- **Mac dormindo:** dormindo, o Mac acorda alguns segundos de tempos em tempos pra manutenção (DarkWake). Uma rotina disparada aí congelava no meio e falhava ao acordar (aconteceu: disparou às 17:03, o Mac voltou a dormir, e às 17:40 ela "passou de 15 minutos"). Agora as rotinas esperam o Mac acordar de verdade (aviso de sono e despertar do sistema) e rodam aí, como atrasadas. Enquanto alguma resposta roda, o app impede o Mac de dormir sozinho (fechar a tampa ainda faz dormir), e a trava de travado não conta como silêncio o tempo em que o Mac dormiu.
- **Rodar agora**, pra testar, sem mexer no horário.
- **Uma vez:** em vez de repetir, roda no próximo horário que bate com os dias e se desliga sozinha.
- **O agente agenda:** com a ferramenta `agendar_rotina`, quando eu peço algo pra depois ("daqui a 2 minutos", "toda segunda às 9h"), o agente cria a rotina pra ele mesmo, nesta conversa. Na mensagem aparece "Agendou: …" com **Desfazer**. Ele só mexe nas próprias rotinas (`cancelar_rotina`, ou `agendar_rotina` com `substitui`), vê as que tem no prompt, e pode ter no máximo 10 ligadas. A hora atual vai no fim de cada transcrição, pra ele calcular "daqui a X".
- **Tela de Rotinas** (sidebar): cada rotina com agente, quando roda, onde posta, próxima execução e a última (status e link pra conversa). Criar, editar, ligar/desligar, rodar agora, apagar.
- **Pra rodar sem eu lembrar:** fechar a janela não para as rotinas (o app continua aberto no Dock; só Sair para). Em Configurações, **Abrir ao ligar o Mac** (só no app empacotado).
- Depois: gatilhos por evento (issue no Linear, e-mail, CI quebrado), intervalos ("a cada 2 h") e ícone na barra de menu.

### 15. Projetos (M8)

Um time trabalhando num projeto precisa do mesmo contexto, e sem eu colar nada. Um canal vira um projeto quando eu ligo uma pasta do Mac a ele (botão **Projeto** no topo do canal).

- **Contexto montado:** em toda resposta de qualquer agente do canal, o app lê na hora os arquivos de contexto do projeto (default: os que existirem entre `CLAUDE.md`, `AGENTS.md` e `README.md`; dá pra trocar a lista) e põe no system prompt, com um texto livre "O momento" (objetivo atual, prioridades, prazos). O repositório continua sendo a fonte: mudou o `CLAUDE.md`, a próxima resposta já vê. Até 20 mil caracteres por arquivo e 50 mil no total.
- **Nunca fora da pasta:** cada arquivo é resolvido com `realpath` e só é lido se continuar dentro da pasta. Um symlink no repositório (que um agente com escrita poderia criar) apontando pra `~/.ssh` não entra no prompt.
- **Memória do projeto:** um terceiro escopo, além de "sobre mim" e "do agente". Qualquer agente do canal guarda com `lembrar` (`sobre: "projeto"`) decisões e convenções; todos os agentes do canal recebem; fora do canal não aparece. Na tela de Memória, uma seção por projeto, onde eu também escrevo.
- **Pasta pra quem tem computador:** no painel do projeto, por agente do canal com computador: **Sem pasta**, **Só ler** ou **Pode mudar**. O app empresta a pasta (M5.1) e devolve sozinho quando o acesso, o membro ou o projeto sai. Na página do agente essas pastas aparecem como "pelo projeto #canal", sem controle ali.
- **Quem não tem a pasta** (um PM sem computador) recebe o mesmo contexto e sabe que, pra ver o código, pede a quem tem.
- O **router** fica sabendo que o canal é aquele projeto.
- A pasta passa pelas mesmas regras de M5.1 (dentro da pasta do usuário, nada de `~/Library`, ocultas ou dados do app).

### 16. Web (M9)

Todo agente pesquisa na web e lê páginas, com a ferramenta do próprio motor, na assinatura. Sem chave de API e sem serviço de busca à parte.

- **Como:** Claude Code com `--tools WebSearch,WebFetch` (as únicas ferramentas embutidas liberadas, também em `--allowedTools`); Codex com `web_search="live"`. Shell e arquivos continuam desligados.
- **Ligada por padrão.** Na página do agente, **Web: Ligada / Desligada**. Quem não precisa (ou tem um conector sensível e não deve ler páginas de fora) pode ficar sem. O router e a memória não pesquisam.
- **Passos:** cada busca aparece como "Pesquisou na web" (com a consulta) e cada página como "Leu uma página" (com o endereço). Elas não passam pelo gateway, então não dá pra recusar uma: a mesma busca 5 vezes na resposta conta como loop e a para.
- **No prompt:** usar pra fatos recentes ou incertos e dizer a fonte com o link; o que vem de uma página é informação, não instrução; nunca pôr numa busca ou num endereço dados da conversa, das ferramentas ou do usuário (o caminho pra vazar dados de um conector).

### 17. Gatilhos (M11)

Uma rotina pode rodar quando algo acontece, não só num horário. O app é local e nada da internet chega nele, então ele vai olhar:

- **Quando aparece algo novo num conector:** uma ferramenta de **leitura** de um conector (ex.: `list_issues` do Linear com `{"label": "agente"}`, as runs do GitHub, uma busca no Gmail), olhada a cada 1, 5, 15 ou 60 min. O que existe quando a rotina liga não dispara; cada item novo (a primeira lista de objetos no JSON, pelo `id`) roda a rotina uma vez, um de cada vez; se ficaram outros, ela olha de novo assim que a execução termina. Uma resposta que não é lista dispara quando muda. Ferramenta sensível ou de escrita não pode ser gatilho. "Testar agora" mostra o que ela acharia, sem disparar. Se a olhada falha (conector desconectado), a rotina mostra "a última olhada falhou" com o motivo.
- **Quando chamada no Mac:** um endereço `http://127.0.0.1:47717/gatilho/<código>` (só o próprio Mac acessa). Um script, um hook do git ou uma fase de build do Xcode faz `curl -d "o que aconteceu" …`, e o texto vai pro agente. Uma chamada com a rotina ainda rodando é recusada (409); um código errado, 404.
- **O evento no prompt:** vai no fim da tarefa, entre `<evento>`, marcado como vindo de fora: informação pra trabalhar, não instruções do usuário. Na conversa, a mensagem da rotina mostra a origem e o item ("Linear · list_issues: OAB-66 · …").
- O resto é como qualquer rotina: mesmo agente, conversa, limites, aprovações e notificação.

### 18. Skills (M11)

Receitas que os agentes seguem pra um tipo de tarefa ("como rodar os testes do Core").

- **O que é:** nome, quando usar (uma frase), receita (Markdown) e pra quais agentes (todos, por padrão).
- **No prompt:** a lista (nome e quando usar) das skills do agente; a receita é lida com `ler_skill` quando a tarefa bate (estável entre respostas, então fica no cache).
- **O agente propõe:** `propor_skill` cria uma skill nova ou uma mudança numa dele, que **espera aprovação** na tela de Skills, com o diff. A skill nova vale só pro agente que propôs, até eu liberar pra outros. No máximo 5 propostas esperando por agente. O prompt pede pra propor quando resolver algo em vários passos, sair de um beco sem saída ou ser corrigido; a ferramenta pede a receita inteira, mantendo o que continua valendo.
- **Histórico:** cada mudança (minha ou aprovada) guarda a versão de antes; "Voltar a esta" restaura e guarda a atual, então desfazer também se desfaz.
- **Tela de Skills** (sidebar, com badge de propostas): propostas com diff (Aprovar/Recusar), em uso (ver receita, histórico, editar, arquivar), arquivadas.
- Testado com o Claude Code real: leu a skill antes de rodar os testes e usou os comandos dela; corrigido, propôs a mudança mantendo os passos e só acrescentando o novo.

### 19. Celular pelo Telegram (M11)

- Um bot do próprio usuário (criado no @BotFather): o token vai em Configurações, conferido com o Telegram e guardado no cofre do Mac. O app busca as mensagens do bot (long polling), então nada precisa chegar no Mac.
- **Pareamento:** o app mostra um código; só o chat que mandar `/start <código>` fica com o bot. Mensagens e toques de outros chats são ignorados.
- **O que chega:** cada aprovação, com Aprovar/Recusar (alto risco pede um segundo toque); cada pergunta de agente (`ask_user`), que eu respondo respondendo à mensagem, e a resposta entra na conversa como se eu tivesse escrito; o fim das rotinas e os avisos de limite.
- O Telegram recebe o texto das aprovações e perguntas (ferramenta, argumentos, motivo) e as respostas das rotinas, e a tela diz isso. Desligado até eu colar um token.

### 20. Boletim e custo por tarefa (M12)

- **Boletim** (sidebar): por agente, nas últimas 6 semanas, quantas respostas terminaram bem (respondeu, perguntou ou pediu aprovação), falharam, foram cortadas por uma trava (loop, erros seguidos, travado) ou pausaram no teto; custo e tempo médios; aprovações recusadas sobre pedidas; e uma barra por semana. Por skill: das respostas que a leram, quantas terminaram bem, e o antes e depois da última mudança. Calculado na hora a partir dos recibos, respostas e aprovações; nada novo é guardado.
- **Custo por tarefa:** uma resposta conta pra uma issue (`OAB-65`) quando a mensagem que ela responde a cita, quando veio de um gatilho com esse item, ou quando foi chamada por outra resposta, um Continuar ou uma aprovação dela. O recibo guarda a issue; o boletim soma por issue, com os agentes que trabalharam nela. A PR aberta pelo app traz o custo da issue até ali.

### 21. Governança no dia a dia (M12)

- **Sempre permitir:** no cartão de aprovação, "Aprovar e sempre permitir" faz daquela ferramenta uma regra do agente: daí em diante ela roda como escrita, com o passo "Executou (sempre permitido)". Nunca vale pra uma de alto risco, pro pedido de acesso ou pra PR. As regras aparecem na página do agente, com um x pra voltar a pedir.
- **Pedido de acesso:** `pedir_acesso` (conector, ler ou ler e escrever, motivo) vira um pedido de aprovação; aprovado, o grant muda e o agente continua numa nova resposta com as ferramentas novas.
- **Pausar tudo:** um botão no topo da barra lateral; pausado, nenhuma resposta começa (a mensagem ganha um aviso), nenhuma rotina roda e agentes não chamam outros. Ao retomar, as rotinas perdidas rodam como atrasadas (até 12 h).
- **Horário de silêncio:** rotinas e gatilhos esperam e rodam quando ele acaba; mensagens minhas continuam sendo respondidas.
- **Cota da assinatura:** o Claude Code informa as janelas de 5 h e da semana (`rate_limit_event`); Uso e limites mostra as duas, com quando voltam a zero. O Codex não informa.
- **Time num arquivo:** "Exportar time" gera um `.md` legível (cada agente com as instruções, skills, canais, rotinas, conectores por nome e endereço, o contexto do workspace) com um bloco JSON que o app importa; sem credenciais, memórias ou conversas, nem o que é de cada um (foto, conta, limite do mês, pastas emprestadas, apps, rotina ligada ou não). O arquivo leva o id do time e um id por item, e o app guarda o último arquivo de cada time que passou por ele (a base). Importar mostra o que entra, item a item, e não muda nada até aplicar: o que já existe aqui com o mesmo @ ou nome vira o mesmo item. Importar de novo um arquivo do mesmo time (de quem o fez ou de quem o passou adiante) compara campo a campo, base × daqui × arquivo: só o time mudou, a mudança é oferecida com diff; só eu mudei, fica o meu ("diferente aqui"); os dois, conflito, que espera eu escolher um lado. Item novo: "Adicionar" ou "Não quero" (não volta a aparecer); item que saiu do time é oferecido pra tirar (agente e skill arquivados), nunca some calado. Rotinas entram desligadas, conectores esperando o login de cada um, e o computador dos agentes, desligado. Exportar não move a base, então dois arquivos feitos da mesma versão se juntam campo a campo. Um arquivo mais antigo que o último visto é avisado. O `.md` de antes dos ids continua sendo lido.
- **Backup:** uma cópia do banco por dia (`VACUUM INTO`), as últimas 7, em `backups/` na pasta do app, e "Fazer backup agora".

### 22. Da issue à PR (M12)

O computador dos agentes não tem credenciais. Pra publicar:

- **Proxy de git no app** (`127.0.0.1:47718`, alcançado pelo container em `host.docker.internal`). O git de cada computador manda `https://github.com/`, `git@github.com:` e `ssh://git@github.com/` pra `…/git/<código do agente>/` (`url.insteadOf`); o código é um HMAC do id do agente com uma chave só do app.
- O proxy põe o token (um fine-grained do usuário, guardado no cofre) na saída e só deixa passar o repositório de um projeto do agente: ler pra quem tem a pasta; push só pra quem pode mudá-la, e **só em `refs/heads/agent/*`**. Um push com outra branch é recusado inteiro, no formato do git (`! [remote rejected] main -> main (Tucano aceita so branches agent/<assunto>)`). O repositório vem do `origin` da pasta do projeto, lido como texto (worktrees incluídos); git nunca roda no Mac numa pasta em que um agente escreve.
- Cada push aceito vira uma linha no canal do projeto ("**Staff** publicou `agent/x` no GitHub").
- **`abrir_pr`** (branch agent/*, título, descrição, base): um pedido de aprovação; aprovado, o app abre a PR pela API, com o custo da issue no rodapé, e o agente recebe o link.
- Testado com git de verdade dentro do computador de um agente, contra um servidor git local no lugar do GitHub: clone e push em `agent/teste` passaram com o token posto pelo proxy; push na main foi recusado com a mensagem acima e a main ficou intacta.

### 23. Computador no Mac (M13)

Cada agente tem um de três computadores, escolhido na página dele: **nenhum** (só conversa, web e conectores), **Linux isolado** (o container do §13) ou **este Mac**. É uma escolha consciente do usuário, por agente: no Mac, o agente roda comandos como o usuário, com tudo o que está instalado (Homebrew, Python, mlx-whisper, `say`, Chrome), e alcança tudo o que o usuário alcança. Serve pra trabalho que depende do Mac (o motor de vídeos usa a GPU da Apple pra transcrever e renderiza 3x mais rápido que no container).

- **As mesmas ferramentas** (bash, ler/escrever/editar arquivo, serviço, print, mostrar arquivo), descritas pro macOS. Cada chamada é um passo no chat; as travas de loop, travado e teto valem igual.
- **Onde os comandos começam:** a pasta do projeto do canal, se o agente tem acesso a ela; senão, a pasta dele nos dados do app. Caminhos aceitam `~`. Só leitura num projeto vira instrução (não há como impedir no Mac).
- **Ambiente:** o do shell de login do usuário, montado a partir de um ambiente limpo (o PATH do perfil, sem nenhuma variável do processo do app). As chaves do app (GitHub, Jev, Telegram, conectores) nunca vão junto.
- **Serviços** em qualquer porta acima de 1024 livre no Mac (menos as do app), com o grupo de processos parado junto.
- **Confirmação ao ligar**, dizendo o que o agente passa a alcançar; selo "no seu Mac" na barra lateral e em cada mensagem dele; o prompt pede que mexa só no que a tarefa pede, não toque em credenciais nem em outros projetos, não instale nada no sistema sem dizer e só faça push, deploy ou publicação quando o usuário pedir.
- Trocar pra Linux ou nenhum para os serviços dele no Mac; trocar do Linux pro Mac para o container.

### 24. Navegador (M14)

Um agente com o navegador ligado mexe em páginas como uma pessoa: abre, clica, escreve, aperta teclas, rola, volta, lê e olha a tela. Serve pro que a web do motor (§16) não alcança: área logada (YouTube Studio, TikTok Studio), páginas que bloqueiam leitura automática com captcha, formulários e buscas com calendário.

- **Um Chrome por agente.** Quando o Mac tem o Google Chrome, é ele mesmo, com um perfil só do agente (`<dados>/navegador/<agente>`), controlado pelo protocolo do DevTools (src/core/chrome.ts): sem janela (headless) enquanto o agente trabalha, numa janela normal no Assumir. Precisa ser o Chrome de verdade: o Google recusa login em navegador embutido ("Esse navegador ou app pode não ser seguro", visto no Electron) e amarra a sessão ao Chrome que a criou (DBSC), então cookie copiado não serve. `navigator.webdriver` fica falso e o headless se apresenta como Chrome comum. Sem o Chrome, o app usa o Chromium do Electron numa janela escondida com sessão própria (src/main/browser.ts), que serve pra quase tudo menos login do Google. Os logins ficam entre conversas e separados de tudo (do usuário, dos prints, dos outros agentes). Sem pedidos de permissão nem downloads. Link que abre nova aba leva o agente junto.
- **Ferramentas:** `navegador_abrir`, `navegador_clicar`, `navegador_digitar` (troca o que há no campo; lista escolhe a opção; Enter opcional), `navegador_tecla`, `navegador_rolar`, `navegador_voltar`, `navegador_ler` (texto da página inteira, shadow DOM incluído, e a lista completa), `navegador_ver` (o print pro agente; opcionalmente no chat), `navegador_esperar`. Cada ação devolve título, endereço e os elementos da tela numerados (papel, texto, valor; senha mascarada).
- **Onde clicar:** o agente diz o alvo em palavras ("o botão Buscar") ou pelo número. O app acha pelo número, pelo texto exato ou pelo único texto da tela que o contém. Se não acha e o usuário escolheu o **Jev** (Configurações, Navegador dos agentes), pergunta ao Jev qual elemento é (Choice sobre a lista, ~1 s) e, se nenhum serve, onde está no print (Box, experimental no TypeSafe). Sem o Jev, devolve os parecidos e pede o número. Ligar o Jev manda a lista de elementos e às vezes o print pro TypeSafe, inclusive de área logada; por isso é escolha do usuário.
- **Governança:** clique cujo texto compra, paga, publica, posta, envia, agenda, salva, comenta, segue, reserva ou apaga vira um pedido de aprovação, com o print da tela no chat. Aprovado, o app clica só se a página ainda for a mesma e o botão com aquele texto ainda estiver lá; senão conta ao agente que a página mudou. Nunca vale "sempre permitir". O que está escrito na página é informação, não instrução.
- **Assumir:** o painel do navegador (aberto pelo cartão "Navegador de X" na mensagem) mostra a tela ao vivo e as últimas ações. "Assumir" mostra a mesma janela pra o usuário entrar numa conta, digitar um código ou passar um captcha; fechar a janela devolve. Enquanto o usuário está com ela, o agente só lê, olha e espera. O prompt pede que, diante de login, senha, código ou captcha, o agente pergunte em vez de tentar. "Apagar logins" na página do agente limpa a sessão.
- Ligado por agente, desligado por padrão. Desligar fecha a janela e mantém os logins.

### 25. Introdução

Quem abre o app pela primeira vez sai dele com um agente trabalhando, não com uma tela vazia.

- **Instalação nova começa vazia** (sem o time de exemplo) e abre uma introdução em tela cheia, em seis passos:
  1. boas-vindas, com o nome;
  2. o motor: confere o Claude Code e o Codex, mostra o comando de instalação ou o botão de entrar, e confere de novo sozinho;
  3. "sobre você", que vira o contexto do workspace;
  4. o primeiro agente, a partir de um modelo (Pesquisa, Engenharia, Conteúdo, Assistente ou do zero), com prévia ao vivo;
  5. o que ele pode usar: web, navegador e computador (nenhum, Linux isolado ou este Mac, com o aviso), e a lembrança de que ações sensíveis sempre pedem aprovação;
  6. a primeira tarefa, com sugestões que mostram o que foi ligado.
- No fim, o app cria o canal #geral com o agente, manda a tarefa com @menção e abre o canal com ele trabalhando.
- Dá pra pular a introdução ou fechá-la.
- **Primeiros passos:** uma lista na barra lateral com nove recursos (time, conector, memória, rotina, projeto, aprovação, celular…). Cada item se marca sozinho pelo estado do app, e o próximo leva à tela certa. Ela some com "Esconder a lista".
- Em Configurações: **Rever a introdução** e **Mostrar os primeiros passos**. Uma instalação que já existia não vê nada disso até pedir.

### 26. Importar de outro app

Quem chega de outro app de agentes traz o time em vez de montar de novo, sem que um arquivo de fora ganhe acesso a nada.

- **Onde:** Configurações → Time e backup → **Importar de outro app…**, que lê um `.zip`.
- **OpenBot:** a exportação dele (Server settings → Transfer → Export from this server, `openbot-transfer.json`, formato `openbot-instance-transfer` v1). Só o formato documentado é lido; nenhum código do OpenBot (PolyForm Noncommercial) entra no Tucano.
- **Apps sem exportação (Grok Bot):** o botão **Skill pro Grok Bot (experimental)** baixa uma skill nossa; um agente de lá a segue e escreve um `.zip` no formato do Tucano (`tucano-import.json`, `tucano-agent-import` v1). Experimental até alguém testar dentro do Grok Bot.
- **O que vem:** nome, papel, instruções, foto, cor, esforço, skills (só o `SKILL.md`), rotinas, memórias e, no Grok Bot, os grupos. O modelo vem quando o CLI dele está pronto aqui; senão, o agente recebe um modelo que roda, com aviso.
- **Governança:** os agentes chegam **sem nenhum conector, com a busca na web desligada e sem computador**; as rotinas chegam desligadas; as memórias esperam confirmação. Os servidores MCP do outro app só aparecem pelo nome no resumo, nunca viram conectores (um arquivo poderia mandar rodar qualquer comando). Um agente importado **nunca entra num canal que já existe**: o grupo vira um canal novo (`#nome-2` se o nome estiver ocupado), e nele entram **só os agentes criados nesta importação**. Um agente que já estava aqui (mesmo que pareça igual, como uma cópia do Tuca) nunca é posto pelo arquivo numa sala com um estranho; o resumo diz quem ficou de fora.
- **Limites por arquivo:** 40 agentes, 30 canais e, por agente, 20 skills, 20 rotinas e 40 memórias de até 300 caracteres. O que passa disso, ou não dá pra ler, fica de fora sozinho (uma skill ruim não derruba o agente) e aparece no resumo, que mostra até 40 linhas.
- **Importar de novo** não duplica: o mesmo agente (nome, papel e instruções), a mesma skill e o mesmo canal (nome e agentes) ficam como estão.
- **O zip** é lido em partes, só com o `zlib` do Node: caminhos com `..` ou fora da pasta do agente são ignorados, entradas criptografadas são ignoradas, ZIP64 é recusado, e cada entrada tem um teto de tamanho conferido depois de descompactar.

## Acceptance criteria

1. **Chat básico:** crio um agente no Claude Code, abro DM, mando uma mensagem e vejo a resposta em streaming, com rodapé de modelo/tokens/duração. O mesmo funciona com um agente no Codex.
2. **Router:** num canal com dois agentes de papéis distintos ("engenharia", "conteúdo"), uma pergunta de código sem menção é respondida só pelo agente de engenharia. Uma mensagem tipo "bom dia" pode não ter resposta. A decisão do router aparece num step discreto.
3. **Menção:** `@a @b` dispara os dois sem chamar o router.
4. **Anti-loop:** dois agentes se mencionando mutuamente param na profundidade 3.
5. **Grants:** um agente com `read` no GitHub MCP lista issues, mas não vê a ferramenta de criar issue (o `tools/list` do gateway no log não a contém). Uma chamada forçada a uma ferramenta não permitida (teste com motor fake) é rejeitada pelo gateway.
6. **Aprovação:** com `read_write`, o pedido "mergeia o PR X" gera um card. Recusar com motivo faz o agente responder considerando o motivo. Aprovar executa a chamada com exatamente os argumentos mostrados.
7. **Aprovação sobrevive a reinício:** fecho o app com uma aprovação pendente, reabro, aprovo, e o run continua.
8. **Limite:** com limite de 1.000 tokens, o segundo turno não abre (nenhum processo da CLI é iniciado) e o run termina como `limit_reached`.
9. **Recibos:** a soma dos recibos de um run bate com o rodapé da mensagem e com a tela de Uso.
10. **Conector:** adiciono um MCP remoto com OAuth (Linear ou GitHub) e um local via stdio. As ferramentas aparecem classificadas, e uma ferramenta nova que surgir depois entra desligada.
11. **Interrupção:** fecho o app no meio de um run. Ao reabrir, ele aparece como `interrupted` e **Retomar** continua a partir do último step completo.
12. **Interface nunca trava:** com 4 runs em streaming e uma resposta de ferramenta de 2 MB, digitar no composer continua fluido (nada de agente roda no renderer nem no main).
13. **Isolamento do motor:** um agente no Claude Code não consegue rodar shell nem ler arquivos (`tools: []` no evento `init`), e nenhum hook, plugin ou MCP da minha configuração pessoal carrega.
14. **Sem credencial no app:** nenhum token da assinatura aparece no SQLite, nos logs ou no `safeStorage` do app.
15. **Testes passam:**
    - classificador de ferramentas;
    - montagem de contexto;
    - máquina de estados do run (incluindo reinício);
    - hash e amarração da aprovação;
    - gateway: filtro por grant e rejeição de chamada fora do grant;
    - conferência e corte por limite de uso;
    - parser de eventos de cada motor (com saídas gravadas das CLIs reais);
    - router com motor fake;
    - reducer do front para eventos de streaming.
16. **Resumo (M4):** numa conversa com mais de 50 mensagens, o turno do agente recebe o resumo + as mensagens recentes, e uma informação dita lá no começo ainda chega a ele.
17. **Memória entre conversas (M4):** digo na DM da Lia "eu prefiro PR pequeno"; ela guarda; no #engenharia o Theo recebe essa memória no prompt.
18. **Governança da memória (M4):** com "pede aprovação", nada entra no prompt antes de eu aceitar. Uma extração baseada só no que um agente disse não vira memória sobre mim.
19. **Esquecer (M4):** esqueço uma memória; ela sai do prompt e a consolidação seguinte, sobre as mesmas mensagens, não a recria.
20. **Computador (M5):** com o computador ligado, peço "cria um dashboard com esses dados e me mostra"; o agente instala o que precisa, sobe o servidor, e eu vejo o print no chat e o app rodando no painel, sem nenhum pedido de aprovação. Um agente sem computador não vê essas ferramentas.
21. **Isolamento do computador (M5):** um comando do agente não enxerga arquivos do Mac fora de `/work`, nenhuma credencial das CLIs está no container, e as portas só respondem em `127.0.0.1`.
22. **Rotina (M6):** crio "todo dia às 9:00, Lia, resuma as issues abertas no Linear" no #engenharia. Às 9:00 aparece a mensagem da rotina, a Lia responde e chega uma notificação. Com o app fechado às 9:00 e aberto às 9:40, ela roda uma vez, como atrasada; aberto no dia seguinte, não roda a de ontem.
23. **Rotina com governança (M6):** uma rotina cujo agente já passou do limite não abre a CLI; uma que pede ação sensível fica esperando aprovação, e a execução seguinte não começa enquanto a anterior roda.
24. **Nada roda solto (M10):** um agente que repete a mesma chamada com o mesmo erro é avisado na 3ª vez e parado na 5ª; um que roda o mesmo teste 30 vezes enquanto edita o código segue até terminar, passando de 50 ferramentas. Um turno sem sinal por 20 min é encerrado; um que demora mas dá sinal, não. Ao passar do teto da resposta, ela pausa com Continuar, e o Continuar segue com os passos feitos. Ao passar de 80% do limite do mês, chega um aviso na conversa e uma notificação, uma vez só.
25. **Projeto (M8):** ligo #simula-oab à pasta do projeto; a Lia (com a pasta) e o PM (sem computador) recebem o `CLAUDE.md` e "O momento" no prompt, e só a Lia é avisada de que tem a pasta em `/projetos/`. Uma decisão que a Lia guarda como do projeto chega ao PM no canal e não aparece numa DM. Um symlink pra fora da pasta listado como arquivo de contexto não é lido.
26. **Web (M9):** pergunto "qual a versão mais recente do Electron?"; o agente pesquisa, lê a página de releases e responde com o link, e eu vejo "Pesquisou na web" e "Leu uma página" nos passos. Com a Web desligada, a CLI não recebe as ferramentas.
27. **Gatilho (M11):** uma rotina olhando `list_issues` do Linear com a label `agente` não dispara pelas issues que já existem; uma issue nova com a label roda o PM uma vez, com a issue no prompt marcada como vinda de fora. Um `curl -d "build falhou"` no endereço da rotina roda o agente com esse texto; um código errado dá 404.
28. **Skill (M11):** uma skill "testes-do-core" aparece no prompt do Staff; pedindo os testes, ele lê a receita e roda os comandos dela; corrigido, propõe uma mudança que só vale depois que eu aprovo, com diff, e que dá pra desfazer pelo histórico.
29. **Celular (M11):** com o bot pareado, uma aprovação chega no Telegram com botões e o toque decide; uma ação de alto risco pede dois toques; uma pergunta respondida no Telegram vira a minha mensagem na conversa; outro chat não consegue nada.
30. **Da issue à PR (M12):** o Staff faz commit em `agent/x` e `git push`; passa, com a linha no canal; um push na main é recusado com o motivo; `abrir_pr` vira um pedido, e aprovado abre a PR com o custo da issue.
31. **Governança no dia a dia (M12):** "Aprovar e sempre permitir" faz a próxima chamada igual rodar sem pedido (não pra alto risco); um agente sem acesso pede e, aprovado, ganha o grant e continua; pausado, ninguém responde nem roda rotina; o boletim mostra cada agente e o custo por issue.
33. **Navegador (M14):** um agente com o navegador ligado abre o Airbnb, escreve "Chicago" no campo Onde e escolhe a sugestão pelo texto; o painel mostra a tela e as ações; clicar em "Comprar agora" vira aprovação com print e só clica depois de aprovado e na mesma página; com o usuário no Assumir, o agente não clica.
32. **Computador no Mac (M13):** um agente com "Este Mac" roda `pwd` e cai na pasta do projeto do canal; o PATH é o do terminal do usuário e não tem variável do app; um serviço sobe numa porta do Mac e para com os filhos; trocar pra Linux ou nenhum para os serviços.

## Out of scope (MVP)

- Chave de API / pagamento por uso (os motores podem até aceitar, mas o app não oferece nem testa).
- Ferramentas embutidas das CLIs (shell, edição de arquivos) no Mac do usuário (a busca na web entrou no M9): quem precisa disso ganha um computador próprio (M5).
- Missões de código com Claude Code ou Codex trabalhando num repositório (candidato natural pra v0.2: é só liberar as ferramentas embutidas num diretório escolhido, com aprovação).
- Sessões persistentes da CLI (`--resume`) como otimização.
- Streaming token a token no Codex (via `codex app-server`).
- Gatilhos de rotina por evento (as rotinas por horário entraram no M6).
- Lições e propostas de mudança de instrução (a memória entrou no M4).
- Busca semântica nas memórias (embeddings).
- Threads, fórum, wiki, drive, issues, agenda, busca global.
- Skills (SKILL.md).
- Multiusuário, sincronização, modo time, servidor.
- Mobile, voz, editor de avatar, importação de OpenMausBot.
- Auto-update e build para Windows (macOS primeiro, depois Linux AppImage).

## Edge cases

- **CLI não instalada ou deslogada:** o agente não roda e a conversa mostra "o Claude Code não está logado", com link pra Configurações.
- **Limite do plano atingido** (Claude Code emite `rate_limit_event`; Codex devolve erro): o run vira `failed` com a mensagem e o horário de liberação, quando a CLI informa. Sem retry automático.
- **CLI falha, trava ou sai com erro:** até 1 retry; depois o run vira `failed` com o stderr resumido. Turno sem resposta não gera recibo.
- **Versão da CLI muda o formato do stream:** o parser ignora eventos desconhecidos. Se não achar o evento final, o run vira `failed` com "formato inesperado da CLI <versão>".
- **Sem internet:** runs falham rápido com mensagem clara. O app abre e mostra o histórico normalmente.
- **Modelo indisponível no plano:** erro da CLI repassado na conversa e na página do agente.
- **Conector cai no meio de um run:** a ferramenta devolve erro pro modelo e o run continua (o agente decide o que fazer).
- **Servidor stdio que morre:** reiniciado sob demanda na próxima chamada. Depois de 3 falhas seguidas, o conector fica marcado como com problema.
- **Grant removido enquanto há aprovação pendente:** ao aprovar, o app confere o grant de novo e recusa a execução com aviso.
- **Token do gateway reaproveitado ou de outro processo:** rejeitado. O token morre quando o turno termina.
- **Argumentos com segredos aparentes no card de aprovação:** mostrados como estão (é a minha máquina). Recibos e logs não guardam argumentos de ferramenta, só nome e duração.
- **Mensagem editada ou apagada depois de disparar um run:** o run continua com o contexto que tinha. Não há re-execução automática.
- **Handle duplicado:** sugere um alternativo (`@nome2`).
- **Router devolve um handle que não está no canal:** ignorado.

## Approach

### Processos

```
┌──────────────── Electron ────────────────┐
│ main: janela, tray, notificações,        │
│       safeStorage, ciclo de vida         │
│   │ MessagePort                          │
│   ▼                                      │
│ utilityProcess "core" (Node):            │
│   engine (router, runs, aprovações,      │
│   limites), SQLite, clientes MCP,        │
│   gateway MCP (127.0.0.1)                │
│   │ spawn por turno        ▲ MCP HTTP    │
│   ▼                        │             │
│ claude -p … / codex exec … ┘             │
│   ▲ MessagePort (RPC tipado + eventos)   │
│   │                                      │
│ renderer: React (sandbox, sem Node,      │
│           contextIsolation)              │
└──────────────────────────────────────────┘
```

- O renderer fala com o core por um `MessagePort` repassado pelo main, sem passar cada mensagem pelo main.
- **RPC:** request/response tipado, com schemas zod compartilhados em `src/shared`.
- **Eventos:** stream de `RunEvent` (step iniciado, delta de texto, step concluído, aprovação criada, run finalizado) que o front aplica num reducer.
- O core faz `spawn` das CLIs, lê o stdout linha a linha (JSONL) e traduz cada formato pro `EngineEvent` comum.
- O main só faz o que exige o main: janela, tray, notificações, `safeStorage` (o core pede pra cifrar ou decifrar via IPC) e o servidor de loopback do OAuth dos conectores.

### Stack

- **Electron** + electron-vite + electron-builder (macOS assinado e notarizado primeiro).
- **Renderer:** React + Vite. Componentes próprios simples, sem lib de UI pesada.
- **Persistência:** `node:sqlite` (sem módulo nativo pra recompilar; plano B: better-sqlite3). Migrations em SQL numeradas.
- **Motores:** as CLIs `claude` e `codex` do usuário, sem SDK de provedor no app. Interface `Engine` com implementações `ClaudeCodeEngine`, `CodexEngine` e `FakeEngine`.
- **MCP:** `@modelcontextprotocol/sdk` (servidor Streamable HTTP pro gateway; clientes Streamable HTTP + stdio + OAuth pros conectores).
- **Testes:** Vitest no core e no reducer. Playwright (modo Electron) pra 2 ou 3 fluxos de ponta a ponta com motor fake.
- **Um pacote só (npm)** com `src/main`, `src/core`, `src/renderer`, `src/shared`. Monorepo só se doer.

### Tabelas (esboço)

`agents`, `channels`, `channel_members`, `messages`, `runs`, `turns`, `steps`, `connectors`, `tools` (classe, ligada, alto risco), `grants`, `approvals` (hash, payload, estado, decisão, motivo, expira_em), `receipts`, `settings`.

### Ordem de construção

0. **M0, interface navegável (feito):** todas as telas com dados simulados e um agente fake que responde em streaming.
1. **M1, núcleo do chat (feito):** casca Electron + core + RPC, SQLite, agentes, canais/DMs, motores Claude Code e Codex, streaming, recibos e limites. (AC 1, 8, 9, 12, 13, 14) Em canal com mais de um agente, até o router chegar, só responde quem for @mencionado. AC 12 ainda não foi medido com 4 runs e resposta de 2 MB.
2. **M2, quem responde (feito):** router, menções, anti-loop, fila de runs, `ask_user`, retomada. (AC 2, 3, 4, 11) O gateway entrou aqui, com `ask_user` como primeira ferramenta, pra validar cedo que as duas CLIs usam ferramentas do app. "Retomar" refaz a resposta inteira no lugar (não há passo a passo pra continuar enquanto não houver ferramentas de conector).
3. **M3, governança de ferramentas (feito):** conectores MCP plugados no gateway, classificação, grants, aprovações. (AC 5, 6, 7, 10) Testado de ponta a ponta com o servidor de demonstração (`scripts/demo-mcp-server.mjs`) e o Claude Code real. Falta validar o OAuth com um provedor real (Linear) e o Codex real com conectores, que depende do login próprio.

4. **M4, memória (feito):** resumo por conversa, memórias sobre mim e por agente, ferramenta `lembrar`, extração na consolidação, esquecer com registro, Revisar. (AC 16, 17, 18, 19) Testado com o Claude Code real: o Sonnet guardou sozinho uma preferência dita de passagem, na terceira pessoa; outro agente usou ela num canal; o Haiku resumiu, extraiu só o que eu disse (ignorou um palpite do agente) e não recriou uma memória esquecida ao reler as mesmas mensagens.

5. **M5, computador do agente (feito):** container por agente, ferramentas `bash`, arquivos, serviços, `screenshot` e `show_file`, artefatos e painel lateral. (AC 20, 21) Testado com o Claude Code real: pedi um dashboard de vendas com gráfico, servido e com print; o Sonnet escreveu, subiu o serviço, tirou o print e respondeu em 15 s, sem nenhum pedido de aprovação. Arquivos são lidos e escritos sempre por dentro do container: um symlink em `/work` apontando pro Mac não alcança o Mac. Codex com computador ainda não testado (depende do login próprio). Pastas emprestadas (M5.1): num projetinho com um teste falhando, a Lia olhou o `git status`, achou o bug, corrigiu e rodou os testes em 11 s; no Mac, o `git diff` tinha só a linha certa e os testes passavam.

6. **M6, rotinas (feito):** agendador, tela de Rotinas, mensagem de rotina na conversa, notificação ao terminar, abrir ao ligar o Mac. (AC 22, 23) Testado com o Claude Code real: uma rotina na DM da Lia, disparada por Rodar agora, respondeu em 5 s, sem perguntar se podia; a DM é criada ao salvar se ainda não existir. Horário, atraso, pulo após 12 h, uma execução por vez e limite testados com relógio simulado. Abrir ao ligar o Mac só pode ser conferido no app empacotado. Depois: "daqui a 1 minuto me manda uma frase" na DM da Lia virou uma rotina de uma vez em 3 s, que disparou sozinha no minuto seguinte.

7. **M7, pronto pro dia a dia (feito):** limites por resposta (ferramentas e tempo), aviso de 80% do limite, app empacotado (`npm run install-app` instala em /Applications, assinado ad-hoc, sem notarização), uma instância por pasta de dados (duas rodariam as mesmas rotinas) e abrir ao ligar o Mac. (AC 24) O build sai fora de `~/Documents`, porque o iCloud põe atributos do Finder nos arquivos e o `codesign` recusa. Testado o app empacotado com PATH mínimo, como aberto pelo Finder: achou o Claude Code, o Codex e o Docker pelo shell de login e respondeu de verdade.

8. **M8, projetos (feito):** canal ligado a uma pasta, contexto lido a cada resposta, memória do projeto, pasta emprestada por acesso no canal. (AC 25)
9. **M9, web (feito):** busca e leitura de páginas pela ferramenta do próprio motor, ligada por padrão, com passos; a mesma busca 5 vezes conta como loop. (AC 26) Testado com o Claude Code e o Codex reais: os dois pesquisaram e responderam com o link.
10. **M10, travas e cache (feito):** loop, travado e teto com Continuar no lugar de 50 chamadas e 15 min; cache lido conta 10%; conversa em blocos pro cache. (AC 24) Testado com o Claude Code real: a segunda resposta leu 92% do cache, e um teto baixo pausou e continuou.
11. **M11, gatilhos, skills e celular (feito):** rotina por item novo num conector ou por chamada local; skills com proposta, diff e histórico; aprovações e perguntas pelo Telegram. (AC 27, 28, 29) Testado de verdade: a chamada local rodou a Lia; o gatilho do Linear olhou e mostrou o erro do conector desautorizado; o Staff leu e propôs skills com o Claude Code real. O Telegram está testado contra uma API simulada; falta o bot real.
12. **M12, da issue à PR e governança no dia a dia (feito):** proxy de git com push só em agent/* e PR por aprovação; boletim e custo por issue; sempre permitir, pedido de acesso, pausar tudo, horário de silêncio, cota da assinatura, time em .md e backup diário. (AC 30, 31)
13. **M13, computador no Mac (feito):** nenhum, Linux isolado ou este Mac, por agente, com confirmação e selo. (AC 32)
14. **M14, navegador (feito):** um Chrome de verdade por agente (Electron como reserva), com ações pelo texto, Jev opcional, tela ao vivo, Assumir e aprovação de cliques arriscados. (AC 33) Testado no Chrome e no Chromium do Electron: formulário, lista, shadow DOM, Enter, nova aba e aprovação numa página local, a busca de Chicago no Airbnb, e Assumir/devolver. A tela de login do Google aceita o Chrome e recusa o Electron.

O MVP termina quando os oito estiverem prontos e eu usar o app por uma semana no dia a dia.

## Riscos

- **Isolamento das CLIs** depende de flags e recursos que mudam entre versões (o Codex ganhou dezenas de recursos ligados por padrão). Mitigação: home próprio pro Codex, `--tools ""` e `--setting-sources ""` no Claude Code, e um teste que pergunta ao modelo quais ferramentas e instruções ele vê, rodado a cada atualização das CLIs.

- **Termos de uso.** A Anthropic permite rodar o Claude Code original logado com a assinatura do próprio usuário, mas proíbe apps que usem o token da assinatura direto ou que ofereçam "entrar com Claude". O app fica do lado permitido: chama a CLI sem modificá-la e nunca toca em credenciais. Os limites do Pro/Max assumem uso individual normal. A OpenAI é mais aberta com o Codex. Rever se as regras mudarem.
- **Formato do stream das CLIs** pode mudar entre versões. Mitigação: parser tolerante, saídas gravadas como fixtures de teste e versão mínima conferida em Configurações.
- **Latência de 4 a 5 s por turno** pra abrir a CLI. Aceitável perto do tempo do próprio modelo. Se o router ficar lento demais, ele vira regra local + modelo só na dúvida.

## Perguntas em aberto

1. ~~**Nome** do projeto~~: Tucano.
2. **Desligar o shell do Codex** por completo: existe opção na CLI ou fica só o sandbox somente leitura num diretório vazio?
