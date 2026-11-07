# Aprovações
> O que espera o seu ok, como decidir, sempre permitir, ações de alto risco e expiração.

Nada sensível acontece sem você. Quando um agente quer publicar código, colocar algo no ar, apagar ou enviar algo pra fora, a ação não roda na hora: vira um pedido de aprovação, com a ferramenta e os argumentos exatos.

## O que pede aprovação
- Ferramentas de conector da classe **sensível**. Por padrão: apagar, enviar, publicar, colocar no ar, pagar, e mandar algo pra outras pessoas (postar, responder, encaminhar, comentar, compartilhar, convidar). Um rascunho não pede.
- Abrir um PR no GitHub.
- No navegador do agente e nos apps do computador, cliques que compram, publicam, enviam, pagam ou apagam.
- Pedidos de acesso: um agente sem acesso (ou só com leitura) a um conector pode pedir; se você liberar, ele continua numa nova mensagem.

## Onde decidir
- Na própria conversa, no card do pedido.
- Em **Aprovações** (Approvals), na barra lateral, que lista tudo o que espera você e o **Histórico** (aprovado, recusado, expirado). **Ver na conversa** leva até lá.
- No celular, pelo Telegram (veja **celular**).

## Os botões
- **Aprovar**: cobre só esta chamada, com estes valores. Se o agente mudar qualquer coisa, pede de novo.
- **Recusar**: dá pra dizer por quê; o agente recebe o motivo.
- **Aprovar e sempre permitir**: daqui pra frente aquele agente usa aquela ferramenta sem pedir. Não vale pra ações de alto risco. Na Composio, vale pra cada ação do pedido (GMAIL_REPLY_TO_THREAD, por exemplo), não pro executor inteiro (veja **composio**). Pra desfazer, na página do agente, **Ferramentas** › **Sempre permitido, sem pedir:** › **Voltar a pedir aprovação**.
- Ação de **alto risco**: é preciso segurar o botão pra aprovar (**Segure pra aprovar**). No Telegram, são dois toques.

Prefere que um conector poste sem pedir pra ninguém? Na página dele, mude a **Classe** da ferramenta pra **escrita**. O que você escolhe à mão fica, mesmo quando as regras do Tucano mudam.

## Expiração
Um pedido sem decisão expira. O prazo fica em **Configurações › Agentes** (Settings › Agents) › **Limites** › **Expiração de aprovações**: 1 hora, 24 horas (padrão) ou 7 dias. Expirado, nada acontece; peça de novo ao agente se ainda quiser.

## Quando dá errado
- Aprovei e nada aconteceu: o resultado chega numa nova mensagem do agente. Veja a conversa.
- Uma rotina de madrugada ficou esperando: ligue o Telegram pra decidir de qualquer lugar.
