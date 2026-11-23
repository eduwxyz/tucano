import { L } from './lang'

// Ready-made lines for the agents' computer setup (Debian 12, as root), each tried on the computer's own image.
// `marker` is the comment that opens it in the script: what says it's there already.
export const SETUP_PRESETS = (): { marker: string; label: string; what: string; script: string }[] => [
  {
    marker: '# básicas',
    label: L('Básicas (jq, unzip, ssh, psql)', 'Basics (jq, unzip, ssh, psql)'),
    what: L('jq, unzip, zip, cliente ssh e cliente do Postgres', 'jq, unzip, zip, the ssh client and the Postgres client'),
    script: ['# básicas', 'apt-get update', 'apt-get install -y --no-install-recommends jq unzip zip openssh-client postgresql-client'].join('\n')
  },
  {
    marker: '# gh',
    label: 'GitHub CLI (gh)',
    what: L('O gh, do repositório oficial do GitHub', 'gh, from GitHub’s own repository'),
    script: [
      '# gh',
      'mkdir -p -m 755 /etc/apt/keyrings',
      'curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg',
      'chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg',
      'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list',
      'apt-get update && apt-get install -y gh'
    ].join('\n')
  },
  {
    marker: '# glab',
    label: 'GitLab CLI (glab)',
    what: L('O glab, na versão mais nova publicada pelo GitLab', 'glab, the latest version GitLab published'),
    script: [
      '# glab',
      'command -v jq >/dev/null || (apt-get update && apt-get install -y jq)',
      'v=$(curl -fsSL "https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases?per_page=1" | jq -r ".[0].tag_name" | sed "s/^v//")',
      'curl -fsSL -o /tmp/glab.deb "https://gitlab.com/gitlab-org/cli/-/releases/v${v}/downloads/glab_${v}_linux_$(dpkg --print-architecture).deb"',
      'apt-get install -y /tmp/glab.deb && rm -f /tmp/glab.deb'
    ].join('\n')
  },
  {
    marker: '# databricks',
    label: 'Databricks CLI',
    what: L('O CLI do Databricks, pelo instalador oficial', 'The Databricks CLI, from its official installer'),
    script: ['# databricks', 'command -v unzip >/dev/null || (apt-get update && apt-get install -y unzip)', 'curl -fsSL https://raw.githubusercontent.com/databricks/setup-cli/main/install.sh | sh'].join('\n')
  },
  {
    marker: '# aws',
    label: 'AWS CLI',
    what: L('O AWS CLI v2, pelo instalador oficial', 'AWS CLI v2, from its official installer'),
    script: [
      '# aws',
      'command -v unzip >/dev/null || (apt-get update && apt-get install -y unzip)',
      'curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/aws.zip',
      'unzip -q /tmp/aws.zip -d /tmp && /tmp/aws/install && rm -rf /tmp/aws /tmp/aws.zip'
    ].join('\n')
  }
]
