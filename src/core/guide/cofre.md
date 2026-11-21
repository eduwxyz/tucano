# Cofre
> Guardar chaves de API, tokens e logins de sites pros agentes usarem sem nunca verem o valor: quem pode usar, aprovação por uso, o pedido no chat, o registro e a importação.

O Cofre fica no pé da barra lateral, embaixo de **Conectores**. Cada chave tem um nome de variável de ambiente (`STRIPE_KEY`) e um valor, cifrado no chaveiro do sistema, que nunca mais aparece: a tela mostra só o final (`••••a1b2`). No lugar do valor, vale uma referência do 1Password (`op://Cofre/Item/campo`), lida a cada uso.

## Como o agente usa
Um agente com computador usa uma chave pedindo pelo nome no comando: o Tucano confere se ela foi liberada pra ele, coloca o valor como variável de ambiente **só naquele comando** e, no que o comando imprimir, troca o valor por `[cofre:STRIPE_KEY]` antes de o agente ler. Um serviço (`start_service`) também pode levar chaves: ficam no ambiente do serviço enquanto ele roda.

Sem computador, um agente usa chaves só pelos conectores.

## Logins de sites
Na aba **Logins**: site, usuário e senha (ou `op://`). Liberado pra um agente com navegador, o app digita no endereço exato do site, e o agente nunca vê a senha. Um login por site pra cada agente, que também se salva pela página dele.

## Quando falta uma chave
O agente pede no chat: aparece um card com o nome da chave (ou o site) e o motivo. Qualquer pessoa da conversa cola ali, direto no Cofre, e ele continua sozinho. Colada, fica entre as suas (só um admin marca **Salvar no time**). Se já existe no Cofre, o card oferece **Liberar** a do time, só um admin.

## Quem pode usar
Uma chave nova não vale pra nenhum agente. Na própria chave (Editar) ou na página do agente (**Ferramentas › Chaves do Cofre**), marque os agentes que podem usar. Uma chave que não é dele não roda o comando, e ele fica sabendo quais tem.

## Pedir aprovação a cada uso
Ligado numa chave, todo comando que a usa espera alguém aprovar, com o comando inteiro à vista. Bom pra chaves que mexem em dinheiro ou em produção. Uma chave assim não entra num serviço.

## Do time e minhas
Num Tucano com pessoas, o Cofre tem duas gavetas:
- **Do time:** só um admin cria, muda e libera. Os agentes usam em qualquer trabalho.
- **Minhas:** qualquer pessoa cria as suas. Ninguém mais vê que existem, e um agente só usa uma delas num trabalho que aquela pessoa pediu. Uma chave sua com o nome de uma do time vale no lugar dela, nos seus pedidos.

## Importar
**Importar .env** mostra cada linha antes de guardar: nova, já existe (só troca o valor se você marcar) ou não entra. **Importar CSV** lê o `Chrome Passwords.csv` do Chrome e o `logins.csv` do Firefox no seletor de arquivos do sistema, cada linha mostrada antes de guardar: nova, já salva (a senha só troca se você marcar) ou fora, com o motivo. Nenhuma delas libera nada pra agente; o CSV fica onde está, sem cifra.

## Nos conectores
Uma variável de conector pode apontar pra uma chave do time: `cofre:STRIPE_KEY`. Trocou no Cofre, troca no conector na próxima conexão.

## Registro
A aba **Registro** mostra cada uso: chave ou login, agente, pra quem era o trabalho e o link da conversa. Nunca o valor. Um admin vê os usos do que é do time; cada pessoa, os do que é dela.

## Nomes que não podem
Nomes do próprio terminal (`PATH`, `HOME`, `LD_…`, `TUCANO_…` e parecidos) não podem ser chaves.
