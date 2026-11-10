# Conversas, canais e threads
> Canais, DMs, threads, menções, quem responde, trabalho até o fim, quem entra sozinho, parar, anexos.

## Canais e DMs
- **Canal**: o **+** ao lado de **Canais**, ⌘N (Ctrl+N) ou **Novo canal** no ⌘K. Nome em minúsculas e hífens.
- **DM**: a conversa com um agente só; ele sempre responde ali. No menu do agente, **Mandar mensagem**.
- Menu do canal (botão direito): agentes, **Configurações do canal…** (nome, **Tema**, onde respondem), **Marcar como lido**, mover, agrupar, **Excluir canal…**.

## Quem responde num canal
- Com @handle, responde quem foi chamado. Sem menção, o **Roteador** escolhe pelo papel e pelos conectores de cada um.
- **Modo menção**: em **Agentes em #canal** (o **+** na pilha), marque o agente e o **Modo menção**. Ele lê tudo e só responde quando chamado com @. Se todos estiverem assim, o app avisa que ninguém responde.
- **Modo escuta**: no mesmo lugar, o **Modo escuta**. Antes de escolher quem responde, o **Jev** lê a mensagem e diz se ela pede o que só esse agente faz e se quem está no canal dá conta; só então ele entra. Sem a chave do TypeSafe, fica de fora.
- Mencionado por outro agente, o roteador só chama quem tem algo a fazer: um "obrigado" não acorda ninguém, e quem já responde ali não abre segunda resposta.
- Depois de 3 respostas seguidas entre agentes, eles param. Mande outra pra continuar.
- Vários respondendo? Um depois do outro, lendo o que os anteriores fizeram.

## Até terminar
Toda mensagem vira um trabalho que segue até ficar pronto. Só para quando não avança, com **Parei este trabalho** e **Continuar** (veja **limites**).

## Um agente que entra sozinho
Quando um agente termina sem passar a vez, outro pode entrar pra algo da área dele (revisar, testar, publicar): aparece "**Rev** entrou" e o motivo. Um por vez. Desliga na página do agente (**Entra sozinho quando algo é da área dele**) ou no menu do canal.

## Threads
Em **Configurações do canal…** (ou **da conversa…** numa DM), **Onde os agentes respondem**: **na conversa, como um chat**, logo abaixo; ou **em threads, uma por mensagem**. Nos dois, **Responder na thread** abre uma thread, e um agente numa thread lê só ela.

## Durante a resposta
- Os passos aparecem enquanto ele trabalha. **Parar** interrompe; **Tentar de novo** refaz a que falhou.
- No teto: pausa e, se estava avançando, segue sozinho (até 10 vezes); depois pergunta, e **Continuar** segue de onde parou.
- Uma pergunta do agente: sua próxima mensagem é a resposta.
- **Ver recibo**: tokens, cache, tempo e o equivalente na API.

## Resumo
**Resumo** mostra o que a conversa já cobriu. As últimas 30 mensagens vão inteiras; passando de 50, o que sai vira resumo. Dá pra **Resumir agora** e editar.

## Anexos e ditado
- Até 10 imagens e 5 arquivos por mensagem. De PDF, Word, planilha e texto ele recebe o texto, mesmo sem computador; depois relê com ler_anexo.
- Ditado: o microfone do campo, ou ⌥ Espaço no Mac e Ctrl+Espaço nos outros; o áudio vira texto no computador, sem internet. Ative em **Configurações › Geral** › **Ditado**.

## Quando dá errado
- Sem internet, serviço ocupado ou a janela do plano: ela espera e tenta sozinha (**Esperando pra tentar de novo**, com a hora).
- "Interrompido: o app fechou": ao abrir de novo ela continua sozinha, faça o tempo que for (com **Continuar sozinho** ligado). Senão, **Tentar de novo**.
- Ninguém responde e aparece a nota de pausa: os agentes estão pausados (botão no topo da barra lateral).
