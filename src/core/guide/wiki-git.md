# Wiki no git
> A pasta da wiki guardada num repositório git (o cofre do Obsidian no GitHub, por exemplo): conectar com uma chave de deploy, o que sincroniza, conflitos, só leitura, e o Obsidian Git no Mac.

Pra um Tucano no servidor usar o mesmo cofre do Obsidian que você usa no Mac. O repositório é a verdade. Só o dono e os admins configuram.

## Conectar
Em **Wiki** › **Ajustes da wiki** › **A pasta** › **Sincronizar com git** › **Configurar…**:
1. Cole o endereço SSH do repositório (no GitHub: **Code** › **SSH**, como `git@github.com:voce/cofre.git`). Um endereço https também serve: o Tucano mostra o SSH dele.
2. O Tucano gera uma chave só pra essa wiki. **Copiar**, e **Adicionar no GitHub** abre a página de chaves de deploy do repositório (no GitLab, Bitbucket e Gitea também). Cole a chave em **Key** e dê um nome, como Tucano.
3. Marque **Allow write access** pra ler e escrever. Sem marcar, a wiki fica só leitura. No Bitbucket a chave de acesso só lê.
4. **Testar conexão**: o Tucano clona o repositório e diz quantas páginas, PDFs e docx tem.
5. Se a wiki já tem páginas, escolha: **Usar o repositório** (a wiki mostra só o que está lá) ou **Juntar com as daqui** (as páginas daqui entram no repositório; uma com o mesmo nome entra como "(versão do Tucano)"). Nos dois jeitos, a pasta antiga fica como estava, de backup.

## O que sincroniza
- Ao abrir, a cada 2 minutos e antes de o curador escrever, o Tucano traz o que mudou no repositório.
- Uma página salva (por você, por alguém do time, pelo curador) vai pro repositório uns segundos depois, com a mensagem "Tucano: <página> (<quem>)".
- **Sincronizar agora** faz na hora. O status mostra a última vez e, se falhou, o motivo e quando tenta de novo.
- Nunca vão pro repositório: páginas guardadas pra uma pessoa (as do **Liberar pro time**), fontes que vieram de DM, o índice e o registro do Tucano, e arquivos acima de 50 MB (aparece um aviso em **Cuidados**).

## Conflitos
Se a mesma página mudou no repositório e no Tucano, fica a do repositório. A do Tucano vira "<página> (versão do Tucano)", vai pro repositório também, e um aviso aparece em **Cuidados**.

## Só leitura
Se a chave não pode escrever, o Tucano percebe no primeiro envio: a wiki ganha o selo **Só leitura**, mostra o que está no repositório e não aceita escrita (nem sua, nem do curador). O que não chegou a ir fica na pasta. Pra escrever: marque **Allow write access** na chave e toque em **Tentar escrever de novo**.

## Obsidian Git no Mac
No Obsidian: **Configurações** › **Plugins da comunidade** › procure **Git** (de Vinzent) › instalar e ativar. Nas opções dele, ligue **Auto pull interval** e **Auto commit-and-sync interval** em 2 a 5 minutos, e **Pull on startup**. O cofre precisa ser um clone do mesmo repositório.

## Quando dá errado
- "recusou a chave": a chave foi apagada ou revogada no repositório. Adicione de novo, ou **Desconectar** e conectar de novo pra gerar outra.
- "não achou esse repositório": confira o endereço; sem a chave, o GitHub diz que ele não existe.
- "O git não está instalado": no Mac, `xcode-select --install`; no Windows, o Git for Windows; no Linux, `sudo apt install git`.
- **Desconectar** para a sincronização e apaga a chave; a pasta continua com as páginas. Apague a chave de deploy no repositório também.
