# Wiki
> O que você e o time sabem, em páginas ligadas: escrever, importar do Obsidian, o curador que guarda das conversas, aprovar mudanças e a revisão.

A wiki é um conjunto de páginas em Markdown, ligadas entre si (pessoas, projetos, assuntos, decisões). Um agente com acesso consulta a wiki antes de responder e cita as páginas.

## Usar
- Abra **Wiki** na barra lateral. A tela mostra o mapa das páginas e as ligações.
- **Nova página** (N) ou **Buscar** (⌘K dentro da wiki). Buscando um nome que não existe, **Escrever “…”** cria a página.
- Arraste um arquivo (PDF, Word, planilha ou texto) pra tela: o curador lê e escreve nas páginas.
- O acesso de cada agente fica na página dele, aba **Memória**: **Lê a wiki** ou **Sem acesso**.

## O curador
Um modelo que cuida da wiki. Em **Ajustes da wiki** (Wiki settings):
- **Guardar das conversas**: depois que uma conversa assenta, ele guarda as decisões, os fatos e os resultados nas páginas. Pra desligar num canal ou DM, no menu dele na barra lateral, **Não guardar na wiki**.
- **Mudar uma página que já existe**: **Pede aprovação** ou **Automático** (ao trocar, o que já estava esperando entra junto). Em **Esperando você**, **Aprovar todas** aprova a lista de uma vez. Páginas novas sempre entram direto. Tudo fica no histórico, com **Desfazer**.
- **Revisar sozinha toda semana**: procura o que não bate, o que ficou velho e o que está repetido. O que achar espera você em **Cuidados**. Dá pra **Revisar agora** a qualquer hora.

**Decisões do curador** mostra o que ele quer mudar em páginas que já existem: **Aprovar**, **Recusar** ou **Desfazer**. Se a página mudou depois da sugestão, **Refazer sobre a versão nova**.

## O resolvedor
Quando a revisão só aponta o problema, o botão **Resolver** em **Cuidados** lê as páginas inteiras com as fontes e propõe a mudança — ou faz a pergunta que só você responde. Em **Ajustes da wiki** › **O resolvedor**: liga e desliga, e o modelo dele.

## A pasta
A wiki é Markdown puro numa pasta: abre no Obsidian, vai pro iCloud ou pro git. Em **Ajustes da wiki** › **A pasta**:
- **Abrir pasta** mostra onde está.
- **Trocar pasta…** passa a usar outra pasta, que pode ser o seu cofre do Obsidian. As páginas da pasta atual continuam lá.
- **Voltar pra pasta do Tucano** volta pra pasta de dentro do app.

- **Sincronizar com git** faz da pasta um clone de um repositório (o seu cofre do Obsidian no GitHub, por exemplo): o que muda lá aparece aqui, e o daqui vai pra lá. Veja **wiki-git**.

**Importar do Obsidian** (ou **Importar um cofre do Obsidian**) copia um cofre com pastas, links e anexos. O cofre original não muda.

**Esquema da wiki** é a página com os tipos de página e como escrever; os agentes e o curador seguem ela. Dá pra editar.

## Com workspaces
Cada workspace tem a sua wiki. Ao criar um workspace, dá pra marcar **Wiki** pra ele usar a mesma pasta (não uma cópia): o que um guarda o outro lê. Veja **workspaces**.

## Quando dá errado
- O agente não cita a wiki: confira se ele tem **Lê a wiki**.
- "A última revisão não conseguiu ler as páginas com o modelo": veja se o motor do modelo da memória está pronto em **Configurações › Modelos**.
