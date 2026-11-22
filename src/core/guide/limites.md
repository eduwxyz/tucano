# Limites, uso e pausa
> Limite mensal de cada agente, teto por resposta, quando um trabalho para, respostas cortadas ou que tentam de novo, Uso e limites, Boletim, pausar tudo e horário de silêncio.

## Limite do mês
Cada agente tem um **Limite mensal (milhões de tokens)** na página dele (aba **Perfil**). O padrão pra agentes novos fica em **Configurações › Agentes** › **Limites** › **Limite padrão por agente** (2 milhões por padrão). Conferido antes de cada resposta; ler do cache conta 10%. Passou de 80%, aparece uma linha na conversa (sem notificação). Bateu, o agente para até o mês virar ou você subir o limite; na resposta aparece **Aumentar o limite de …**.

## Teto por resposta
**Limite por resposta (% do limite do mês)**, 10% por padrão. Chegou nele, o agente pausa. Se estava avançando, segue sozinho até 10 vezes seguidas, enquanto o mês tiver espaço; depois pergunta: **Continuar** segue de onde parou. Desligue em **Continuar sozinho**, no mesmo lugar.

## Quando um trabalho para
Uma mensagem segue até o trabalho ficar pronto, sem número de respostas pra parar (**Respostas seguidas entre agentes** não existe mais). O freio é a falta de avanço:
- 3 respostas seguidas que não mudaram nada;
- a mesma resposta, ou o mesmo pedido ao mesmo agente, voltando 3 vezes;
- 2 horas sem nada novo;
- 100 respostas no mesmo trabalho.

Aí fica a nota **Parei este trabalho**: por quê, o que ficou pronto e onde parou. **Continuar** retoma dali; ou escreva na conversa o que mudar.

## Respostas cortadas
- **Considerar travado após (min sem sinal)**, 20 min por padrão: sem texto nem ferramenta terminando nesse tempo, a resposta é cortada. Trabalho longo que anda não é cortado.
- Um agente que repete a mesma coisa, com o mesmo resultado, várias vezes, é parado ("Parecia um loop").
- Uma falha que passa (sem internet, serviço ocupado, a janela do plano, o computador dele desligado): a resposta espera e tenta de novo sozinha, por umas 2 horas, com o passo **Esperando pra tentar de novo** e a hora. As outras voltam na hora pra quem pediu.
- O app fechou no meio: ao abrir, o trabalho continua, faça o tempo que for (com **Continuar sozinho** ligado).

## Uso e limites
A tela **Uso e limites** (Usage and limits) mostra quanto cada agente gastou no mês e onde vai fechar no ritmo atual, o uso por modelo, os **Bastidores** (o que o próprio app gasta: o roteador, a memória e o Tuca) e os **Recibos recentes**. Com o Claude na assinatura, mostra também a **Janela de 5 horas** e a **Semana** do plano. **Valeria na API** é quanto custaria pagando a API; na assinatura, não é cobrado.

## Boletim
O **Boletim** (Report) mostra a semana: quantas respostas terminaram bem, por agente e por tarefa, e o que falhou, foi cortado ou recusado, com link pra resposta. Setas ← → trocam a semana.

## Pausar tudo
O botão de pausa no topo da barra lateral pausa o workspace: nenhum agente começa a trabalhar e nenhuma rotina roda. O que já está rodando termina. O mesmo botão retoma.

## Horário de silêncio
Em **Configurações › Agentes** › **Rotinas** › **Horário de silêncio**: rotinas e gatilhos esperam e rodam quando ele acaba. O que você mandar continua sendo respondido.

## Quando dá errado
- "Parou no limite": suba o limite do agente ou espere o mês virar.
- A assinatura do Claude ou do ChatGPT acabou: o agente para; um **Modelo reserva** em outra conta ou outro motor assume (veja **motores**).
