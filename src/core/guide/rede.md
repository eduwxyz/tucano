# Rede de empresa, proxy e antivírus
> Conector que não conecta só numa rede: certificado não aceito (proxy ou antivírus que inspeciona HTTPS), proxy, DNS, firewall, e o que fazer em cada caso.

Quando um conector não conecta, o Tucano diz o motivo, e **Ver detalhes**, na página do conector, mostra o que o sistema respondeu (o código, como `SELF_SIGNED_CERT_IN_CHAIN`). Um teste rápido: tente em outra rede (o celular roteando). Se lá funciona, é a rede.

## O certificado do servidor não foi aceito
Um proxy de empresa ou um antivírus que verifica HTTPS (Kaspersky, Avast, ESET, Bitdefender…) abre a conexão e assina de novo com um certificado raiz dele. O Tucano confia nos certificados raiz do sistema (as Chaves no Mac, o repositório de certificados no Windows), além dos dele:
- Antivírus: desligue a verificação de HTTPS (ou "proteção web") dele, ou ponha o endereço do conector nas exceções.
- Empresa: peça à TI o certificado raiz e instale no sistema; num computador da empresa ele costuma já estar lá.
- **vencido ou ainda não vale**: confira a data e a hora do computador.

## O proxy recusou, ou pede login
O Tucano usa o proxy das configurações de rede do sistema (inclusive um PAC), lido quando o app abre, ou o de `HTTPS_PROXY` / `HTTP_PROXY`, que vem primeiro. Com login: `HTTPS_PROXY=http://usuário:senha@proxy:porta`. Um proxy SOCKS não é usado. Mudou o proxy? Reabra o Tucano.

## Não achei o endereço (DNS)
Confira o endereço do conector. Numa VPN ou rede de empresa, o DNS dela pode não conhecer o servidor: teste fora da VPN.

## Recusou a conexão, ou a conexão caiu no meio
Um firewall da rede, um proxy ou um antivírus pode estar bloqueando o endereço. Peça à TI pra liberar o endereço do conector (por exemplo `api.githubcopilot.com` pro GitHub).

## No servidor
Num servidor (veja **servidor**), as mesmas variáveis: `HTTPS_PROXY`, `NO_PROXY`. Os certificados raiz são os do sistema (`/etc/ssl`).
