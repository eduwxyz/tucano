# Time, importação e backups
> Exportar e importar o time num arquivo .md, trazer agentes do OpenBot ou do Grok Bot, e os backups do banco.

Fica em **Configurações › Geral** (Settings › General).

## O time num arquivo
No card **Time** (Team):
- **Exportar time**: baixa um .md com os agentes, as skills, os canais e as rotinas, sem credenciais nem conversas. Serve pra guardar ou levar pra outro computador. O Tuca não vai junto: cada instalação tem o seu.
- **Importar time…**: lê um .md exportado. Entra só o que ainda não existe aqui; as rotinas entram desligadas. No fim aparece um resumo do que entrou e do que ficou de fora.

## De outro app
**Importar de outro app…** aceita um .zip:
- **OpenBot**: em Configurações do servidor → Transfer → Export from this server, com os arquivos.
- **Grok Bot**: ele não exporta sozinho. **Skill pro Grok Bot (experimental)** baixa uma skill: dê ela a um dos seus agentes de lá (ou cole o texto numa conversa) e peça "Exporte meus agentes pro Tucano". Ele devolve um .zip. É experimental: confira o resumo da importação.

Os agentes importados entram sem nenhum conector, com a busca na web desligada, as rotinas desligadas e as memórias esperando você confirmar. Um servidor MCP do outro app só aparece no resumo; nunca vira conector sozinho.

## Backups
No card **Área de perigo** › **Backups**:
- O app faz uma cópia do banco uma vez por dia e guarda as últimas 7.
- **Fazer backup agora** faz uma na hora. **Abrir pasta** mostra onde ficam.
- Antes de uma atualização mudar o banco, o app também guarda uma cópia.
- As credenciais ficam cifradas no backup, presas ao cofre deste computador.

Cada workspace tem os seus backups, dentro da pasta dele: excluir um workspace apaga os backups dele. Copie pra fora antes.

## Quando dá errado
- "Arquivo grande demais pra mandar pelo navegador" (no servidor): importe no app do computador, ou exporte sem os arquivos.
- Importei e nada mudou: tudo já existia aqui (o resumo diz isso).
