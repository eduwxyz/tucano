# Slack
> Connecting Slack: the internal app the person creates from a link, the 2 steps, the admin's approval and what to check when it doesn't connect.

Slack's MCP server only accepts apps from Slack's directory or internal apps of a workspace. So you create your own, internal, once. The first **Connect** on Slack opens **Your Slack app** with the steps:
1. **Create the app in Slack**: the link opens Slack with everything filled in (the name Tucano, the permissions, the return address and MCP turned on). Pick the workspace, **Next** and **Create**.
2. Under **Basic Information › App Credentials**, copy the **Client ID** and the **Client Secret** (**Show**), paste them and click **Save and connect**. The login opens in the browser: **Allow**.

The agents act as you (a user token): they see the channels and conversations you see, and what they send goes out in your name. Every tool still goes through Tucano's classes and approvals: give write access only to whoever needs to send messages.

The login comes back through the workspace's fixed port (the triggers' one, 47717 in the default workspace), which is registered in the app. On a new Tucano workspace the port is another one: create another app from the link there.

To change the app: on the connector's page, **Your Slack app**.

## When it goes wrong
- **Your Slack app is missing**: click **Connect** on Slack and follow the steps.
- Slack says the app needs approval: on a company workspace the admin approves it in **Manage apps**; after that, **Authorize in the browser**.
- "redirect_uri did not match": the app was created from another Tucano workspace's link. Create it again from this one's.
- The login does not come back to Tucano: another program is on the triggers' port (another Tucano open, for instance). Close it and authorize again.
