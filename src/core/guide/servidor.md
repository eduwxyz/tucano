# Tucano num servidor
> Rodar o Tucano num servidor seu (VPS ou máquina em casa) e usar pelo navegador: instalar, acessar, manter rodando e o que muda.

No servidor, as rotinas continuam rodando quando o seu computador dorme, e você usa o Tucano pelo navegador, em qualquer computador ou celular. Nada passa por um serviço do Tucano: o servidor é seu. Está em fase nova e experimental.

## O que precisa
- Linux (x64 ou ARM64), com 2 GB de RAM ou mais, e Node.js 24 ou mais novo.
- Pelo menos um harness instalado e com login feito **no servidor**, com o usuário que roda o Tucano (por SSH).
- Opcional: Docker Engine (computadores Linux dos agentes) e Chromium ou Chrome (navegador dos agentes).

## Instalar
Como o usuário que vai rodar o Tucano (não root): clonar o repositório, `npm ci`, `npm run build` e `npm run server`. Ele mostra o endereço com um token (`http://127.0.0.1:7337/?token=…`). Abra esse link uma vez: o token entra no navegador e um cookie mantém. Pra deslogar todos os navegadores, apague o arquivo `server-token` na pasta de dados e reinicie.

## Acessar
Por padrão ele só escuta no próprio servidor, porque quem tem o token controla os agentes. Jeitos de chegar:
- Túnel SSH (`ssh -L 7337:127.0.0.1:7337 …`), o mais simples.
- Tailscale ou outra rede privada, com `TUCANO_HOST` no endereço dela.
- Um proxy reverso com HTTPS (Caddy, nginx) num domínio seu.

Nunca exponha a porta 7337 num endereço público sem HTTPS.

## Manter rodando
Como um serviço do systemd com o seu usuário. Pra atualizar: `git pull && npm ci && npm run build` e reiniciar o serviço. Não há atualização automática.

Variáveis: `TUCANO_DATA` (a pasta de dados, `~/.tucano-server` por padrão), `TUCANO_HOST`, `TUCANO_PORT` (7337) e `TUCANO_TOKEN`. Atrás de um proxy de saída, `HTTPS_PROXY` (e `NO_PROXY`): os conectores passam por ele. O Tucano confia nos certificados raiz do sistema além dos do Node.

## O que muda em relação ao app
- Notificações: no **app do Tucano no computador** conectado a ele (**Configurações › Servidores**), como as do próprio app, enquanto o app estiver aberto, e no app do iPhone. No navegador, só por HTTPS (um proxy com HTTPS, ou `tailscale serve`): por `http://` no endereço do Tailscale ou da rede de casa o navegador não mostra nenhuma. O Telegram (**Configurações › Celular**) avisa em qualquer caso. **Configurações › Geral › Notificações** › **Testar notificações** mostra como ficam.
- Conector com OAuth: a autorização abre no seu navegador; ao terminar, você cola o endereço em que a página parou.
- Escolher uma pasta pede o caminho dela no servidor.
- A wiki pode usar o seu cofre do Obsidian guardado num repositório git: **Ajustes da wiki** › **Sincronizar com git**. Veja **wiki-git**.
- Apps do computador não existem no servidor (não há tela).
- Um Tucano por pasta de dados: não rode o app e o servidor na mesma pasta ao mesmo tempo.
- Um servidor é um workspace só (o da pasta de dados).
