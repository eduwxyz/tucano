# Workspaces
> Separar contextos (empresa e pessoal, por exemplo): criar escolhendo o que levar, trocar, duplicar, pausar, excluir, e o que continua compartilhado no computador.

Cada workspace tem seus agentes, conversas, conectores e credenciais, memórias, rotinas, skills e wiki. Um não vê o conteúdo do outro.

## Trocar e ver os outros
Clique no nome no topo da barra lateral. O menu lista os workspaces com as não lidas e as aprovações de cada um (só esses números, nada do conteúdo). As rotinas de todos continuam rodando enquanto outro está na tela. Uma notificação de outro workspace, clicada, troca pra ele.

## Criar
1. No menu do topo, **+** (**Criar workspace**).
2. **Nome do workspace**.
3. **O que levar de “…”?**, marcando o que quiser do workspace atual:
   - **Configurações gerais**: seu nome, idioma, modelos do roteador e da memória, limites, horário de silêncio e voz.
   - **Contexto**.
   - **Wiki**: a mesma wiki, não uma cópia. O que um guarda o outro lê. Sem marcar, começa com uma wiki vazia.
   - **Agentes**: instruções, modelos, computadores e pastas emprestadas, sem as memórias nem os arquivos.
   - **Canais**: nomes, temas e membros, sem as mensagens.
   - **Skills**: sem os agentes, as de agentes específicos vêm arquivadas.
   - **Conectores e credenciais** (e o GitHub). Sem eles, os agentes vêm sem permissões.
   - **Rotinas**: só com os agentes; as ligadas rodam no novo também, com endereços de gatilho novos.
4. Sem nada marcado, começa vazio, com a introdução. Com os agentes, um workspace já configurado pula a introdução.

Nunca vêm: mensagens, memórias, resumos, aprovações, histórico de uso, arquivos dos computadores, sessões do navegador e as contas extras do Claude Code, do Codex e do Grok (os agentes usam o login padrão). Conectores com OAuth podem pedir login de novo.

## Gerenciar
A engrenagem no menu abre **Gerenciar workspaces**: trocar, pausar ou retomar cada um (ou **Pausar todos**), duplicar (abre o mesmo formulário com tudo marcado) e excluir.

## Nome
Em **Configurações › Geral**, **Nome do workspace** é o nome no seletor; **Como os agentes te chamam** é o seu nome, separado.

## Excluir
Em **Configurações › Geral** › **Área de perigo** › **Excluir workspace e todos os dados** (ou a lixeira no gerenciador). Apaga agentes, conversas, memórias, credenciais, rotinas e os backups locais dele. Copie um backup pra fora antes. Pastas de projetos e outros workspaces ficam. Se outro workspace usa a wiki dele, a pasta da wiki não é apagada: passa pro outro.

## O workspace padrão
É a pasta de dados que já existia. Não pode ser excluído. O Telegram e **Abrir ao ligar o computador** ficam nele.

## O que é compartilhado
Os logins do Claude Code e do OpenCode são do computador, não do workspace. Um workspace separa dados, mas não é uma sandbox: um agente com **Este computador** alcança o mesmo disco.
