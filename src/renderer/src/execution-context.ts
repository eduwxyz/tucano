import { L } from '../../shared/lang'

// The execution host is independent of the UI's OS or URL (including localhost).
// Native remote sessions and the server's web UI both control a server account.
export function serverExecution(): boolean {
  return !!window.tucano?.remoteMode || !!(window as { __TUCANO_WEB__?: boolean }).__TUCANO_WEB__
}

export const hostComputerLabel = (): string => serverExecution() ? L('Servidor conectado', 'Connected server') : L('Este computador', 'This computer')

// Keep the permission target and its reach consistent in setup and the agent page.
// Resolve translations at render time so changing language updates these warnings.
export function hostAccessWarning(): { title: string; detail: string } {
  return serverExecution()
    ? {
        title: L('Os comandos dele vão rodar direto no servidor conectado, com a conta que executa o Tucano.', 'Its commands will run directly on the connected server, as the account running Tucano.'),
        detail: L(
          'Ele pode alcançar os arquivos, projetos, credenciais no disco (tokens, ~/.ssh) e contas de terminal acessíveis a essa conta no servidor. Uma página da web ou um arquivo com instruções escondidas pode tentar usar isso. O alcance é o da conta do servidor, não o da sessão que abriu esta interface.',
          'It can reach files, projects, credentials on disk (tokens, ~/.ssh) and terminal accounts accessible to that server account. A web page or a file with hidden instructions may try to use that. Access follows the server account, not the session used to open this interface.'
        )
      }
    : {
        title: L('Os comandos dele vão rodar direto no seu computador, como você.', 'Its commands will run right on your computer, as you.'),
        detail: L(
          'Ele passa a alcançar seus arquivos, seus outros projetos, as credenciais que estiverem no disco (tokens, ~/.ssh) e as contas em que o terminal está logado. Uma página da web ou um arquivo com instruções escondidas pode tentar usar isso.',
          'It can reach your files, your other projects, credentials on disk (tokens, ~/.ssh) and the accounts the terminal is signed in to. A web page or a file with hidden instructions may try to use that.'
        )
      }
}
