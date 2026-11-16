[English](local-node.md) · **Português**

# O seu computador emprestado a um Tucano num servidor

Quando o Tucano roda num servidor ([Tucano on a server](server.md)) ou no Tucano Pro, os agentes perdem o que só existe no seu computador: o terminal, os seus projetos, o navegador com os seus logins, os apps e os conectores locais. Emprestar o computador devolve isso: os agentes do servidor usam o seu computador como um conector, com as mesmas aprovações de sempre.

Obrigado ao [@pedrojaques99](https://github.com/pedrojaques99), que desenhou e construiu o nó.

## Como ligar

1. No app de desktop, conecte o servidor em **Configurações › Servidores** (com o link que ele dá), se ainda não conectou.
2. Embaixo do servidor, ligue **Deixar este servidor usar este computador**.
3. Em **O que este computador empresta**, empreste as pastas dos seus projetos.
4. No Tucano do servidor, em **Conectores**, aparece o seu computador (ex.: "MacBook Pro de Eduardo"). Em **Ferramentas**, dê acesso aos agentes que vão usá-lo.

Pronto. Não precisa abrir porta, configurar rede nem copiar chave: o app liga para o servidor, com o mesmo acesso que ele já usa para abrir o servidor nesta janela. Funciona de qualquer rede (casa, escritório, 4G) e atravessa qualquer roteador.

O computador fica disponível enquanto o app estiver aberto. Se você fechar o app, o computador dormir ou a rede cair, o conector aparece desligado no servidor, o agente segue sem ele e diz o que ficou pendente. Quando o computador volta, o app liga de novo sozinho.

## Só para você

Num servidor com várias pessoas, o seu computador é seu. Um agente só alcança o seu computador quando trabalha para você: numa conversa sua, numa rotina sua, ou quando foi você quem pediu num canal. Se outra pessoa pede algo ao mesmo agente, ele não vê o seu computador.

O que pede aprovação no seu computador (um push, um clique arriscado) só você aprova: nem um admin, nem o dono do Tucano, nem o Telegram dele. Uma rotina do time (do canal) não alcança o computador de ninguém, e um computador emprestado não serve de gatilho de rotina ("quando aparece algo novo").

No servidor, o computador de outra pessoa aparece com o nome dela (ex.: "iMac · computador de Maria"). Cada pessoa empresta até 5 computadores; um sexto substitui o mais antigo que não está ligado.

## O que o servidor recebe

| Ferramenta | O que faz | Como o servidor julga |
|---|---|---|
| `node_bash` | Roda um comando num terminal do seu computador | Como um comando local: ler roda sozinho; push, apagar e publicar seguem as regras de cada agente. Nunca abaixo de "escrever". |
| `node_read_file`, `node_list` | Lê e lista arquivos | **Só dentro das pastas que você empresta** |
| `node_write_file`, `node_edit_file` | Grava e edita arquivos | Só dentro das pastas emprestadas, e nunca em `.git`, `.husky`, `.envrc`, perfis do terminal ou LaunchAgents. Nunca abaixo de "escrever". |
| `node_approved` | Um clique ou tecla arriscada no navegador ou num app | Julgado como ação de navegador ou de apps: "Nunca" recusa, "Faz sozinho" roda, senão pede aprovação. Nunca fica "sempre permitido". |
| `<conector>__<ferramenta>` | Os conectores ligados no seu computador (Figma desktop, Premiere…) | No mínimo a classe que você deu aqui; a marca de "alto risco" posta aqui continua ligada |

São as mesmas travas de um agente que trabalha neste computador. O terminal é um terminal de verdade: um comando alcança o que você alcança, e passa pelas mesmas regras de comando. Os pisos de classe são garantidos pelo núcleo do servidor, não só pela tela: baixar `node_bash` para "ler" no cartão do conector não faz os comandos pularem a aprovação.

## Pastas emprestadas

As ferramentas de arquivo só alcançam as pastas que você empresta, mais a pasta de trabalho do próprio nó. Os caminhos são resolvidos de verdade, então `..` e symlinks não escapam. Algumas pastas não podem ser emprestadas, e a tela diz qual e por quê:

- `/`, a sua pasta pessoal inteira, ou qualquer coisa fora dela
- `~/Library`, `AppData` e qualquer pasta que começa com ponto (`.ssh`, `.aws`, `.config`…)
- os dados do próprio Tucano

## O que o servidor rodou aqui

A lista **O que o servidor rodou aqui** mostra cada chamada que o servidor fez no seu computador, da mais nova para a mais antiga: hora, ferramenta, um resumo curto (comando, caminho ou argumentos, com segredos mascarados; o texto digitado aparece só como tamanho) e se deu certo. Ela fica no seu computador (`<dados do Tucano>/node/log.jsonl`, as últimas 2000 chamadas) e só você vê.

## Para não rodar duas vezes

Se os seus agentes passaram a morar no servidor, pause este computador (a tela oferece). Os agentes daqui param de responder e de rodar rotinas, e o computador continua emprestado.

## Para quem cuida do servidor

- O app liga para `<endereço do servidor>/node/link`, um fluxo contínuo como o `/events` das páginas, e responde por POST no mesmo endereço. Com Caddy não precisa de nada. Com nginx, desligue o buffer das respostas nesse caminho como no `/events` (`proxy_buffering off`), ou mande o cabeçalho `X-Accel-Buffering`, que o Tucano já manda.
- Cada link entra com a chave de um aparelho (a que o app ganhou ao conectar o servidor). Tirar a pessoa em **Pessoas**, ou tirar a chave daquele aparelho, corta o computador dela na hora.
- O app nunca segue um redirecionamento: a chave e o que o computador responde só vão pro endereço que a pessoa conectou. Conectar o mesmo servidor de novo, com outro link, desliga o empréstimo até a pessoa ligar outra vez.
- O servidor não alcança o computador sozinho: só o app abre a ligação, e só para servidores em que ela está ligada.

## Limites

- As aprovações acontecem no servidor. O computador obedece ao servidor em que a pessoa ligou o empréstimo, e registra tudo o que roda.
- Todos os agentes do servidor usam a mesma identidade no computador: a mesma pasta de trabalho, o mesmo perfil do Chrome, os mesmos logins.
- Só o workspace principal do app empresta o computador.
