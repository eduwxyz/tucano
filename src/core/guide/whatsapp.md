# WhatsApp
> Os números de WhatsApp do time: ligar por QR code ou pela API oficial da Meta, escolher o que cada agente lê e responde, aprovar envios, os limites e o que acontece quando chega uma mensagem.

## O que é
Você cadastra um ou mais números de WhatsApp do time (um nome e pra que servem) e escolhe **qual agente pode usar qual conversa**. O agente pode **só ler** ou **ler e responder**. Quando alguém escreve, o agente é avisado e pode responder, se você deixou. Só admins veem e mexem nisso, em **Configurações › WhatsApp** (Settings › WhatsApp).

## Duas formas de ligar
- **QR code** (não oficial): um WhatsApp que já está num celular, ligado como "aparelho conectado". Enxerga contatos **e grupos**. No celular, abra WhatsApp › Aparelhos conectados › Conectar um aparelho e aponte pro código (ou digite um código no lugar do QR).
- **API oficial da Meta**: só contatos (sem grupos), e só com o Tucano num servidor com endereço https, porque a Meta precisa avisar quando chega uma mensagem. Você informa quatro dados do painel da Meta, conferidos antes de salvar. Veja a página **servidor**.

## Quem pode usar o quê
Em cada número, o card **Quem pode usar** lista os agentes e as conversas liberadas:
- **Só ler** ou **Ler e responder**.
- Pra quem responde: **Pede aprovação** (cada envio espera o seu ok) ou **Envia sozinho**.
- **Todas as conversas** libera o número inteiro pro agente. Use com cuidado: ele passa a enxergar tudo e pode começar conversas novas (precisa de **Ler e responder**).
Agente arquivado perde o acesso.

## Aprovações
Se o envio pede aprovação, o agente cria um pedido com o texto exato e a conversa; **nada sai antes do seu ok**. Ao aprovar, o Tucano envia exatamente aquele texto (os limites do dia ainda valem). **Sempre enviar nesta conversa** faz os próximos envios dali saírem sozinhos; o primeiro contato com alguém novo sempre pede. Veja também **aprovacoes**.

## Limites (e por que um número por QR não serve pra disparo em massa)
Cada número tem um máximo de mensagens por dia e de conversas novas por dia, que você ajusta até um teto. O número por QR tem teto baixo de propósito: o WhatsApp bloqueia números que mandam muito, ou pra quem nunca conversou, e um número bloqueado não volta. Os envios saem com pequenas pausas. Pra volume, use a API oficial, nas regras da Meta: depois de 24 horas sem resposta da pessoa, só vale **modelo de mensagem** aprovado.

## Quando chega uma mensagem
Em **Quando chega uma mensagem** você escolhe:
- **Só guarda**: o Tucano guarda a conversa (os últimos 90 dias) e o agente lê quando precisar.
- **Avisa o agente** (recomendado): o agente com **Ler e responder** acorda na conversa privada dele com o dono, vê uma linha sobre a mensagem e decide se responde. Várias mensagens seguidas viram um aviso só. Em grupos, dá pra avisar só quando chamarem o número.
O texto que chega é de gente de fora: o agente o trata como informação, nunca como ordem.

## Quando você responde pelo celular
Se alguém responde pelo celular numa conversa, os agentes **ficam quietos ali por 30 minutos** (dá pra desligar). Vale só pro número por QR.

## Quando dá errado
- **Desconectado**: aperte **Reconectar**. Se o celular desligou o aparelho, leia o QR de novo.
- **API oficial indisponível**: precisa de servidor com https.
- **Passou do limite**: o dia vira à meia-noite; ajuste em **Limites**, se fizer sentido.
