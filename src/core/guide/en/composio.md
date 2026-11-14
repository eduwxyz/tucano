# Composio: hundreds of apps through a third party
> The Composio connector: what it gives, the price in privacy (your data passes through its servers), how to connect and why every action asks for approval.

Composio connects agents to hundreds of apps (Google, Notion, HubSpot, Salesforce…) with nothing to configure: no app in Google Cloud, no token. It lives in the store, under **Business and data**.

## The price: your data passes through Composio
With the other connectors the data goes straight from the service to your computer. With Composio it does not:
- Everything the agents read and send (emails, spreadsheets, documents) passes through its servers.
- Access to your accounts (Google, Notion…) is kept by Composio, not on your computer.
- It records every call, with what was asked and what came back, and says it keeps it for up to 1 year. Tucano has no control over that.

For nothing to pass through a third party, use the direct connectors (for Google, see **google**). The connect window and the connector's page repeat the warning.

## Connecting
1. In **Connectors**, **Connect** on Composio. Read the warning and click **I understand, connect**.
2. The Composio login opens in the browser: sign in or create the account (the free plan has a monthly call limit).
3. Give an agent access, as with any connector.

You connect each app's account as you go: the first time an agent needs Gmail, Composio answers with a login link and the agent shows it to open.

## Tools and approvals
Composio does not show one tool per action. It gives a few that find and run the apps' actions; Tucano judges each call by what it runs:
- **COMPOSIO_SEARCH_TOOLS** and **COMPOSIO_GET_TOOL_SCHEMAS** only look: reading.
- **COMPOSIO_MULTI_EXECUTE_TOOL** runs the actions in its arguments (GMAIL_FETCH_EMAILS, GMAIL_SEND_EMAIL…). Its class is **per call**: it goes by the strongest action. Only reads (search, list, fetch) run on the spot, even for an agent with **Read** only. Writes (creating a draft) need **Read and write**. Sensitive ones (sending, replying, posting, deleting, running code) ask for approval, and the card shows each action. Anything outside the documented format asks too (a read-only agent gets a refusal). The **account** field (when there are two accounts of the same app) counts.
- **COMPOSIO_PROXY_EXECUTE** sends a request straight to an app's API: GET and HEAD read (unless the path says a change, like chat.postMessage); POST, PUT and PATCH write; DELETE asks for approval.
- **COMPOSIO_REMOTE_WORKBENCH** and **COMPOSIO_REMOTE_BASH_TOOL** run code on its servers: they always ask, and a read-only agent does not even see them.
- **COMPOSIO_MANAGE_CONNECTIONS** connects accounts: it asks for approval. Even a **Read**-only agent sees it, and for that one it always asks.

**Approve and always allow** on a MULTI_EXECUTE request applies to each sensitive action in it, on its own (**Approve and always allow GMAIL_REPLY_TO_THREAD**), for that agent, and on an action with an **account**, only for that account; never to the whole executor. A request runs without asking only when every action that would ask is allowed. PROXY_EXECUTE requests, code and calls outside the format are never allowed. To undo: on the agent's page, **Always allowed, without asking:**. **High risk** on the executor requires holding the button and turns always-allow off.

## When it goes wrong
- **needs authorizing**: **Authorize in the browser** and sign in to Composio again.
- The agent sends you a Composio link: it is the login of an app not connected yet. Open it, sign in and ask it to carry on.
- Composio stopped answering mid-month: check your plan's limit at composio.dev.
