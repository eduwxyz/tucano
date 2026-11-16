[English](local-node.md) · **Português**

# O seu computador como nó de um Tucano num servidor

Quando o Tucano roda num servidor ([Tucano on a server](server.md)), os agentes perdem o que só existe no seu computador: o terminal, os arquivos, o navegador com os seus logins, os apps e os conectores locais. Um **nó** devolve isso. O app de desktop do seu computador vira um conector do Tucano do servidor, alcançado pela sua rede privada do [Tailscale](https://tailscale.com), com uma chave só dele. Os agentes do servidor usam o seu computador por ele, com as mesmas aprovações de sempre.

Situação: **novo e experimental.** Para servidores seus. Testado com nó e servidor na mesma máquina; ainda não foram testados uma VPS de verdade pelo Tailscale de ponta a ponta, cliques reais no navegador e nos apps pelo nó, e o Windows.

Obrigado ao [@pedrojaques99](https://github.com/pedrojaques99), que desenhou e construiu o nó.

## Leia antes

**Quem tem a chave do nó pode rodar comandos no seu computador, como você.** A chave fica no seu servidor. Ligue o nó só para um servidor que você controla, e troque a chave (Configurações › Servidores › Trocar) se achar que ela vazou.

**Use `tailscale serve`, nunca `tailscale funnel`.** O `serve` deixa o nó acessível só aos aparelhos da sua rede do Tailscale. O `funnel` abre o nó para a internet inteira.

## O que o servidor recebe

| Ferramenta | O que faz | Como o servidor julga |
|---|---|---|
| `node_bash` | Roda um comando num terminal do seu computador | Como um comando local: ler roda sozinho; push, apagar e publicar seguem as regras de cada agente. Nunca abaixo de "escrever". |
| `node_read_file`, `node_list` | Lê e lista arquivos | **Só dentro das pastas que você empresta** (abaixo) |
| `node_write_file`, `node_edit_file` | Grava e edita arquivos | Só dentro das pastas emprestadas, e nunca em `.git`, `.husky`, `.envrc`, perfis do terminal ou LaunchAgents. Nunca abaixo de "escrever". |
| `node_approved` | Um clique ou tecla arriscada no navegador ou num app | Julgado como ação de navegador ou de apps, igual aqui: "Nunca" recusa, "Faz sozinho" roda, senão pede aprovação. Nunca fica "sempre permitido". |
| `<conector>__<ferramenta>` | Os conectores ligados no seu computador (Figma desktop, Premiere…) | No mínimo a classe que você deu aqui; a marca de "alto risco" posta aqui continua ligada |

Os pisos de classe são garantidos pelo núcleo do servidor, não só pela tela: baixar `node_bash` para "ler" no cartão do conector não faz os comandos pularem a aprovação.

## Como ligar

Você precisa do Tailscale, na mesma conta, no seu computador e no servidor.

**No seu computador** (app de desktop):

1. Configurações › Servidores › **Este computador como nó**: ligue. Ele escuta só em `127.0.0.1:7441`.
2. Com o Tailscale aberto, num terminal:
   ```bash
   tailscale serve --bg 7441
   tailscale serve status   # mostra https://<este-computador>.<sua-rede>.ts.net
   ```
3. Copie a **Chave** do cartão.
4. **Empreste pastas** (abaixo). Sem nenhuma, os agentes do servidor não leem nem gravam arquivo nenhum deste computador.
5. Se os agentes agora moram no servidor, **pause este computador** (o cartão oferece) para nada responder duas vezes. O nó continua funcionando com o computador pausado.

**No Tucano do servidor:**

1. Conectores › Adicionar personalizado › **Remoto**, endereço `https://<este-computador>.<sua-rede>.ts.net/mcp`, autenticação **Token**, colando a chave.
2. Em Ferramentas, dê acesso aos agentes que vão usar este computador.

Com o computador desligado ou dormindo, o conector fica fora do ar: o agente segue sem ele e diz o que ficou pendente.

## Pastas emprestadas

As ferramentas de arquivo só alcançam as pastas que você empresta no cartão, mais a pasta de trabalho do próprio nó. Os caminhos são resolvidos de verdade, então `..` e symlinks não escapam. Algumas pastas não podem ser emprestadas, e o cartão diz qual e por quê:

- `/`, a sua pasta pessoal inteira, ou qualquer coisa fora dela
- `~/Library`, `AppData` e qualquer pasta que começa com ponto (`.ssh`, `.aws`, `.config`…)
- os dados do próprio Tucano

O `node_bash` continua sendo um terminal de verdade: um comando lê o que você lê. Por isso ele passa pelas regras de comando e pede aprovação no nível Cuidadoso, em vez de rodar calado como uma leitura.

## O que o servidor rodou aqui

A lista **O que o servidor rodou aqui**, no cartão, mostra cada chamada que o servidor fez pelo nó, da mais nova para a mais antiga: hora, ferramenta, um resumo curto (comando, caminho ou argumentos, com segredos mascarados) e se deu certo. Ela fica no seu computador (`<dados do Tucano>/node/log.jsonl`, as últimas 2000 chamadas) e só você vê. Aperte **Atualizar** para ver as novas.

## Limites

- As aprovações acontecem no servidor. O nó confia em quem tem a chave e registra o que roda, mas não recusa por conta própria.
- Todos os agentes do servidor usam a mesma identidade no nó: a mesma pasta de trabalho, o mesmo perfil do Chrome, os mesmos logins.
- Ainda não vale para o Tucano Pro.
