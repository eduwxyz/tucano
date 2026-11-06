# Conectores
> Ligar o Tucano às suas ferramentas (Linear, GitHub, Notion…) por MCP: a loja, os personalizados, login, classes de ferramenta e erros.

Um conector é um servidor MCP: ele dá aos agentes ferramentas de um serviço (ler issues, mandar mensagem, consultar um banco). Os agentes só usam um conector que você liberou na página de cada um, e só no nível que você escolheu.

## Adicionar pela loja
1. Abra **Conectores** (Connectors) na barra lateral.
2. Busque o serviço (**Buscar conectores**) ou escolha pela categoria.
3. **Conectar**: o login abre no navegador. O acesso fica neste computador. Alguns perguntam antes o endereço da sua instância ou um token (GitHub, Dynatrace, Snowflake, Metabase), e o Azure DevOps e o AWS CloudWatch rodam o servidor oficial no seu computador (precisam do Node.js ou do uv).
4. Dê acesso aos agentes: na página de cada um, **Ferramentas** › **Ferramentas e acesso**.

## Os do Google
Gmail, Calendar, Drive, Docs e Sheets pedem um app seu no Google Cloud, criado uma vez: veja **google**.

## Personalizado
**Adicionar personalizado** (Add custom) pra qualquer servidor MCP, inclusive os internos da empresa:
- **Remoto (URL)**: o **URL do servidor MCP** e a **Autenticação**: **OAuth** (abre o navegador pra autorizar), **Token** (vai no cabeçalho Authorization: Bearer) ou **Nenhuma**.
- **Local (comando)**: **Comando**, **Argumentos** e **Variáveis de ambiente** (uma por linha, NOME=valor). Roda um processo no seu computador com o seu usuário: só adicione comandos em que você confia.

Os servidores MCP que você já configurou no Claude Code, no Codex e nos outros aparecem numa lista própria: **Adicionar** traz cada um pro Tucano, com as permissões e aprovações daqui.

Credenciais ficam cifradas no cofre do sistema e nunca aparecem de novo. No lugar de um token ou de uma variável, dá pra pôr uma referência do 1Password (`op://Cofre/Item/campo`): o Tucano guarda só a referência e lê o valor com o 1Password CLI a cada conexão. Pra trocar um token, **Token (substitui o atual)**.

## As ferramentas de um conector
Na página do conector, cada ferramenta tem uma **Classe**: **leitura**, **escrita** ou **sensível**, e pode ser marcada como **Alto risco** ou desligada. Ferramentas novas que o servidor publicar depois entram desligadas até você revisar. Sensíveis sempre pedem aprovação (veja **aprovacoes**). **Quem usa:** mostra os agentes com acesso.

Nos agentes, o nível por conector é **Sem acesso**, **Ler** (só as de leitura) ou **Ler e escrever**.

## Estados
**conectado**, **conectando…**, **precisa autorizar**, **não conectou** ou **desconectado**. Um conector que falha numa resposta mostra o motivo em vermelho no passo, e o agente recebe o mesmo motivo.

## Quando dá errado
- **precisa autorizar**: **Autorizar no navegador** e entre de novo. Um conector OAuth renova sozinho entre aberturas do app; se o servidor recusar a renovação, ele pede login de novo.
- **não conectou**: **Conectar de novo**. Se continuar, confira o endereço e o login.
- O pedido de autorização expirou: feche e clique em **Conectar** de novo.
- Um do Google que não conecta: veja **google**.
- Ferramenta que o agente precisa não aparece: veja se está ligada na página do conector, se o agente tem o nível certo e use **Atualizar ferramentas**.
- **Remover** tira o acesso de todos os agentes; pra voltar, adicione de novo.
