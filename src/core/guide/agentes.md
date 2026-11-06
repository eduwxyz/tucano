# Agentes
> Criar um agente, instruções, modelo, limites, ferramentas e acesso, memória, aparência e arquivar.

## Criar
- Com o Tuca: o **+** ao lado de **Agentes** na barra lateral abre o Tuca. Conte a tarefa, ele propõe um agente num card: **Criar**, **Editar antes** ou **Descartar**.
- À mão: **Novo agente (formulário)** no ⌘K (Ctrl+K). Preencha e **Criar agente**.

## A página do agente
Clique no agente na barra lateral (ou **Ver perfil** na conversa). Ela tem quatro abas:

**Perfil** (Profile)
- **Identidade**: **Nome**, @handle (2 a 32 letras minúsculas, números, - ou _), **Papel** (uma linha que ajuda a decidir quem responde nos canais), **Cor** e **Aparência** (rosto padrão, outra cor ou uma imagem).
- **Instruções**: escreva como pra um colega novo: o que fazer, o que evitar, quando perguntar. O **Contexto** do workspace já entra em toda conversa; aqui vai só o que é deste agente.
- **Onde roda e modelo**: motor, modelo, **Esforço de raciocínio** (mais esforço pensa mais e gasta mais), **Modelo reserva** e **Conta**.
- **Limite mensal (milhões de tokens)**: conferido antes de cada turno. **Máx. rotinas ligadas**: quantas rotinas ele pode ter ligadas ao mesmo tempo (10 por padrão).

**Canais e skills** (Channels and skills): **Onde participa** e as skills que ele usa. Fora desses canais, ele responde quando chamado com @handle.

**Ferramentas** (Tools) — muda na hora, sem salvar:
- **Ferramentas e acesso**: um nível por conector, **Sem acesso**, **Ler** ou **Ler e escrever**. O que fica de fora nem aparece pro modelo. Ferramentas sensíveis viram pedido de aprovação (veja **aprovacoes**).
- **Web**: pesquisa e lê páginas com a ferramenta do próprio Claude Code ou Codex.
- **Navegador**: um Chrome só dele, com logins separados dos seus (você entra pelo **Assumir**).
- **Computador**: **Nenhum**, **Linux isolado** (Docker) ou **Este computador**, mais as pastas emprestadas (veja **computadores**).
- **Apps do computador**: Notas, Calendário, Mail… que ele usa como uma pessoa, com **Só ler** ou **Ler e mexer**. Precisa da permissão de Acessibilidade no Mac.

**Memória** (Memory): como ele guarda memórias sobre você — **Grava sozinho**, **Pede aprovação** ou **Só lê** (usa as memórias, mas não guarda novas) — e o acesso à wiki (**Lê a wiki** ou **Sem acesso**). As notas de trabalho são só dele.

## Arquivar
No menu do agente na barra lateral (clique com o botão direito), **Arquivar…**. Ele sai da barra lateral, para de responder e as rotinas dele desligam. Histórico e recibos ficam. Pra voltar: **Arquivados**, no fim da lista de agentes, **Reativar** (as rotinas você liga de novo em Rotinas).

## Quando dá errado
- Não responde: veja se o motor dele está **Pronto** em Configurações › Modelos e se ele não bateu o limite do mês (**Uso e limites**).
- Num canal, não é escolhido: confira se ele está no canal (**Adicionar ou remover agentes…**) e se o **Papel** descreve o que ele faz; ou chame com @.
