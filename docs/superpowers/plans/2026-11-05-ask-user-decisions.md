# Decisões no `ask_user` — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ask_user` passa a receber uma lista de decisões (escolha única, múltipla ou texto). No app elas aparecem uma por vez no lugar da caixa de mensagem, com revisão antes de enviar. O Telegram só mostra as decisões como texto e continua aceitando resposta livre.

**Architecture:** um módulo compartilhado (`src/shared/questions.ts`) define os tipos e as funções puras: ler, validar, formatar e resumir. O core guarda as perguntas e o progresso das respostas na própria mensagem do agente (`run.questions`, `run.answers`). Enviar continua sendo uma mensagem minha via `Runner.send`, que monta o texto a partir das respostas. O renderer lê e grava esse estado pelo core. O Telegram só lê as decisões para montar o texto.

**Tech Stack:** TypeScript, Electron + React 19, vitest.

**Spec:** `docs/superpowers/specs/2026-11-05-ask-user-decisions-design.md`

## Global Constraints

- Todo texto visível em PT e EN via `L(pt, en)`.
- Limites: 1–4 decisões por chamada, 2–4 opções em `single`/`multiple`. Acima disso, erro pro agente pedindo pra dividir.
- `{ question: string }` (forma antiga) continua aceito e vira uma decisão `text`. Mensagens salvas com `run.question` são lidas como uma decisão `text`, sem migrar o banco.
- Responder escrevendo continua funcionando sempre. As respostas parciais vão junto: as linhas formatadas, depois uma linha em branco, depois o texto livre.
- **Telegram fora do escopo** (decisão do usuário depois do spec): sem botões nem passo a passo. Ele só mostra as decisões como texto, e uma reply de lá entra como resposta livre (com as parciais junto, pelo mesmo caminho do app).
- Commits no estilo do repo (frase imperativa, sem prefixo `feat:`), **sem** trailers `Co-Authored-By`/`Claude-Session`.
- Nomes descritivos, poucos comentários (padrão do repo: comentário só onde explica um porquê).

## Review Focus

1. **Enviar duas vezes** (duplo clique em "Enviar", ou enviar no app e depois responder no Telegram): a segunda vez não faz nada como resposta, porque a pergunta já não está `waiting_input`. Teste na Task 3.
2. **Gravar resposta numa pergunta já respondida/enviada:** `Runner.answer` numa mensagem que não está mais `waiting_input` é ignorado. Teste na Task 3.
3. **Índice ou opção fora do intervalo** (RPC mal formado): ignorado sem quebrar. Teste na Task 3.
4. **Reply no Telegram depois de responder parte no app:** as parciais vão junto com o texto do celular. Teste na Task 3 (é o mesmo `Runner.send`).
5. **Mensagens antigas** com `run.question` string: aparecem no card, no contexto e no Telegram como uma decisão de texto. Testes nas Tasks 1 e 2.

**Decisão do plano (não estava no spec):** com **uma única decisão**, não há tela de revisão: responder já envia. A revisão só aparece com 2 ou mais decisões. Motivo: uma pergunta como "Pra quando você precisa disso?" com tela de revisão seria um passo a mais sem ganho.

---

### Task 1: Tipos e funções puras das decisões

**Files:**
- Create: `src/shared/questions.ts`
- Modify: `src/shared/types.ts:155-175` (`Run`)
- Modify: `.gitignore` (adicionar `.superpowers`)
- Test: `test/questions.test.ts`
- Também entram neste commit: o spec e este plano (`docs/superpowers/`)

**Interfaces:**
- Produces (em `src/shared/questions.ts`):
  ```ts
  export type QuestionKind = 'single' | 'multiple' | 'text'
  export interface QuestionOption { label: string; description?: string }
  export interface Question { question: string; kind: QuestionKind; options?: QuestionOption[] }
  export interface Answer { chosen?: number[]; other?: string; text?: string; skipped?: true }
  export const MAX_QUESTIONS = 4, MIN_OPTIONS = 2, MAX_OPTIONS = 4
  export function questionsOf(run: Run | undefined): Question[]
  export function parseQuestions(args: Record<string, unknown>): { questions: Question[] } | { error: string }
  export function isAnswered(answer: Answer | null | undefined): boolean
  export function firstUnanswered(questions: Question[], answers: (Answer | null)[] | undefined): number // -1 quando todas respondidas
  export function answerLabel(question: Question, answer: Answer): string
  export function formatAnswers(questions: Question[], answers: (Answer | null)[] | undefined): string
  export function questionHeadline(questions: Question[]): string
  export function describeQuestions(questions: Question[]): string
  ```
- Produces (em `Run`, `types.ts`): `questions?: Question[]`, `answers?: (Answer | null)[]` (por índice), `answeredInText?: true`. `question?: string` fica marcado como legado (só leitura de mensagens antigas).

- [ ] **Step 1: Write the failing tests** em `test/questions.test.ts`:

  ```ts
  const pagination: Question = { question: 'Paginação no menu?', kind: 'single', options: [{ label: 'Busca remota' }, { label: 'Scroll infinito' }] }
  const parts: Question = { question: 'O que remover?', kind: 'multiple', options: [{ label: 'Nó tag' }, { label: 'getUsedTags' }, { label: 'declaredTagIds' }] }
  const deadline: Question = { question: 'Pra quando?', kind: 'text' }

  it('reads an old run with a question string as one text decision', () =>
    expect(questionsOf({ status: 'done', steps: [], question: 'Pra quando?' })).toEqual([deadline]))
  it('prefers run.questions over the old string', ...)
  it('accepts the old { question } form', () => expect(parseQuestions({ question: ' Pra quando? ' })).toEqual({ questions: [deadline] }))
  it('accepts a list of decisions and trims labels', ...)
  it('refuses: no decisions, more than 4, a single/multiple with fewer than 2 or more than 4 options, an empty question or label, an unknown kind', () => {
    // cada caso: expect('error' in parseQuestions(args)).toBe(true)
  })
  it('drops options from a text decision', ...)
  it('finds the first unanswered decision, -1 when all are', () => {
    expect(firstUnanswered([pagination, parts], undefined)).toBe(0)
    expect(firstUnanswered([pagination, parts], [{ chosen: [0] }])).toBe(1)
    expect(firstUnanswered([pagination, parts], [{ chosen: [0] }, { skipped: true }])).toBe(-1)
  })
  it('labels each kind of answer', () => {
    expect(answerLabel(pagination, { chosen: [1] })).toBe('Scroll infinito')
    expect(answerLabel(parts, { chosen: [0, 2] })).toBe('Nó tag, declaredTagIds')
    expect(answerLabel(parts, { chosen: [0], other: 'o chip' })).toBe('Nó tag, Outra coisa: o chip')
    expect(answerLabel(pagination, { other: 'os dois' })).toBe('Outra coisa: os dois')
    expect(answerLabel(deadline, { text: 'sexta' })).toBe('sexta')
    expect(answerLabel(deadline, { skipped: true })).toBe('(pulou)')
  })
  it('formats one line per answered decision and leaves the unanswered out', () =>
    expect(formatAnswers([pagination, parts, deadline], [{ chosen: [0] }, null, { skipped: true }]))
      .toBe('Paginação no menu? → Busca remota\nPra quando? → (pulou)'))
  it('headlines the first question, with how many more', () => {
    expect(questionHeadline([deadline])).toBe('Pra quando?')
    expect(questionHeadline([pagination, parts, deadline])).toBe('Paginação no menu? (+2)')
  })
  it('describes the decisions for the agent context, a lone text question exactly as before', () => {
    expect(describeQuestions([deadline])).toBe('Pra quando?')
    expect(describeQuestions([pagination, deadline])).toBe('1. Paginação no menu? (Busca remota | Scroll infinito); 2. Pra quando?')
  })
  ```
  O idioma dos testes é PT; siga como os outros testes fixam o idioma (ver `test/context.test.ts`).

- [ ] **Step 2: Run** `npx vitest run test/questions.test.ts`. Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implement** `src/shared/questions.ts` com as assinaturas acima e adicione os campos em `Run`. Os textos fixos são `Outra coisa: ` / `Something else: ` e `(pulou)` / `(skipped)`. Em `multiple`, as opções escolhidas vêm na ordem dos índices, e `other` entra por último. O `parseQuestions` devolve mensagens de erro curtas e acionáveis em PT/EN, por exemplo `No máximo 4 decisões por pergunta: divida em mais de uma.`

- [ ] **Step 4: Run** `npx vitest run test/questions.test.ts && npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit** `Describe decisions an agent can ask for` (inclui `.gitignore` e `docs/superpowers/`).

---

### Task 2: O agente pergunta com decisões

**Files:**
- Modify: `src/core/runs.ts:46-61` (`ASK_USER`), `:641` (`let question`), `:738-750` (`runTool`), `:1307` (`base`), `:1348-1351` (status e `notify`)
- Modify: `src/core/context.ts:316-322`
- Modify: `src/core/routines.ts:413-414` (`outcome`)
- Modify: `src/core/index.ts:243` (`toPhone`: condição usa `questionsOf(run).length`)
- Modify: `src/core/telegram.ts:236-243` (`questionAsked` monta o texto com as decisões)
- Modify: `src/core/engines/fake.ts:89-97` (novo gatilho)
- Test: `test/runner.test.ts` (bloco `ask_user through the gateway`), `test/routines.test.ts`, `test/telegram.test.ts`

**Interfaces:**
- Consumes: `parseQuestions`, `questionsOf`, `questionHeadline`, `describeQuestions` (Task 1).
- Produces (Task 1 ganha mais uma função, adicione-a lá com teste): `questionsAsText(questions: Question[]): string`. Com uma decisão, é só a pergunta (igual a hoje). Com mais de uma, uma linha numerada por decisão e as opções entre parênteses separadas por ` | `.
- Produces: a mensagem do agente que perguntou fica com `run.status === 'waiting_input'` e `run.questions` preenchido. Não grava mais `run.question`. Fake engine: uma mensagem com `/decid/i` chama `ask_user` com `{ questions: [{ question: 'Paginação no menu?', kind: 'single', options: [{ label: 'Busca remota' }, { label: 'Scroll infinito' }] }, { question: 'Pra quando?', kind: 'text' }] }`.

- [ ] **Step 1: Write the failing tests** em `test/runner.test.ts`:
  - Ajuste o teste existente: `expect(asked?.run).toMatchObject({ status: 'waiting_input', questions: [{ question: 'Pra quando você precisa disso?', kind: 'text' }] })`. O resto do teste (a próxima mensagem volta pra quem perguntou, contexto contém `pergunta enviada a Edu pela ferramenta ask_user: Pra quando você precisa disso?`) continua igual.
  - `it('asks a list of decisions')`: `r.send('c1', '@lia me ajuda a decidir')` → `run.questions` com as 2 decisões do fake, e o step `Perguntou a você` tem `detail` igual a `questionHeadline(...)` (`'Paginação no menu? (+1)'`).
  - `it('gives the agent the error when the decisions are invalid')`: chame `runTool` indiretamente com um fake que manda 5 decisões (adicione o gatilho `/decis(õ|o)es demais/i` no fake) → `run.status` não é `waiting_input` e o resultado da ferramenta tem `isError` (siga como os outros testes de erro de ferramenta checam isso, se houver; senão, só o status).
  - Em `test/telegram.test.ts`: os dois testes de reply existentes continuam passando (formato legado), e um novo `it('shows every decision as text, and a reply still answers')` com `questions: [pagination, deadline]` confere que o `sendMessage` contém `1. Paginação no menu? (Busca remota | Scroll infinito)\n2. Pra quando?` e que a reply vai pra `answer` como hoje.
  - Em `test/routines.test.ts`: `outcome` de uma mensagem `waiting_input` com `questions: [pagination, deadline]` é `'Perguntou: Paginação no menu? (+1)'`, e com o legado `question: 'Pra quando?'` é `'Perguntou: Pra quando?'`.

- [ ] **Step 2: Run** `npx vitest run test/runner.test.ts test/routines.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - Na `ASK_USER`, o `inputSchema` ganha `questions` (array de `{ question, kind: enum, options: [{ label, description }] }`) e mantém `question` opcional. Nenhum dos dois fica em `required`. Descrição PT/EN, texto exato:
    - PT: `Pede ao usuário as decisões que faltam pra continuar. Escreva a análise e a proposta no texto da sua resposta, antes de chamar; aqui vão só as decisões, cada uma com uma pergunta curta e, quando der, opções curtas (detalhe em description). Tipos: single (uma opção), multiple (várias), text (resposta livre). De 1 a 4 decisões, de 2 a 4 opções. Depois de chamar, encerre a resposta: as respostas chegam na próxima mensagem.`
    - EN: `Asks the user for the decisions missing to go on. Write your analysis and proposal in your reply's text, before calling; here go only the decisions, each with a short question and, when possible, short options (detail in description). Kinds: single (one option), multiple (several), text (free answer). 1 to 4 decisions, 2 to 4 options. After calling it, end your reply: the answers come in the next message.`
  - Em `runTool`, `let question: string | undefined` vira `let questions: Question[] | undefined`. Use `parseQuestions(args)`; se der `error`, devolva `textResult(error, true)`. Troque `question ||` por `questions ||` nas checagens das linhas 741, 896, 958, 1005, 1040, 1081 e 1256.
  - `base` grava `questions` em vez de `question`. O `notify` usa `questionHeadline(questions)`.
  - Em `context.ts`, use `describeQuestions(questionsOf(m.run))` no lugar de `m.run.question`.
  - Em `routines.ts`, `outcome` usa `questionHeadline(questionsOf(reply.run))`.
  - Em `telegram.ts`, `questionAsked` usa `questionsAsText(questionsOf(msg.run))` e sai cedo quando a lista está vazia. Não muda mais nada no Telegram.

- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit** `Let an agent ask for several decisions at once`.

---

### Task 3: Gravar respostas e enviar

**Files:**
- Modify: `src/core/runs.ts:159-190` (`send`), mais dois métodos novos perto de `handedBack` (`:1546`)
- Modify: `src/shared/rpc.ts` (dois métodos na `Api`)
- Modify: `src/core/index.ts` (os handlers, junto de `sendMessage`, `:713`)
- Modify: `src/renderer/src/store.ts` (duas ações, ao lado de `decideApproval`, `:526`)
- Test: `test/runner.test.ts`

**Interfaces:**
- Consumes: `formatAnswers`, `questionsOf`, `isAnswered` (Task 1). Mensagem com `run.questions` (Task 2).
- Produces:
  - `Runner.answer(messageId: string, index: number, answer: Answer | null): void`: só vale se a mensagem está `waiting_input` e `0 ≤ index < questions.length`. Também ignora opções fora do intervalo. Grava `run.answers[index]` e emite a mensagem (via `this.update`). `null` limpa a resposta.
  - `Runner.submitAnswers(messageId: string): Promise<void>`: se a mensagem ainda está `waiting_input`, chama `send(conversationId, '', [], threadId)`. Se não, não faz nada.
  - `send`: quando há `asked` com respostas, o texto vira `[formatAnswers(...), body].filter(Boolean).join('\n\n')`. A checagem de vazio passa a valer depois de montar esse texto. Se `body` não estiver vazio, grava `answeredInText: true` em `asked.run`.
  - RPC: `answerQuestion(p: { messageId: string; index: number; answer: Answer | null }): void` e `submitAnswers(p: { messageId: string }): void`.
  - Store: `answerQuestion(messageId: string, index: number, answer: Answer | null): void` e `submitAnswers(messageId: string): void`, via `fire` como `decideApproval`. Erros: `Não consegui guardar a resposta.` / `I couldn't save the answer.` e `Não consegui enviar as respostas.` / `I couldn't send the answers.`

- [ ] **Step 1: Write the failing tests** (no bloco do gateway em `test/runner.test.ts`, usando o gatilho `decid` do fake):
  - `it('keeps partial answers on the question and sends them as my message')`: `answer(id, 0, { chosen: [1] })`, `answer(id, 1, { text: 'sexta' })`, `submitAnswers(id)`. Esperado: a minha mensagem tem o texto `'Paginação no menu? → Scroll infinito\nPra quando? → sexta'`, a pergunta fica `done` e o prompt do turno seguinte da Lia contém esse texto.
  - `it('sends the partial answers along with a free reply')`: `answer(id, 0, { chosen: [0] })` e depois `send('c1', 'o resto eu explico: ...', [], threadId)`. Esperado: o texto é `'Paginação no menu? → Busca remota\n\no resto eu explico: ...'` e `run.answeredInText === true`.
  - `it('ignores answers to a question already sent, out of range, or to an unknown option')`: depois do envio, `answer(id, 0, ...)` não muda `run.answers`. O mesmo vale pra `answer(id, 9, ...)` e `answer(id, 0, { chosen: [7] })` antes do envio.
  - `it('sends only once')`: `submitAnswers` chamado duas vezes seguidas manda uma mensagem minha só.
  - `it('clears an answer with null')`.

- [ ] **Step 2: Run** `npx vitest run test/runner.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** conforme as interfaces acima. Para "envia só uma vez": `send` marca `asked` como `done` de forma síncrona antes de qualquer `await` (já é o que acontece hoje). Confirme que `submitAnswers` lê o status antes de chamar.

- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit** `Keep answers to an agent's decisions and send them together`.

---

### Task 4: O card de decisões no app

**Files:**
- Create: `src/renderer/src/components/Decisions.tsx` (`DecisionsCard` e `AnswersSummary`)
- Modify: `src/renderer/src/components/Conversation.tsx:391` (troca `QuestionCard` por `AnswersSummary`), `:834-842` (remove `QuestionCard`), `Composer` (`:1430`, renderiza o card no lugar do campo)
- Modify: `src/renderer/src/styles.css:2129-2165` (estilos do card, da revisão e do resumo; os de `.question` podem ser reaproveitados ou substituídos)
- Modify: `src/renderer/src/store.ts` (estado de cards fechados)
- Modify: `scripts/screens.mjs:54-60` (um passo que mostra o card com decisões e outro com a revisão)

**Interfaces:**
- Consumes: `questionsOf`, `firstUnanswered`, `answerLabel`, `isAnswered` (Task 1). `answerQuestion` e `submitAnswers` do store (Task 3).
- Produces:
  - `DecisionsCard({ message }: { message: Message }): ReactNode`
  - `AnswersSummary({ message }: { message: Message }): ReactNode`
  - No store: `dismissedQuestions: Set<string>` (só em memória), mais `dismissQuestion(messageId)` e `reopenQuestion(messageId)`.

Comportamento (do spec, não repetir na implementação além disso):
- No `Composer`, se existe uma mensagem `waiting_input` aqui (mesmo `here(m)` que já calcula `asker`) com `questionsOf(run).length > 0` e ela não está em `dismissedQuestions`, o card é renderizado no lugar do campo. O rascunho digitado não pode se perder: o estado do `Composer` continua montado.
- O card abre na `firstUnanswered`. Cabeçalho com a pergunta, `‹ n de N ›` e ✕ (que chama `dismissQuestion`). Corpo:
  - `single`: opções numeradas; clicar ou apertar o número grava e avança.
  - `multiple`: opções marcáveis e botão `Próxima` / `Next`.
  - `text`: textarea e botão `Próxima` / `Next`. Enter avança e Shift+Enter quebra a linha.
  - Em `single` e `multiple`, há também a linha `Outra coisa…` / `Something else…` (campo livre).
  - Em todos os tipos, `Pular` / `Skip`.
- Teclado: ↑↓ move o foco entre as opções, Enter escolhe, números escolhem, Esc pula.
- Com 2 ou mais decisões e todas respondidas, vem a revisão: uma linha por decisão com `answerLabel`, clicar volta àquela decisão, e o botão `Enviar` / `Send` chama `submitAnswers` e fica desabilitado depois do clique. Com uma decisão só, responder já envia.
- `AnswersSummary` na mensagem do agente:
  - Pendente: `${N} decisões esperando você` / `${N} decisions waiting for you`, ou `Uma pergunta esperando você` / `A question waiting for you`. Se o card estiver fechado, mostra também o botão `Responder` / `Answer`, que chama `reopenQuestion`.
  - Respondida: o rótulo `Perguntou` / `Asked` e uma linha `pergunta → resposta` por decisão respondida. Com `answeredInText`, acrescenta `O resto foi respondido em texto.` / `The rest was answered in text.`.
  - Legado sem respostas: o rótulo e a pergunta, como hoje.
- Visual: seguir os tokens existentes (`--accent`, `--accent-soft`, `--border`, `--radius`, `--text-2/3`) e o espírito do mockup B. O usuário quer algo mais bonito que o mockup, então trate o card como um componente de primeira classe, sem texto em semibold corrido.

- [ ] **Step 1: Implement** `Decisions.tsx`, a integração no `Composer`, o resumo e o CSS.
- [ ] **Step 2: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 3: Verify no app real** com o skill `run` (ou `npm run dev` com o motor fake): mande `@lia me ajuda a decidir` num canal e confira:
  1. O card aparece no lugar da caixa, com `1 de 2`.
  2. A tecla `2` escolhe e avança.
  3. A decisão de texto aceita Enter.
  4. A revisão mostra as duas respostas, e clicar numa volta a ela.
  5. Enviar fecha o card, a caixa volta com o rascunho e o resumo aparece na mensagem.
  6. Repetindo: ✕, escrever "explico depois" e enviar manda as parciais + o texto, e o resumo diz `O resto foi respondido em texto.`
  7. Uma pergunta simples (`@lia me pergunta o prazo`) envia sem revisão.
  8. Tudo isso dentro de uma thread também.
  9. Tema claro e escuro.
- [ ] **Step 4: Run** `node scripts/screens.mjs` (com o app em build, como o script espera) e confira os prints novos do card e da revisão.
- [ ] **Step 5: Commit** `Answer an agent's decisions one at a time in place of the message box`.
