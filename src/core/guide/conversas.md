# Conversas, canais e threads
> Canais, DMs, threads, menções, quem responde, trabalho até o fim, quem entra sozinho, parar, anexos e ditado.

## Canais e DMs
- **Canal**: **+** ao lado de **Canais**, ⌘N (Ctrl+N) ou **Novo canal** no ⌘K. Nome em minúsculas e hífens.
- **DM**: um agente só; ele sempre responde ali. No menu dele, **Mandar mensagem**.
- Menu do canal (botão direito na barra lateral): agentes, **Configurações do canal…** (nome, **Tema**, onde respondem), **Marcar como lido**, mover, agrupar, **Excluir canal…**.

## Quem responde num canal
- Com @handle, responde quem foi chamado.
- Sem menção, o **Roteador** lê a conversa e escolhe quem responde, pelo papel e pelos conectores de cada um.
- **Modo menção**: em **Agentes em #canal** (o **+** na pilha de agentes), marque o agente e o **Modo menção**. Ele fica no canal e lê tudo, mas só responde quando é chamado com @, por você ou por outro agente: é assim que um modelo caro entra num canal sem responder a cada recado. Se todos do canal estiverem em modo menção, a mensagem fica sem resposta e o app avisa.
- Quando mais de um vai responder, eles respondem um depois do outro: cada um lê o que os anteriores fizeram e faz a sua parte em cima.
- **Modo escuta**: no mesmo lugar, o **Modo escuta**. Antes de escolher quem responde, o **Jev** lê aquela mensagem e diz se ela pede o que só esse agente faz e se quem está no canal dá conta: só então ele entra. Um modo por vez; sem a chave do TypeSafe, ele fica de fora.
- Quando um agente menciona outro, o roteador só chama quem tem algo a fazer: um "obrigado" não acorda ninguém. Se o chamado já está respondendo ali, ele não abre uma segunda resposta: vê isso na próxima.
- Depois de 3 respostas seguidas entre agentes a partir de uma mensagem sua, a conversa entre eles para. Mande uma mensagem pra continuar.
## Até terminar
Toda mensagem vira um trabalho que segue até ficar pronto. Só para quando não avança mais, com **Parei este trabalho** e **Continuar** (veja **limites**).

## Um agente que entra sozinho
Num canal, quando um agente termina sem passar a vez, outro pode entrar pra revisar, testar ou publicar: aparece "**Rev** entrou" e o motivo. Um por vez. Desliga na página do agente (**Entra sozinho quando algo é da área dele**) ou no menu do canal.

## Threads
Em **Configurações do canal…** (ou **da conversa…**), **Onde os agentes respondem**: **na conversa, como um chat**, logo abaixo; ou **em threads, uma por mensagem**. Nos dois, **Responder na thread** abre uma thread, e um agente numa thread lê só ela.

## Durante a resposta
- Os passos aparecem enquanto ele trabalha. **Parar** interrompe; **Tentar de novo** refaz uma que falhou ou foi interrompida.
- No teto: pausa e, se estava avançando, segue sozinho (até 10 vezes). Depois pergunta: **Continuar** segue de onde parou.
- Uma pergunta do agente: sua próxima mensagem ali é a resposta.
- **Ver recibo**: tokens, cache, tempo e o equivalente na API.

## Resumo
**Resumo** mostra o que a conversa cobriu. As últimas 30 mensagens vão inteiras; passando de 50, o que sai vira resumo. Dá pra **Resumir agora** e editar.

## Anexos e ditado
- Até 10 imagens e 5 arquivos por mensagem (clipe, arrastar ou colar). De PDF, Word, planilha e texto ele recebe o texto, mesmo sem computador; depois relê com ler_anexo.
- Ditado: o microfone do campo, ou ⌥ Espaço no Mac e Ctrl+Espaço nos outros; o áudio vira texto no computador, sem internet. Ative em **Configurações › Geral** › **Ditado**.

## Quando dá errado
- Sem internet, serviço ocupado ou a janela do plano: a resposta espera e tenta sozinha (**Esperando pra tentar de novo**, com a hora).
- "Interrompido: o app fechou": ao abrir de novo ela continua sozinha, faça o tempo que for (com **Continuar sozinho** ligado). Senão, **Tentar de novo**.
- Ninguém responde e aparece a nota de pausa: os agentes estão pausados (botão no topo da barra lateral).
