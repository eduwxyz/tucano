# Cofre
> Guardar chaves de API e tokens pros agentes usarem pelo nome, num comando, sem nunca verem o valor: quem pode usar, aprovação por uso, o registro e o .env.

O Cofre fica no pé da barra lateral, embaixo de **Conectores**. Cada chave tem um nome de variável de ambiente (`STRIPE_KEY`, `OPENAI_API_KEY`) e um valor, que fica cifrado no chaveiro do sistema e nunca mais aparece: a tela mostra só os últimos caracteres (`••••a1b2`). No lugar do valor, dá pra colar uma referência do 1Password (`op://Cofre/Item/campo`), lida na hora de cada uso.

## Como o agente usa
Um agente com computador (Linux ou este computador) usa uma chave pedindo pelo nome no comando: o Tucano confere se ela foi liberada pra ele, coloca o valor como variável de ambiente **só naquele comando** e, no que o comando imprimir, troca o valor por `[cofre:STRIPE_KEY]` antes de o agente ler. Nos passos da resposta, o comando aparece com a chave que usou. Um serviço (`start_service`) também pode levar chaves: ficam no ambiente do serviço enquanto ele roda.

Um agente sem computador não tem onde rodar comandos: ele usa chaves por meio dos conectores.

## Quem pode usar
Uma chave nova não vale pra nenhum agente. Na própria chave (Editar) ou na página do agente (**Ferramentas › Chaves do Cofre**), marque os agentes que podem usar. Um agente que pede uma chave que não é dele não roda o comando e fica sabendo quais tem.

## Pedir aprovação a cada uso
Ligado numa chave, todo comando que a usa espera alguém aprovar, com o comando inteiro à vista, como um commit ou um push. Bom pra chaves que mexem em dinheiro ou em produção. Uma chave assim não entra num serviço, só num comando.

## Do time e minhas
Num Tucano com pessoas, o Cofre tem duas gavetas:
- **Do time:** só um admin cria, muda e libera. Os agentes usam em qualquer trabalho.
- **Minhas:** qualquer pessoa cria as suas. Ninguém mais vê que existem, e um agente só usa uma delas num trabalho que aquela pessoa pediu. Uma chave sua com o mesmo nome de uma do time vale no lugar da do time, nos seus pedidos.

## Importar um .env
**Importar .env** lê o arquivo colado e mostra cada linha antes de guardar: nova, já existe (só troca o valor se você marcar) ou não entra (nome inválido ou sem valor). Nenhuma chave importada é liberada pra agente nenhum.

## Nos conectores
Uma variável de conector pode apontar pra uma chave do time: `cofre:STRIPE_KEY`. Trocar a chave no Cofre troca no conector na próxima conexão.

## Registro
A aba **Registro** mostra cada uso: qual chave, qual agente, pra quem era o trabalho e um link pra conversa. Nunca o valor. Um admin vê os usos das chaves do time; cada pessoa vê os das suas.

## Nomes que não podem
Nomes que o próprio terminal usa (`PATH`, `HOME`, `SHELL`, `LD_…`, `DYLD_…`, `BASH_…`, `LC_…`, `TUCANO_…`) não podem ser chaves.
