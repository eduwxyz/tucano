# Skills
> Receitas que os agentes seguem pra um tipo de tarefa: escrever, trazer do Claude Code ou do Codex, aprovar as propostas dos agentes e voltar versões.

Uma skill é uma receita em Markdown pra um tipo de tarefa: comandos exatos, armadilhas, como conferir. Cada agente vê, no prompt, o nome e o **Quando usar** das skills que valem pra ele, e lê a receita quando precisa.

## Criar
1. Abra **Skills** na barra lateral e clique em **Nova skill** (New skill).
2. **Nome** (curto, vira algo como testes-do-core), **Quando usar** (uma frase que vai no prompt de cada agente) e **Receita** (os passos).
3. **Quem usa**: **Todos os agentes** ou **Só alguns**.
4. **Criar skill**.

Na página do agente, aba **Canais e skills**, dá pra ver e mudar as skills que ele usa.

## Trazer as que você já tem
**Buscar skills existentes** procura nas skills do seu Claude Code e do Codex. **Usar** traz uma: ela é lida direto do arquivo, então o que você mudar lá vale na próxima vez. Uma skill com scripts só roda com um agente que tenha computador (Linux ou este computador). A introdução também oferece trazer as suas.

## Propostas dos agentes
Quando um agente resolve algo em vários passos, sai de um beco sem saída ou é corrigido por você, ele pode propor uma skill nova ou uma mudança numa dele. A proposta fica em **Propostas**, no topo de Skills, e só entra em uso se você **Aprovar** (ou **Recusar**). Depois de aprovar, dá pra liberar pra outros agentes.

## Histórico e arquivo
- Cada mudança fica no **Histórico** da skill, com **Voltar a esta** pra restaurar uma versão.
- **Como está indo** mostra como as respostas que usaram a skill terminaram.
- **Arquivar** tira de uso e guarda em **Arquivadas** (com **Reativar**). **Apagar** some de vez.

## Quando dá errado
- O agente não usa a skill: confira em **Quem usa** se ele está incluído e se o **Quando usar** descreve bem a situação.
- Skill com scripts falhando: o agente precisa de um computador (veja **computadores**).
