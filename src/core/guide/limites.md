# Limites, uso e pausa
> Limite mensal de cada agente, teto por resposta, quando uma resposta é cortada, Uso e limites, Boletim, pausar tudo e horário de silêncio.

## Limite do mês
Cada agente tem um **Limite mensal (milhões de tokens)** na página dele (aba **Perfil**). O padrão pra agentes novos fica em **Configurações › Agentes** › **Limites** › **Limite padrão por agente** (2 milhões por padrão). O limite é conferido antes de cada resposta. Ler do cache conta 10%. Bateu, o agente para até o mês virar ou você subir o limite; na resposta aparece **Aumentar o limite de …**.

## Teto por resposta
**Limite por resposta (% do limite do mês)**, 10% por padrão. Chegou nele, o agente pausa e pergunta se continua: **Continuar** segue de onde parou.

## Respostas cortadas
- **Considerar travado após (min sem sinal)**, 20 min por padrão: sem texto nem ferramenta terminando nesse tempo, a resposta é cortada. Trabalho longo que anda não é cortado.
- Um agente que repete a mesma coisa, com o mesmo resultado, várias vezes, é parado ("Parecia um loop").

## Uso e limites
A tela **Uso e limites** (Usage and limits) mostra quanto cada agente gastou no mês e onde vai fechar no ritmo atual, o uso por modelo, os **Bastidores** (o que o próprio app gasta: o roteador, a memória e o Tuca) e os **Recibos recentes**. Com o Claude na assinatura, mostra também a **Janela de 5 horas** e a **Semana** do plano. **Valeria na API** é quanto custaria pagando a API; na assinatura, não é cobrado.

## Boletim
O **Boletim** (Report) mostra a semana: quantas respostas terminaram bem, por agente e por tarefa, e o que falhou, foi cortado ou recusado, com link pra resposta. Setas ← → trocam a semana.

## Pausar tudo
O botão de pausa no topo da barra lateral pausa o workspace: nenhum agente começa a trabalhar e nenhuma rotina roda. O que já está rodando termina. Uma mensagem sua recebe a nota de que os agentes estão pausados. O mesmo botão retoma.

## Horário de silêncio
Em **Configurações › Agentes** › **Rotinas** › **Horário de silêncio**: rotinas e gatilhos esperam e rodam quando ele acaba. O que você mandar continua sendo respondido.

## Quando dá errado
- "Parou no limite": suba o limite do agente ou espere o mês virar.
- A assinatura do Claude ou do ChatGPT acabou: o agente para; um **Modelo reserva** em outra conta ou outro motor assume (veja **motores**).
