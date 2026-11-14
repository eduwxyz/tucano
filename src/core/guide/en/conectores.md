# Connectors
> Connecting Tucano to your tools (Linear, GitHub, Notion…) over MCP: the store, the custom ones, sign-in, tool classes and errors.

A connector is an MCP server: it gives the agents a service's tools (read issues, send a message, query a database). Agents only use a connector you allowed on their own page, and only at the level you chose.

## Adding from the store
1. Open **Connectors** in the sidebar.
2. Search for the service (**Search connectors**) or pick by category.
3. **Connect**: the login opens in the browser. The access stays on this computer. Some ask first for your instance's address or a token (GitHub, Dynatrace, Snowflake, Metabase), and Azure DevOps and AWS CloudWatch run the official server on your computer (they need Node.js or uv).
4. Give agents access: on each one's page, **Tools** › **Tools and access**.

## Google and Slack
Gmail, Calendar, Drive, Docs and Sheets need your own app in Google Cloud, created once: see **google**. Slack needs an app of yours too, internal to your workspace: see **slack**.

## Composio
Composio connects hundreds of apps with nothing to configure, but your data passes through it and access to your accounts stays with it: see **composio**.

## Custom
**Add custom** for any MCP server, including your company's internal ones:
- **Remote (URL)**: the **MCP server URL** and the **Authentication**: **OAuth** (opens the browser to authorize), **Token** (goes in the Authorization: Bearer header) or **None**.
- **Local (command)**: **Command**, **Arguments** and **Environment variables** (one per line, NAME=value). It runs a process on your computer as your user: only add commands you trust.

MCP servers already configured in Claude Code, Codex and the others show up in a list of their own: **Add** brings each one over, with this side's permissions.

Credentials are encrypted in the system keychain and never show again. Instead of a token or a variable you can put a 1Password reference (`op://Vault/Item/field`): Tucano keeps only the reference and reads the value with the 1Password CLI on each connection. To change a token, **Token (replaces the current one)**.

## A connector's tools
On the connector's page each tool has a **Class**: **reading**, **writing** or **sensitive** (sending something to other people and deleting are sensitive by default; the class you choose stays), and can be marked **High risk** or turned off. New tools the server publishes later arrive turned off until you review them. Sensitive ones always ask for approval (see **aprovacoes**). **Who uses it:** shows the agents with access.

On the agents, the level per connector is **No access**, **Read** (only the reading ones) or **Read and write**.

## States
**connected**, **connecting…**, **needs authorizing**, **did not connect** or **disconnected**. A connector that fails in a reply shows the reason in red on the step, and the agent gets the same reason.

## When it goes wrong
- **needs authorizing**: **Authorize in the browser** and sign in again. An OAuth connector renews by itself between app launches; if the server refuses the renewal, it asks for the login again.
- **did not connect**: **Connect again**. If it continues, check the address and the login. Company network, proxy or antivirus: see **rede**.
- The authorization request expired: close it and click **Connect** again.
- One of the Google ones or Slack not connecting: see **google** or **slack**.
- A tool that does not show: check that it is on on the connector's page and the agent's level; **Refresh tools**.
- **Remove** takes access away from every agent; to have it back, add it again.
