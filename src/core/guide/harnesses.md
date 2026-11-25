# Harnesses (MCP)
> Conectar o seu harness (Claude Code, Codex, Cursor, OpenCode) ao Tucano por MCP: de lá, ele entende o time, conversa com os agentes e configura o Tucano.

O Tucano é também um servidor MCP. Conectado a ele, o harness que você já usa no dia a dia vê o time, manda mensagens aos agentes e espera a resposta, e cria ou muda agentes, canais, rotinas, skills, conectores e memórias, como você faria nas telas. Um uso comum: pedir ao harness "cria no Tucano o equivalente dos agentes e skills que você tem".

## Conectar
Em **Configurações › Harnesses**:
- No app do computador, **Conectar em um clique** escreve o endereço e uma chave nova na configuração do Claude Code, do Codex, do Cursor ou do OpenCode. Se já existir uma entrada `tucano`, ele pergunta antes de trocar. Com o harness aberto, reinicie a sessão dele.
- Em qualquer lugar, **Gerar uma chave** dá a chave (mostrada uma vez só) e o que colar em cada harness: o comando do Claude Code, o trecho do `config.toml` do Codex, o JSON do Cursor e do OpenCode, ou o endereço e o cabeçalho pra outro.

O endereço muda com onde o Tucano roda:
- **No computador:** `http://127.0.0.1:47817/mcp` (outro workspace tem outra porta). Só programas no mesmo computador chegam, e só com o Tucano aberto. O claude.ai e o ChatGPT não chegam.
- **Num servidor ou no Tucano Pro:** o endereço do servidor com `/mcp` no fim (`https://<nome>.pro.tucano.sh/mcp`).

## O que cada chave pode
Cada chave é de uma pessoa e age como ela: vê o que ela vê e muda o que ela pode mudar no app, conferido a cada chamada. Ao gerar, escolha até onde vai:
- **Ler:** entende o Tucano e vê o time, as conversas e o que rodou.
- **Conversar:** também manda mensagens aos agentes e espera a resposta.
- **Configurar** (o padrão): também cria e muda agentes, canais, rotinas, skills, conectores e memórias.

Nenhuma chave apaga nada, decide uma aprovação, mexe em pessoas, convites, logins ou segredos, nem afrouxa a aprovação de uma ferramenta: isso fica no app.

## O que você vê do que ele fez
- A mensagem que o harness manda aparece na conversa como sua. O agente sabe que veio do harness e que a resposta é lida lá.
- O que ele cria ou muda aparece em **Aprovações** ("Claude Code criou 2 agentes e 1 rotina") e, com um time, na **Atividade**.
- Uma memória mandada pelo harness fica pendente na aba **Memória** do agente até você aceitar.
- Criar algo com um nome que já existe devolve o que existe, sem mudar nada.

## Tirar o acesso
Em **Configurações › Harnesses › Suas chaves**, **Tirar** corta o harness na hora. Remover uma pessoa do Tucano tira todas as chaves dela.
