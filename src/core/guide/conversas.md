# Conversas, canais e threads
> Canais, mensagens diretas, threads, menções, quem responde, passagem de vez entre agentes, parar e tentar de novo, imagens e ditado.

## Canais e DMs
- **Canal**: o **+** ao lado de **Canais**, ⌘N (Ctrl+N) ou **Novo canal** no ⌘K. Nome em minúsculas e hífens ("Squad Pagamentos" vira squad-pagamentos), depois os agentes.
- **DM**: a conversa com um agente só. Ele sempre responde ali. No menu do agente, **Mandar mensagem**.
- No menu do canal (botão direito nele na barra lateral): **Adicionar ou remover agentes…**, **Configurações do canal…** (nome, **Tema** e onde os agentes respondem), **Marcar como lido**, mover e agrupar, **Excluir canal…**.

## Quem responde num canal
- Com @handle, responde quem foi chamado.
- Sem menção, o **Roteador** lê a conversa e escolhe quem responde, pelo papel e pelos conectores de cada um.
- Quando um agente menciona outro na resposta, o roteador lê antes e só chama quem tem algo a fazer: um "obrigado" não acorda ninguém. Se o chamado já está respondendo ali, ele não abre uma segunda resposta: vê isso na próxima.
- Depois de 3 respostas seguidas entre agentes a partir de uma mensagem sua, a conversa entre eles para. Mande uma mensagem pra continuar.

## Threads
Em **Configurações do canal…** (ou **Configurações da conversa…** numa DM), **Onde os agentes respondem**:
- **Na conversa, como um chat**: as respostas vêm logo abaixo.
- **Em threads, uma por mensagem**: cada mensagem abre uma thread na lateral.

Nos dois jeitos dá pra abrir uma thread numa mensagem com **Responder na thread**. Um agente numa thread lê só aquela thread.

## Durante a resposta
- Os passos aparecem enquanto o agente trabalha. **Parar** interrompe.
- **Tentar de novo** numa resposta que falhou ou foi interrompida.
- Chegou no teto da resposta: ele pausa e pergunta. **Continuar** segue de onde parou.
- Uma pergunta do agente: sua próxima mensagem ali é a resposta.
- **Ver recibo**: tokens, cache, tempo e o equivalente na API.

## Resumo
O botão **Resumo** no topo mostra o que a conversa já cobriu. As últimas 30 mensagens vão inteiras; passando de 50, o que sai da janela vira resumo. Dá pra **Resumir agora** e editar.

## Anexos e ditado
- Até 10 imagens e 5 arquivos por mensagem (clipe, arrastar ou colar). AVIF, BMP e TIFF, e imagens grandes demais, vão ao agente como WebP. De PDF, Word, planilha e texto, o agente recebe o que está escrito, mesmo sem computador; depois relê com ler_anexo.
- Ditado: o microfone do campo, ou ⌥ Espaço no Mac e Ctrl+Espaço nos outros. O áudio vira texto no próprio computador, sem internet. Ative em **Configurações › Modelos › Modelos locais** › **Áudio**.
- Modelos locais de imagem (**Configurações › Modelos › Modelos locais** › **Imagens e PDFs**, desligados até ativar): **Ler texto** (PP-OCRv6, lê PDF escaneado), **Elementos de tela** (OmniParser v2, licença AGPL-3.0: botões, campos, cartões, com posição) e **Objetos** (DEIMv2-N). Ativados, o agente recebe o texto lido no lugar da imagem (ver_imagem mostra ela). Se nada for lido, a imagem vai; com **Nunca enviar imagens para a IA** (exige um modelo ativo), nunca vai, e ver_imagem fica bloqueada. Lê JPG, PNG, WebP e PDF; AVIF, GIF, BMP e TIFF se adicionados em **Tipos lidos aqui**. CPU ou GPU, baixados uma vez para todos os workspaces; desativar apaga o modelo. **Avançado**: modelo próprio (.onnx).

## Quando dá errado
- "Interrompido: o app fechou no meio da resposta": **Tentar de novo**.
- Ninguém responde e aparece a nota de pausa: os agentes estão pausados (botão no topo da barra lateral).
