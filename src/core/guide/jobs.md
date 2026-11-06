# Jobs do Databricks
> Um agente acompanha um run pela CLI do Databricks, com um cartão ao vivo, e só gasta tokens quando algo importa.

O app consulta o run sozinho, sem gastar tokens, e mostra estado, tasks e métricas num cartão na conversa. O agente só acorda em falha, conclusão ou possível travamento, e responde na thread do cartão.

## Ligar
1. Instale e autentique a CLI do Databricks na máquina onde o Tucano roda (`databricks auth login`).
2. Em **Configurações › Agentes › Jobs do Databricks**, escolha o **Perfil da CLI** e clique em **Testar a CLI**.
3. Na página do agente, aba **Ferramentas**, ligue **Acompanhar jobs**.

## Usar
Peça em palavras: "Acompanha o job 123456789" ou "Acompanha o run 8841 e me avisa se travar". Com um job, o agente segue o run ativo mais recente. Sem run ativo, ele avisa e **não inicia nada**.

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
Uma skill deixa a análise do seu jeito. Crie em **Skills**, com **Quando usar** "ao analisar um alerta, uma falha ou a conclusão de um job do Databricks", e uma receita como:

1. Use `ver_job` para ler as métricas e achar a etapa ou task afetada.
2. Em caso de falha, leia a saída da task e cite o erro original.
3. Compare a duração com a mediana dos últimos runs.
4. Responda com o que aconteceu, a causa provável, o grau de certeza e o próximo passo.
5. Nunca cancele, reinicie ou altere o job sem aprovação.

## Quando dá errado
- **Sem acesso:** rode `databricks auth login --profile <perfil>`. O acompanhamento volta sozinho.
- **Não acha a CLI:** informe o **Caminho da CLI** nas Configurações.
- **Sem leitura há X minutos:** é falha na consulta, não no job. O app tenta de novo com mais espaço entre as tentativas.
- **App fechado:** ao abrir, ele retoma. As métricas do intervalo ficam de fora, e o job continua rodando no Databricks.
