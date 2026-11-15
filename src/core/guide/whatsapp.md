# WhatsApp
> Os números de WhatsApp do time: ligar por QR code ou pela API oficial da Meta, escolher o que cada agente lê e responde, aprovar envios, os limites e o que acontece quando chega uma mensagem.

## O que é
Você cadastra um ou mais números de WhatsApp do time (um nome e pra que servem) e escolhe **qual agente pode usar qual conversa**. O agente pode **só ler** ou **ler e responder**. Quando alguém escreve, o agente é avisado e pode responder, se você deixou. Só admins veem e mexem nisso, em **Configurações › WhatsApp** (Settings › WhatsApp). Fica no workspace padrão.

## Duas formas de ligar
- **QR code** (não oficial): é um WhatsApp que já está num celular, ligado como "aparelho conectado". Enxerga contatos **e grupos**. Em **Adicionar número**, escolha **QR code**; no celular, abra WhatsApp › Aparelhos conectados › Conectar um aparelho e aponte pro código. Se preferir, dá pra digitar um código no lugar do QR. O celular precisa ficar com internet de vez em quando.
- **API oficial da Meta**: só contatos (sem grupos), e só quando o Tucano roda num servidor com endereço https, porque a Meta precisa avisar o Tucano quando chega uma mensagem. Você informa quatro dados do painel da Meta, e o Tucano confere com ela antes de salvar. Os passos de servidor estão na página **servidor**.

## Quem pode usar o quê
Em cada número, o card **Quem pode usar** lista os agentes e as conversas liberadas:
- **Só ler** ou **Ler e responder**.
- Pra quem responde: **Pede aprovação** (cada envio espera o seu ok) ou **Envia sozinho**.
- **Todas as conversas** libera o número inteiro pro agente. Use com cuidado: ele passa a enxergar tudo e pode começar conversas novas (precisa de **Ler e responder**).
Um agente arquivado ou removido perde o acesso.

## Aprovações
Se o envio pede aprovação, o agente cria um pedido com o texto exato e a conversa; **nada sai antes do seu ok**. Ao aprovar, o Tucano envia exatamente aquele texto (os limites do dia ainda valem). **Sempre enviar nesta conversa** faz os próximos envios dali saírem sozinhos; o primeiro contato com alguém novo sempre pede. Veja também **aprovacoes**.

## Limites (e por que um número por QR não serve pra disparo em massa)
Cada número tem um máximo de mensagens por dia e de conversas novas por dia, que você ajusta, até um teto. O número por QR tem teto baixo de propósito: o WhatsApp bloqueia números comuns que mandam muito, ou pra muita gente que não conversou antes, e um número bloqueado não volta. Os envios saem com pequenas pausas, como uma pessoa. Pra volume maior, use a API oficial, que segue as regras da Meta: depois de 24 horas sem resposta da pessoa, só vale **modelo de mensagem** aprovado pela Meta.

## Quando chega uma mensagem
Em **Quando chega uma mensagem** você escolhe:
- **Só guarda**: o Tucano guarda a conversa (os últimos 90 dias) e o agente lê quando precisar.
- **Avisa o agente** (recomendado): o agente com **Ler e responder** acorda na conversa privada dele com o dono, vê uma linha sobre a mensagem e decide se responde. Várias mensagens seguidas viram um aviso só. Em grupos, dá pra avisar só quando chamarem o número.
O texto que chega é de gente de fora: o agente o trata como informação, nunca como ordem.

## Quando você responde pelo celular
Se uma pessoa responde pelo próprio celular numa conversa, os agentes **param de responder ali por um tempo** (você escolhe quanto, ou desliga), pra não falar por cima dela. Vale só pro número por QR.

## Quando dá errado
- **Desconectado**: aperte **Reconectar**. Se o celular desligou o aparelho, leia o QR de novo.
- **API oficial indisponível**: precisa do Tucano num servidor com https (página **servidor**).
- **O agente diz que passou do limite**: o limite do dia acaba à meia-noite; ajuste em **Limites**, se fizer sentido.
