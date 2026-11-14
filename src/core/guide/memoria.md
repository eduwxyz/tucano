# Memória
> O que os agentes sabem sobre você: como aprendem, aprovar ou deixar automático, notas de cada agente e o resumo das conversas longas.

## Dois tipos
- **Você**: preferências, padrões e fatos que valem pra todos os agentes. Entram no prompt de cada resposta.
- **Notas de trabalho** de um agente: só ele vê.

O **Contexto** em **Configurações › Geral** é outra coisa: um texto fixo que você escreve e todo agente lê sempre.

## Como entram
1. Você ensina: em **Memória** (Memory), no campo **Ensinar algo sobre você**, escreva e Enter guarda.
2. Um agente guarda durante a conversa, conforme o modo dele (aba **Memória** na página do agente): **Grava sozinho** (guarda e avisa na mensagem, com **Desfazer**), **Pede aprovação** (espera você guardar) ou **Só lê** (usa as memórias, mas não guarda novas).
3. O modelo da memória aprende das conversas. Em **Configurações › Modelos** › **Memória**, **O que ele aprende sobre você**: **Vira sugestão pra você aprovar**, **Grava sozinho** ou **Nada (só resume)**. Só conta o que você disse, nunca o que um agente supôs.

## A tela Memória
- **Novas**: as sugestões esperando você **Guardar** ou **Descartar**.
- **Ainda valem?**: memórias sem confirmação há muito tempo. Continuam no prompt até você decidir (**Ainda vale** ou **Esquecer**).
- Cada memória pode ser editada ou esquecida. **Esquecidas** saem do prompt, e o registro impede que sejam aprendidas de novo; **Apagar de vez** remove até ele.
- Memórias mais antigas podem ficar fora do prompt; os agentes acham com uma busca quando precisam.

## Resumo das conversas
O modelo da memória também resume o que sai da janela das conversas longas (roda a cada ~20 mensagens numa conversa longa) e, de uma thread que fica parada alguns minutos, tira um resumo próprio. Veja o botão **Resumo** em cada conversa (página **conversas**).

## Quando dá errado
- O agente "esqueceu" algo: veja se está em **Memória** e não em **Esquecidas**; ensine de novo com uma frase curta.
- Guardou algo errado: edite ou **Esquecer** na tela Memória.
