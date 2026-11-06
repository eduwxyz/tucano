# Jobs do Databricks
> Um agente acompanha um run pela CLI do Databricks, com um cartão ao vivo, e só gasta tokens quando algo importa.

O app consulta o run sozinho, sem gastar tokens, e mostra estado, tasks e métricas num cartão na conversa. O agente só acorda em falha, conclusão ou possível travamento, e responde na thread do cartão.

## Ligar
1. Instale e autentique a CLI do Databricks na máquina onde o Tucano roda (`databricks auth login`).
2. Na página do agente, aba **Ferramentas**, ligue **Acompanhar jobs**.

O app acha a CLI e o perfil sozinho, e mostra o que achou em **Configurações › Agentes › Jobs do Databricks**. Lá dá para escolher outro perfil.

## Usar
Peça em palavras: "Me fala sobre o job 123456789" ou "Acompanha o run 8841 e me avisa se travar". Vale o id, o nome exato ou o link. Com um job, o agente mostra o run ativo mais recente ou, sem nenhum, o último. Ele **nunca inicia nada**.

**Parar de acompanhar** só encerra o acompanhamento: o job continua rodando.

## Métricas
Estado, duração e tasks vêm da API de Jobs. Shuffle, spill, memória e progresso da etapa vêm da API do Spark e só aparecem com o **Endereço da API do Spark** preenchido. Sem ele, ficam como indisponíveis, e o travamento só é percebido pela lentidão fora do normal.

## Possível travamento
- **Sem avanço:** as tasks concluídas da etapa não mudam há um tempo.
- **Task atrasada:** uma task muito acima da mediana das outras, com a etapa quase no fim.
- **Lentidão:** o run muito acima da mediana dos últimos, com pelo menos 3 no histórico.

É um sinal, não uma certeza. Os limites ficam nas Configurações.

## Limites e permissões
- **Comandos permitidos:** o que não estiver na lista é bloqueado. Escrever pela API nunca é permitido.
- **Ações no job:** iniciar e cancelar vêm desligados. Ligados, cada uso pede sua aprovação.
- **Spill:** defina o limite e se só avisa no cartão ou acorda o agente.
- As regras valem para as ferramentas do Tucano. Um agente em **Este computador** roda comandos como você, então use um perfil só de leitura, ou deixe ele em **Linux isolado** ou sem computador.

## Skill de análise
Ao ligar **Acompanhar jobs**, o agente recebe a skill **analisar-job-databricks**, com uma receita de análise. Ela não é necessária para o cartão: só define como o agente escreve a análise. Mude a receita em **Skills**, ou tire o agente dela: o que você mudar ou apagar fica assim.

## Quando dá errado
- **Respondeu sem cartão:** confira se **Acompanhar jobs** está ligado nesse agente, e abra os passos da resposta. Se **Acompanhar job** falhou, o motivo está lá.
- **Sem acesso:** rode `databricks auth login`. O acompanhamento volta sozinho.
- **Não acha a CLI:** instale-a e clique em **Procurar de novo**. Se ela estiver em outro lugar, informe o caminho nas Configurações. Uma CLI só dentro do WSL não é encontrada.
- **Sem leitura há X minutos:** é falha na consulta, não no job. O app tenta de novo com mais espaço entre as tentativas.
- **App fechado:** ao abrir, ele retoma. As métricas do intervalo ficam de fora, e o job continua rodando no Databricks.
