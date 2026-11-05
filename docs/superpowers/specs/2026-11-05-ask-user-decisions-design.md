# Decisões no `ask_user`

## Por quê

Hoje o `ask_user` recebe uma string e o card "Pergunta pra você" a mostra crua num `<p>` (`Conversation.tsx`, `QuestionCard`): sem markdown, sem quebras de linha. Os agentes acabam colocando tudo nela — diagnóstico, proposta e várias decisões — e o resultado é um bloco de texto onde não dá pra ver o que se está pedindo, nem responder cada ponto separadamente.

O que se quer: **a proposta vai na mensagem do agente (markdown normal); as decisões vêm uma por vez, com opções**, como o widget de perguntas do Claude.

## Objetivos

- O agente separa contexto (texto da resposta) de decisões (ferramenta).
- Cada decisão é de um de três tipos: **escolha única**, **múltipla escolha** ou **texto**.
- No app, as decisões aparecem **no lugar da caixa de mensagem** (opção B do mockup), uma por vez, com navegação "‹ 1 de 4 ›".
- Antes de enviar, uma **tela de revisão** com todas as respostas, onde dá pra voltar em qualquer uma.
- Depois de respondido, a mensagem do agente guarda um resumo das escolhas.

## Não-objetivos

- Polimento visual final agora: o mockup era só de layout. O visual segue o design do app e pode ficar mais bonito que o mockup, mas não é o foco desta entrega.
- Mudar aprovações (`waiting_approval`) ou outros cards.
- **Botões e passo a passo no Telegram** (fica pra depois). Ele só mostra as decisões como texto, e uma reply de lá é uma resposta livre.

## Anti-objetivos (seria fracasso mesmo funcionando)

- O card voltar a carregar parágrafos de proposta.
- Perder o caminho de responder escrevendo: quem quiser ignora o card e responde em texto livre, como hoje.
- Mensagens antigas (com `run.question` string) quebrarem ou sumirem.

## Como funciona

### A ferramenta

`ask_user` passa a receber uma lista de decisões:

```ts
{
  questions: Array<{
    question: string                  // curta: "Paginação no menu?"
    kind: 'single' | 'multiple' | 'text'
    options?: Array<{ label: string; description?: string }> // single/multiple
  }>
}
```

- A descrição da ferramenta diz explicitamente: análise e proposta vão no texto da resposta, *antes* de chamar; aqui só o que precisa ser decidido. Uma decisão por item, pergunta curta, opções curtas (detalhe no `description`).
- Validação no `runTool` (`runs.ts`), com erro devolvido ao agente: ao menos 1 decisão; `single`/`multiple` precisam de opções. **Minha decisão:** 1–4 decisões, 2–4 opções, como no Claude; acima disso, erro pedindo pra dividir.
- **Minha decisão:** continuar aceitando `{ question: string }` (forma antiga) como uma decisão `text`, pra não quebrar agentes no meio de uma conversa.

### O dado

`Run.question?: string` vira `Run.questions?: Question[]` e ganha `Run.answers?: Answer[]` (progresso das respostas, por índice). Mensagens antigas com `question` string são lidas como uma decisão `text` (conversão na leitura, sem migrar o banco).

- `Answer`: `{ chosen?: number[]; other?: string; text?: string; skipped?: true }`.
- O progresso fica **no core** (salvo na mensagem), não só no renderer: sobrevive a trocar de conversa e vai junto se a resposta final vier em texto (inclusive pelo Telegram). Novo IPC/evento pra gravar uma resposta parcial e pra enviar.

### Enviar

Enviar = mandar **uma mensagem minha** pelo caminho que já existe (`Runner.send`), com o texto das respostas formatado, uma por linha:

```
Paginação no menu? → Busca remota + 20 primeiros
Etiqueta nativa? → Tirar tudo
Chip no editor? → Outra coisa: ícone de tag com cor
Mais de uma tool? → (pulou)
```

Assim o agente recebe a resposta como hoje (próxima mensagem humana responde a pergunta pendente), o contexto (`context.ts`) e o histórico continuam funcionando. A mensagem do agente passa a `done` e o card vira um resumo compacto das escolhas, no lugar do "Perguntou".

**Minha decisão:** a minha mensagem com as respostas aparece normal na conversa (é o que o agente leu); o construtor pode deixá-la mais compacta se ficar redundante com o resumo.

### No app

- Enquanto houver uma pergunta pendente **onde a caixa está** (conversa ou thread, mesma regra de `pendingQuestion`), o `Composer` dá lugar ao card de decisões.
- Cabeçalho: a pergunta, "‹ n de N ›", ✕.
- **Escolha única:** opções numeradas; clicar ou apertar o número escolhe e avança.
- **Múltipla:** opções marcáveis + botão "Próxima".
- **Texto:** campo de texto + "Próxima".
- Em `single`/`multiple`: linha "Outra coisa…" (texto livre) e "Pular".
- Teclado: ↑↓ navega, Enter escolhe, números escolhem, Esc pula.
- Depois da última: **revisão**, uma linha por decisão com a resposta; clicar volta àquela decisão; botão "Enviar".
- **✕** fecha o card e devolve a caixa de mensagem: o que eu escrever ali responde, como hoje. **As respostas parciais vão juntas:** se já respondi algumas decisões (no app ou no celular), minha mensagem enviada leva as linhas formatadas dessas respostas e, embaixo, o texto que escrevi. As que não respondi ficam de fora. O resumo na mensagem do agente mostra as respostas parciais e "o resto respondido em texto". Enviar pelo card e responder escrevendo usam o mesmo caminho em `Runner.send`, que monta as linhas a partir de `run.answers` da pergunta pendente. **Minha decisão:** a mensagem do agente mostra um botão "Responder" que reabre o card enquanto estiver pendente.
- Mensagem do agente enquanto pendente: aviso curto ("↓ 4 decisões esperando você").

### No Telegram

Sem botões por enquanto. A mensagem do celular lista as decisões como texto, uma linha numerada por decisão com as opções entre parênteses. Responder à mensagem envia texto livre, pelo mesmo caminho de quem fecha o card e escreve no app, e as respostas parciais dadas no app vão junto.

### Outros lugares que leem `run.question`

- Notificação do Mac (`runs.ts`, `notify`): a primeira pergunta, e "+N" se houver mais.
- `outcome` das rotinas (`routines.ts`): idem.
- `context.ts`: a pergunta enviada vira a lista das decisões com as opções.
- Motor fake (`engines/fake.ts`): passa a usar o formato novo; manter um caso no formato antigo.
- `scripts/screens.mjs`: atualizar a tela de exemplo, se ela mostrar o card.

## Deixado para o construtor

- Visual do card, da revisão e do resumo, seguindo os tokens do app.
- Nomes de tipos, eventos e IPC.
- Como o card se encaixa no `Composer` (substituir ou sobrepor), contanto que o rascunho digitado não se perca.
- Textos exatos (PT/EN via `L`).
