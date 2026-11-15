# ElevenLabs
> Conectar a ElevenLabs: o que ela dá aos agentes, por que só conecta num Tucano em servidor, os créditos que gasta e as contas de outras regiões.

A ElevenLabs dá aos agentes voz (texto em fala), transcrição, música, efeitos e os agentes de voz da sua conta. Fica em **Conectores** › **Adicionar conector**, com login pelo navegador.

## Só num servidor
A ElevenLabs não deixa um app se registrar sozinho. Ela lê a descrição do app num endereço https, e só um Tucano que roda num servidor com endereço https tem um (veja **servidor**).
- No Tucano num servidor: **Conectar** abre o login da ElevenLabs.
- No app do computador: ela aparece como **não conectou**, com o aviso de que esse serviço só conecta pelo Tucano que roda num servidor.

## O que saber
- Gerar gasta créditos da sua conta da ElevenLabs, como no site dela.
- O áudio volta como um link que expira em umas 2 horas: peça de novo ao agente se o link venceu.
- Mudar um agente de voz publica na hora.

## Conta em outra região
Conta na Europa, Índia ou Singapura: use **Adicionar personalizado** com o endereço da sua região e autenticação **OAuth**.
- Europa: `https://api.eu.residency.elevenlabs.io/v1/mcp`
- Índia: `https://api.in.residency.elevenlabs.io/v1/mcp`
- Singapura: `https://api.sg.residency.elevenlabs.io/v1/mcp`
