# Rotinas
> Um agente trabalhando sozinho: num horário, quando aparece algo novo num conector, ou quando chamado neste computador.

Uma rotina é um pedido que o app manda pra um agente sozinho, numa DM ou num canal em que ele está. A resposta aparece na conversa, marcada como rotina.

## Criar
1. Em **Rotinas** (um calendário da semana), clique num horário ou em **Nova rotina** (N).
2. **Nome**, **Agente** e **O que fazer**: escreva como numa mensagem. Ele usa as ferramentas, os conectores e o computador que já tem.
3. **Quando roda**:
   - **Num horário**: como repete, os dias e **Às**, na hora do seu computador. **+ horário** põe mais de um no dia (9h, 13h e 17h), em **Toda semana** e **Todo mês**; o × tira.
     - **Toda semana**: nos **Dias** escolhidos (seg a sex, todo dia ou escolhidos).
     - **Uma vez**: no próximo dia marcado em que o horário ainda não passou; depois de rodar, desliga sozinha.
     - **Numa data**: num dia do calendário (ex.: 17/11 às 9h), mesmo daqui a meses. Roda uma vez e desliga.
     - **Todo mês**: num dia do mês (ex.: todo dia 5). Num mês sem esse dia (31 em novembro), roda no último.
   - **Quando aparece algo novo**: escolha um **Conector**, uma **Ferramenta de leitura**, os **Argumentos (JSON)** (o filtro da busca) e de quanto em quanto tempo olhar (**Olhar a cada**). O que já existe agora não dispara: roda uma vez pra cada item novo, um de cada vez. **Testar agora** mostra o que ela vê.
   - **Quando chamada neste computador**: depois de salvar, a rotina ganha um endereço que só este computador acessa. Um script ou um hook do git chama com `curl -d "o que aconteceu" <endereço>`, e o texto chega pro agente. Uma chamada por vez: se ainda estiver rodando, a próxima é recusada.
4. **Onde postar** e **Criar rotina**.

Os próprios agentes também agendam pra si mesmos quando você pede algo pra depois ("daqui a 10 minutos", "todo dia às 9h e às 15h", "dia 17 às 9h", "todo dia 5"). Na conversa aparece **Agendou:** com **Desfazer**.

## No calendário
Clique numa rotina pra ver **Rodou** / **Vai rodar**, **Rodar agora**, **Ver a resposta**, **Editar** e **Apagar**. Setas ← → trocam a semana, T volta pra esta. **Mostrar só as de um agente** filtra.

## Quando roda (e quando não)
- As rotinas rodam enquanto o app está aberto, mesmo com a janela fechada. Pra não depender de lembrar de abrir, ligue **Abrir ao ligar o computador** em **Configurações › Agentes** › **Rotinas** (só no app instalado).
- App fechado no horário: roda quando abrir, até 12 h depois, marcada como atrasada.
- **Horário de silêncio** (mesmo lugar): rotinas e gatilhos esperam e rodam quando ele acaba. O que você mandar continua sendo respondido.
- Agentes pausados (botão no topo da barra lateral): nenhuma rotina roda. Uma chamada pelo endereço responde que os agentes estão pausados.
- Uma resposta que falha é tentada de novo, depois de 1 e de 5 minutos.
- Se a anterior ainda está rodando, a nova vez pula.
- Cada agente tem um máximo de rotinas ligadas (**Máx. rotinas ligadas** na página dele, 10 por padrão).

## Quando dá errado
- Não rodou: o app estava fechado por mais de 12 h, estava em horário de silêncio, os agentes estavam pausados, ou o agente está arquivado (arquivar desliga as rotinas).
- "Não deu pra ler o conector": o conector está desconectado ou pede login (veja **conectores**).
- Ficou esperando aprovação: decida em **Aprovações** ou pelo Telegram.
