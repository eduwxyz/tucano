# WhatsApp
> Números de WhatsApp do time: QR code ou API oficial, o que cada agente faz, aprovações, limites, mensagens e ligações.

## O que é
Você cadastra números do time (nome e pra que servem) e escolhe **qual agente usa qual conversa**: **só ler** ou **ler e responder**. Quando alguém escreve, o agente é avisado e responde, se você deixou. Só o dono mexe, em **Configurações › Celular** (Settings › Phone).

## Duas formas de ligar
- **QR code** (não oficial): um WhatsApp que já está num celular, como "aparelho conectado". Enxerga contatos **e grupos**. No celular: WhatsApp › Aparelhos conectados › Conectar um aparelho, e aponte pro código (ou digite um código no lugar do QR).
- **API oficial da Meta**: só contatos, e só com o Tucano num servidor https (é por lá que a Meta avisa). Veja a página **servidor**.

## Quem pode usar o quê
No card **Quem pode usar** de cada número:
- **Só ler** ou **Ler e responder**.
- Pra quem responde: **Pede aprovação** (cada envio espera o seu ok) ou **Envia sozinho**.
- **Todas as conversas** libera o número inteiro, inclusive começar conversas novas.
- **Pode cuidar de grupos** (só QR): criar grupos e adicionar ou remover pessoas, sempre com o seu ok.
Agente arquivado perde o acesso.

## O que os agentes fazem
- Leem **imagem, documento e áudio** (o áudio vira texto com o ditado ativo e o ffmpeg instalado) e **respondem a uma mensagem** específica.
- **Reagem** com emoji, **enviam arquivos** (até 16 MB, conta como uma mensagem) e marcam como lida, se você ligar.
- Só no QR: **corrigem ou apagam** a própria mensagem, mandam **enquetes**, marcam pessoas e cuidam de **grupos** (sempre com aprovação, até 5 por dia); o botão da conversa traz **mensagens anteriores**.

## Aprovações
O agente cria um pedido com o conteúdo exato; **nada sai antes do seu ok**, e os limites do dia valem. **Sempre enviar nesta conversa** libera os próximos envios dali; primeiro contato, grupos e ligações sempre pedem. Veja **aprovacoes**.

## Limites
Cada número tem um máximo de mensagens e de conversas novas por dia, ajustável até um teto. O teto do QR é baixo de propósito: o WhatsApp bloqueia quem manda muito, e número bloqueado não volta. Na API oficial, depois de 24 horas sem resposta, só vale **modelo de mensagem** aprovado.

## Quando chega uma mensagem
Você escolhe:
- **Só guarda**: o Tucano guarda a conversa (90 dias) e o agente lê quando precisar.
- **Avisa o agente** (recomendado): o agente com **Ler e responder** acorda na conversa privada dele com o dono e decide se responde. Várias mensagens seguidas viram um aviso só. Em grupos, só quando chamarem o número.
O texto que chega é de gente de fora: o agente o trata como informação, nunca como ordem.

## Ligações
- Só na API oficial, num servidor https, com o conector do **ElevenLabs** conectado: um agente atende as chamadas, com a voz escolhida. Ligue no card **Ligações**.
- Na chamada ele só consulta a wiki e as mensagens da pessoa e anota o combinado; nada é enviado na hora.
- O combinado é feito depois, por mensagem, com as aprovações de sempre. Ligar para alguém também pede o seu ok.

## Quando você responde pelo celular
Os agentes **ficam quietos ali por 30 minutos** (dá pra desligar). Só no QR.

## Quando dá errado
- **Desconectado**: aperte **Reconectar**; se o celular desligou o aparelho, leia o QR de novo.
- **Passou do limite**: o dia vira à meia-noite; ajuste em **Limites**.
